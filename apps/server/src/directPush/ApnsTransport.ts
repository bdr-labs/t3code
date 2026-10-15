// @effect-diagnostics nodeBuiltinImport:off -- APNs requires HTTP/2, which fetch does not speak here; ES256 signing uses node:crypto.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp2 from "node:http2";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import type { ApnsEnvironment, ApnsRequest } from "./agentActivityDelivery.ts";

const encodePayload = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

export interface ApnsCredentials {
  readonly teamId: string;
  readonly keyId: string;
  /** PKCS#8 PEM of the .p8 key. */
  readonly privateKey: string;
}

export interface ApnsSendInput {
  readonly credentials: ApnsCredentials;
  readonly environment: ApnsEnvironment;
  readonly bundleId: string;
  readonly request: ApnsRequest;
}

export interface ApnsResponse {
  readonly status: number;
  readonly reason: string | null;
  readonly apnsId: string | null;
}

export class ApnsTransportError extends Schema.TaggedError<ApnsTransportError>()(
  "ApnsTransportError",
  {
    environment: Schema.String,
    tokenSuffix: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `APNs request to ${this.environment} failed for token …${this.tokenSuffix}.`;
  }
}

export class ApnsTransport extends Context.Service<
  ApnsTransport,
  {
    readonly send: (input: ApnsSendInput) => Effect.Effect<ApnsResponse, ApnsTransportError>;
  }
>()("t3/directPush/ApnsTransport") {}

const APNS_REQUEST_TIMEOUT_MS = 10_000;
// APNs rejects provider tokens refreshed more often than every ~20 minutes and
// older than 60 minutes; reuse each one for 45 minutes.
const APNS_JWT_REUSE_SECONDS = 45 * 60;

const base64Url = (value: Buffer | string) => Buffer.from(value).toString("base64url");

/** ES256 provider token for token-based APNs authentication. */
export function signApnsJwt(credentials: ApnsCredentials, issuedAtSeconds: number): string {
  const header = base64Url(JSON.stringify({ alg: "ES256", kid: credentials.keyId }));
  const payload = base64Url(JSON.stringify({ iss: credentials.teamId, iat: issuedAtSeconds }));
  const signingInput = `${header}.${payload}`;
  const signature = NodeCrypto.sign("sha256", Buffer.from(signingInput), {
    key: credentials.privateKey.replace(/\\n/g, "\n"),
    dsaEncoding: "ieee-p1363",
  });
  return `${signingInput}.${base64Url(signature)}`;
}

export function apnsOrigin(environment: ApnsEnvironment): string {
  return environment === "production"
    ? "https://api.push.apple.com"
    : "https://api.sandbox.push.apple.com";
}

function reasonFromBody(body: string): string | null {
  if (body.trim().length === 0) return null;
  try {
    const parsed: unknown = JSON.parse(body);
    if (typeof parsed === "object" && parsed !== null && "reason" in parsed) {
      return typeof parsed.reason === "string" ? parsed.reason : body;
    }
  } catch {
    // Not JSON: report the raw body.
  }
  return body;
}

export const make = Effect.gen(function* () {
  const sessions = new Map<string, NodeHttp2.ClientHttp2Session>();
  const tokens = new Map<string, { readonly jwt: string; readonly issuedAt: number }>();

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const session of sessions.values()) session.close();
      sessions.clear();
    }),
  );

  const sessionFor = (origin: string) => {
    const existing = sessions.get(origin);
    if (existing && !existing.closed && !existing.destroyed) return existing;
    const session = NodeHttp2.connect(origin);
    const forget = () => {
      if (sessions.get(origin) === session) sessions.delete(origin);
    };
    session.on("error", forget);
    session.on("close", forget);
    session.on("goaway", forget);
    // Idle connections do not keep the server process alive.
    session.unref();
    sessions.set(origin, session);
    return session;
  };

  const providerToken = (credentials: ApnsCredentials, nowMs: number) => {
    const nowSeconds = Math.floor(nowMs / 1_000);
    const issuedAt = Math.floor(nowSeconds / APNS_JWT_REUSE_SECONDS) * APNS_JWT_REUSE_SECONDS;
    const fingerprint = NodeCrypto.createHash("sha256")
      .update(`${credentials.teamId}:${credentials.keyId}:${credentials.privateKey}`)
      .digest("hex");
    const cached = tokens.get(fingerprint);
    if (cached && cached.issuedAt === issuedAt) return cached.jwt;
    const jwt = signApnsJwt(credentials, issuedAt);
    tokens.set(fingerprint, { jwt, issuedAt });
    return jwt;
  };

  const send: ApnsTransport["Service"]["send"] = (input) =>
    Effect.flatMap(Clock.currentTimeMillis, (nowMs) => sendAt(input, nowMs));

  const sendAt = (input: Parameters<ApnsTransport["Service"]["send"]>[0], nowMs: number) =>
    Effect.callback<ApnsResponse, ApnsTransportError>((resume) => {
      const fail = (cause: unknown) =>
        resume(
          Effect.fail(
            new ApnsTransportError({
              environment: input.environment,
              tokenSuffix: input.request.token.slice(-8),
              cause,
            }),
          ),
        );
      let stream: NodeHttp2.ClientHttp2Stream;
      try {
        const topic =
          input.request.pushType === "liveactivity"
            ? `${input.bundleId}.push-type.liveactivity`
            : input.bundleId;
        stream = sessionFor(apnsOrigin(input.environment)).request({
          ":method": "POST",
          ":path": `/3/device/${input.request.token}`,
          authorization: `bearer ${providerToken(input.credentials, nowMs)}`,
          "apns-push-type": input.request.pushType,
          "apns-priority": input.request.priority,
          "apns-topic": topic,
          "content-type": "application/json",
        });
      } catch (cause) {
        fail(cause);
        return;
      }
      let status = 0;
      let apnsId: string | null = null;
      let body = "";
      stream.setEncoding("utf8");
      stream.setTimeout(APNS_REQUEST_TIMEOUT_MS, () => {
        stream.close(NodeHttp2.constants.NGHTTP2_CANCEL);
        fail(new Error("APNs request timed out."));
      });
      stream.on("response", (headers) => {
        status = Number(headers[":status"] ?? 0);
        const id = headers["apns-id"];
        apnsId = typeof id === "string" ? id : null;
      });
      stream.on("data", (chunk: string) => {
        body += chunk;
      });
      stream.on("error", fail);
      stream.on("end", () =>
        resume(Effect.succeed({ status, reason: reasonFromBody(body), apnsId })),
      );
      stream.end(encodePayload(input.request.payload));
      return Effect.sync(() => {
        if (!stream.closed) stream.close(NodeHttp2.constants.NGHTTP2_CANCEL);
      });
    });

  return ApnsTransport.of({ send });
});

export const layer = Layer.effect(ApnsTransport, make);
