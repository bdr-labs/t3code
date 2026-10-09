import type {
  ProviderConsumeResetCreditOutcome,
  ServerProviderResetCredits,
  ServerProviderUsageLimits,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";
import { claudeOAuthUsageToLimits, type ClaudeScopedLimitNames } from "./claudeUsageLimits.ts";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

const API_BASE = "https://api.anthropic.com";
const PROGRAM = "cedar_ember";
const GRANT_ID = /^[a-z0-9_-]{1,40}$/;
const REQUEST_ID = /^[A-Za-z0-9_-]{1,64}$/;
const COMPLETE_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/;

const Credentials = Schema.Struct({
  claudeAiOauth: Schema.optional(Schema.Struct({ accessToken: Schema.optional(Schema.String) })),
});
const Config = Schema.Struct({
  oauthAccount: Schema.optional(
    Schema.Struct({ organizationUuid: Schema.optional(Schema.String) }),
  ),
});
const Grant = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(GRANT_ID)),
  resets_left: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  ends_at: Schema.optional(Schema.NullOr(Schema.String)),
  paused: Schema.optional(Schema.Boolean),
  usable_now: Schema.optional(Schema.Boolean),
});
const decodeGrant = Schema.decodeUnknownOption(Grant);
const CedarEmber = Schema.Struct({
  eligible: Schema.Boolean,
  grants: Schema.optional(Schema.Array(Schema.Unknown)),
  next_grant_id: Schema.optional(Schema.NullOr(Schema.String)),
});
const UsageResponse = Schema.Struct({
  cedar_ember: Schema.optional(Schema.NullOr(Schema.Unknown)),
});
const decodeCedarEmber = Schema.decodeUnknownOption(CedarEmber);
const ClaimResponse = Schema.Struct({
  result: Schema.Literals([
    "reset",
    "already_used",
    "not_limited",
    "cooldown",
    "ineligible",
    "unavailable",
  ]),
});

const RESET_CREDIT_FAILURES = {
  malformedCredit: "Claude returned a malformed reset credit.",
  loginUnreadable: "Claude could not read its login.",
  accountUnreadable: "Claude could not read its account.",
  signedOut: "Sign in to Claude again to redeem resets.",
  rateLimited: "Claude is rate limiting resets. Try again soon.",
  coolingDown: "Claude resets are cooling down. Try again later.",
  unconfirmed:
    "Claude could not confirm the reset. If you are still limited in a moment, try again.",
  requestFailed: "Claude could not redeem the reset.",
} as const;

class ClaudeResetCreditError extends Schema.TaggedError<ClaudeResetCreditError>()(
  "ClaudeResetCreditError",
  {
    reason: Schema.Literals(
      Object.keys(RESET_CREDIT_FAILURES) as Array<keyof typeof RESET_CREDIT_FAILURES>,
    ),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return RESET_CREDIT_FAILURES[this.reason];
  }
}

const isClaudeResetCreditError = Schema.is(ClaudeResetCreditError);

/** Retry unanswered or unconfirmed claims with the same request ID. */
export const isSettledClaudeResetCreditFailure = (error: unknown) =>
  isClaudeResetCreditError(error) &&
  error.reason !== "requestFailed" &&
  error.reason !== "unconfirmed";

const isFutureTimestamp = (value: string, nowMs: number) => {
  if (!COMPLETE_TIMESTAMP.test(value)) return false;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  return (
    Date.parse(value) > nowMs && Date.UTC(year!, month! - 1, day!) <= Date.UTC(year!, month!, 0)
  );
};

export function claudeResetCreditsToContract(
  block: unknown,
  nowMs: number,
): ServerProviderResetCredits | undefined {
  const parsed = decodeCedarEmber(block);
  if (Option.isNone(parsed) || !parsed.value.eligible) return undefined;
  const live = (parsed.value.grants ?? [])
    .flatMap((raw) => Option.toArray(decodeGrant(raw)))
    .filter(
      (grant) =>
        !grant.paused &&
        grant.usable_now &&
        (grant.ends_at == null || isFutureTimestamp(grant.ends_at, nowMs)),
    );
  const next = live.find((grant) => grant.id === parsed.value.next_grant_id);
  const nextExpiresAt = next?.ends_at ? DateTime.make(next.ends_at) : Option.none();
  return {
    availableCount: next ? live.reduce((sum, grant) => sum + grant.resets_left, 0) : 0,
    ...(Option.isSome(nextExpiresAt)
      ? { nextExpiresAt: DateTime.formatIso(nextExpiresAt.value) }
      : {}),
    ...(next ? { nextCreditId: next.id } : {}),
  };
}

const readJson = Effect.fn("claudeResetCredits.readJson")(function* <S extends Schema.Top>(
  schema: S,
  file: string,
) {
  const fs = yield* FileSystem.FileSystem;
  return yield* fs.readFileString(file).pipe(
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed("{}") : Effect.fail(error),
    }),
    Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(schema))),
  );
});

const readAccessToken = Effect.fn("claudeResetCredits.readAccessToken")(function* (
  configDir: string,
) {
  if ((yield* HostProcess.Platform) === "darwin") return undefined;
  const path = yield* Path.Path;
  const credentials = yield* readJson(Credentials, path.join(configDir, ".credentials.json"));
  return credentials.claudeAiOauth?.accessToken?.trim() || undefined;
});

const withClaudeHeaders = (token: string, version: string) =>
  HttpClientRequest.setHeaders({
    authorization: `Bearer ${token}`,
    "anthropic-beta": "oauth-2025-04-20",
    "user-agent": `claude-cli/${version} (external, cli)`,
  });

export const readClaudeResetCredits = Effect.fn("readClaudeResetCredits")(
  function* (configDir: string, version: string) {
    const token = yield* readAccessToken(configDir);
    if (!token) return undefined;
    const client = yield* HttpClient.HttpClient;
    const response = yield* client.execute(
      HttpClientRequest.get(`${API_BASE}/api/oauth/usage`, {
        urlParams: { cedar_ember: "1", skip_spend: "1" },
      }).pipe(withClaudeHeaders(token, version)),
    );
    const body = yield* HttpClientResponse.schemaBodyJson(UsageResponse)(
      yield* HttpClientResponse.filterStatusOk(response),
    );
    return claudeResetCreditsToContract(
      body.cedar_ember,
      DateTime.toEpochMillis(yield* DateTime.now),
    );
  },
  Effect.timeout("10 seconds"),
  Effect.orElseSucceed(() => undefined),
);

/**
 * The endpoint allows each login about one request a minute, so other local
 * readers of the same login (the desktop usage panel) would otherwise lose to
 * this poller. Each good reading is kept here, one file per config directory,
 * for them to use instead of asking again.
 */
export const claudeUsageShareDirectory = Effect.fn("claudeUsageShareDirectory")(function* () {
  const env = yield* HostProcess.Environment;
  return env.XDG_CACHE_HOME?.startsWith("/")
    ? `${env.XDG_CACHE_HOME}/claude-usage`
    : `${yield* HostProcess.HomeDirectory}/.cache/claude-usage`;
});

const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

const shareUsageJson = (directory: string, configDir: string, suffix: string, value: unknown) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const name = path
        .resolve(configDir)
        .replace(/^\/+/, "")
        .replace(/[^A-Za-z0-9._-]+/g, "-");
      yield* fs.makeDirectory(directory, { recursive: true });
      const tempPath = yield* fs.makeTempFileScoped({ directory, prefix: ".usage-" });
      yield* fs.chmod(tempPath, 0o600);
      yield* fs.writeFileString(tempPath, yield* encodeJson(value));
      yield* fs.rename(tempPath, path.join(directory, `${name}${suffix}.json`));
    }),
  );

const shareUsageReading = (
  directory: string,
  configDir: string,
  fetchedAtMs: number,
  usage: unknown,
) => shareUsageJson(directory, configDir, "", { configDir, fetchedAtMs, usage });

/** A limits-only reader for one config directory; failures never manufacture a fetch time. */
export const makeClaudeUsageLimitsReader = Effect.fn("makeClaudeUsageLimitsReader")(function* (
  configDir: string,
  names: Ref.Ref<ClaudeScopedLimitNames>,
  shareDirectory?: string,
) {
  const client = yield* HttpClient.HttpClient;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const semaphore = yield* Semaphore.make(1);
  let retryAt = 0;
  let consecutive429s = 0;
  let lastAttemptAt: number | undefined;
  let lastResult: ServerProviderUsageLimits | undefined;
  return (version: string) =>
    semaphore.withPermits(1)(
      Effect.gen(function* () {
        const nowMs = DateTime.toEpochMillis(yield* DateTime.now);
        if (lastAttemptAt !== undefined && nowMs < lastAttemptAt + 55_000) return lastResult;
        if (nowMs < retryAt) return undefined;
        let attemptedAtMs: number | undefined;
        let status: "ok" | "rate_limited" | "error" = "error";
        const result = yield* Effect.gen(function* () {
          const token = yield* readAccessToken(configDir).pipe(
            Effect.provideService(FileSystem.FileSystem, fs),
            Effect.provideService(Path.Path, path),
            Effect.provideService(HostProcess.Platform, platform),
          );
          if (!token) return undefined;
          attemptedAtMs = DateTime.toEpochMillis(yield* DateTime.now);
          lastAttemptAt = attemptedAtMs;
          lastResult = undefined;
          const response = yield* client.execute(
            HttpClientRequest.get(`${API_BASE}/api/oauth/usage`, {
              urlParams: { cedar_ember: "1", skip_spend: "1" },
            }).pipe(withClaudeHeaders(token, version)),
          );
          if (response.status === 429) {
            const receivedAt = DateTime.toEpochMillis(yield* DateTime.now);
            const value = response.headers["retry-after"];
            const seconds = value?.trim() ? Number(value) : NaN;
            const delay =
              Number.isFinite(seconds) && seconds >= 0
                ? seconds * 1000
                : Date.parse(value ?? "") - receivedAt;
            consecutive429s++;
            retryAt =
              receivedAt +
              (Number.isFinite(delay) && delay > 0
                ? delay
                : Math.min(60_000 * 2 ** consecutive429s, 600_000));
            status = "rate_limited";
            return undefined;
          }
          const body = yield* HttpClientResponse.schemaBodyJson(Schema.Unknown)(
            yield* HttpClientResponse.filterStatusOk(response),
          );
          const fetchedAt = yield* DateTime.now;
          const limits = claudeOAuthUsageToLimits({
            response: body,
            checkedAt: DateTime.formatIso(fetchedAt),
            names: yield* Ref.get(names),
          });
          if (!limits) return undefined;
          consecutive429s = 0;
          retryAt = 0;
          status = "ok";
          if (shareDirectory) {
            yield* shareUsageReading(
              shareDirectory,
              configDir,
              DateTime.toEpochMillis(fetchedAt),
              body,
            ).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
              Effect.orElseSucceed(() => undefined),
            );
          }
          const resetCredits = claudeResetCreditsToContract(
            (body as Record<string, unknown>).cedar_ember,
            DateTime.toEpochMillis(fetchedAt),
          );
          return { ...limits, ...(resetCredits ? { resetCredits } : {}) };
        }).pipe(
          Effect.timeout("10 seconds"),
          Effect.orElseSucceed(() => undefined),
        );
        if (attemptedAtMs !== undefined) {
          lastResult = result;
          if (shareDirectory) {
            yield* shareUsageJson(shareDirectory, configDir, ".poll", {
              configDir,
              attemptedAtMs,
              status,
              nextAttemptAtMs: Math.max(attemptedAtMs + 55_000, retryAt),
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, fs),
              Effect.provideService(Path.Path, path),
              Effect.orElseSucceed(() => undefined),
            );
          }
        }
        return result;
      }).pipe(Effect.orElseSucceed(() => undefined)),
    );
});

export const readClaudeOrganizationId = (accountConfigPath: string) =>
  readJson(Config, accountConfigPath).pipe(
    Effect.map((config) => config.oauthAccount?.organizationUuid?.trim() || undefined),
    Effect.orElseSucceed(() => undefined),
  );

export const claudeAccountConfigPath = Effect.fn("claudeAccountConfigPath")(function* (
  configDir: string | undefined,
) {
  const path = yield* Path.Path;
  return configDir
    ? path.join(configDir, ".claude.json")
    : path.join(yield* HostProcess.HomeDirectory, ".claude.json");
});

const CLAIM_OUTCOMES = {
  reset: "reset",
  not_limited: "nothingToReset",
  already_used: "alreadyRedeemed",
  ineligible: "noCredit",
} as const satisfies Record<string, ProviderConsumeResetCreditOutcome>;

/** requestId is the claim's idempotency key. */
export const consumeClaudeResetCredit = Effect.fn("consumeClaudeResetCredit")(function* (input: {
  readonly configDir: string;
  readonly accountConfigPath: string;
  readonly version: string;
  readonly grantId: string;
  readonly requestId: string;
}) {
  if (!GRANT_ID.test(input.grantId) || !REQUEST_ID.test(input.requestId)) {
    return yield* new ClaudeResetCreditError({ reason: "malformedCredit" });
  }
  const token = yield* readAccessToken(input.configDir).pipe(
    Effect.mapError((cause) => new ClaudeResetCreditError({ reason: "loginUnreadable", cause })),
  );
  const config = yield* readJson(Config, input.accountConfigPath).pipe(
    Effect.mapError((cause) => new ClaudeResetCreditError({ reason: "accountUnreadable", cause })),
  );
  const organization = config.oauthAccount?.organizationUuid?.trim();
  if (!token || !organization) {
    return yield* new ClaudeResetCreditError({ reason: "signedOut" });
  }
  const client = yield* HttpClient.HttpClient;
  const response = yield* client
    .execute(
      HttpClientRequest.post(
        new URL(
          `/api/organizations/${encodeURIComponent(organization)}/reset_rate_limits`,
          API_BASE,
        ),
      ).pipe(
        withClaudeHeaders(token, input.version),
        HttpClientRequest.bodyJsonUnsafe({
          program: PROGRAM,
          grant_id: input.grantId,
          request_id: input.requestId,
        }),
      ),
    )
    .pipe(
      Effect.timeout("25 seconds"),
      Effect.mapError((cause) => new ClaudeResetCreditError({ reason: "requestFailed", cause })),
    );
  if (response.status === 429) {
    return yield* new ClaudeResetCreditError({ reason: "rateLimited" });
  }
  if (response.status === 401 || response.status === 403) {
    return yield* new ClaudeResetCreditError({ reason: "signedOut" });
  }
  const body = yield* HttpClientResponse.filterStatusOk(response).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(ClaimResponse)),
    Effect.timeout("25 seconds"),
    Effect.mapError((cause) => new ClaudeResetCreditError({ reason: "requestFailed", cause })),
  );
  if (body.result === "cooldown") {
    return yield* new ClaudeResetCreditError({ reason: "coolingDown" });
  }
  // Unknown outcomes retain the request ID so retries address the same claim.
  if (body.result === "unavailable") {
    return yield* new ClaudeResetCreditError({ reason: "unconfirmed" });
  }
  return CLAIM_OUTCOMES[body.result];
});
