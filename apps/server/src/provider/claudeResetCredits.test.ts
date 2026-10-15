import * as NodeServices from "@effect/platform-node/NodeServices";
import { it as effectIt } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Deferred from "effect/Deferred";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { HttpClient, HttpClientResponse, UrlParams } from "effect/http";
import { describe, expect, it } from "vite-plus/test";

import * as ClaudeResetCredits from "./claudeResetCredits.ts";
import { makeManagedServerProvider } from "@t3tools/provider-core/server/managedProvider";
import { ProviderHost } from "@t3tools/provider-core/server/ProviderHost";

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

const httpDate = (ms: number) => DateTime.toDateUtc(DateTime.makeUnsafe(ms)).toUTCString();

const NOW = Date.parse("2026-09-22T12:00:00.000Z");
// Windows reports read/write bits for every class; POSIX enforces owner-only mode.
const privateFileMode = HostProcess.Platform.pipe(
  Effect.map((platform) => (platform === "win32" ? 0o666 : 0o600)),
);
const grant = (overrides: Record<string, unknown>) => ({
  id: "grant_a",
  resets_left: 1,
  usable_now: true,
  ...overrides,
});

const writeLogin = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped();
  yield* fs.writeFileString(
    path.join(directory, ".credentials.json"),
    '{"claudeAiOauth":{"accessToken":"oauth-token"}}',
  );
  const accountConfigPath = path.join(directory, ".claude.json");
  yield* fs.writeFileString(accountConfigPath, '{"oauthAccount":{"organizationUuid":"org-1"}}');
  return { configDir: directory, accountConfigPath };
});

const respond = (status: number, body: unknown) =>
  HttpClient.make((request) =>
    Effect.succeed(HttpClientResponse.fromWeb(request, Response.json(body, { status }))),
  );
const refuseRequests = HttpClient.make(() => Effect.die("must not send a request"));

describe("claudeResetCreditsToContract", () => {
  it("counts live grants and pins the next usable one", () => {
    expect(
      ClaudeResetCredits.claudeResetCreditsToContract(
        {
          eligible: true,
          next_grant_id: "grant_a",
          grants: [
            grant({ resets_left: 2, ends_at: "2026-10-01T00:00:00Z" }),
            grant({ id: "paused", paused: true }),
            grant({ id: "expired", ends_at: "2026-09-01T00:00:00Z" }),
            grant({ id: "garbled", ends_at: "not a date" }),
            grant({ id: "date_only", ends_at: "2026-10-01" }),
            grant({ id: "impossible", ends_at: "2027-02-30T00:00:00Z" }),
            grant({ id: "empty", ends_at: "" }),
            grant({ id: "Not Valid" }),
            grant({ id: "grant_b", resets_left: 3, usable_now: false }),
          ],
        },
        NOW,
      ),
    ).toEqual({
      availableCount: 2,
      nextCreditId: "grant_a",
      nextExpiresAt: "2026-10-01T00:00:00.000Z",
    });
  });

  it("offers nothing to redeem without a usable next grant or an eligible account", () => {
    expect(
      ClaudeResetCredits.claudeResetCreditsToContract(
        { eligible: true, next_grant_id: "grant_a", grants: [grant({ usable_now: false })] },
        NOW,
      ),
    ).toEqual({ availableCount: 0 });
    expect(
      ClaudeResetCredits.claudeResetCreditsToContract({ eligible: true, grants: [grant({})] }, NOW),
    ).toEqual({
      availableCount: 0,
    });
    expect(
      ClaudeResetCredits.claudeResetCreditsToContract(
        { eligible: false, grants: [grant({})] },
        NOW,
      ),
    ).toBeUndefined();
    expect(ClaudeResetCredits.claudeResetCreditsToContract(undefined, NOW)).toBeUndefined();
  });
});

effectIt.layer(NodeServices.layer)("readClaudeResetCredits", (it) => {
  it.effect("reads the grants with the CLI's request", () =>
    Effect.gen(function* () {
      const { configDir } = yield* writeLogin;
      const client = HttpClient.make((request) => {
        expect(request.method).toBe("GET");
        expect(request.url).toBe("https://api.anthropic.com/api/oauth/usage");
        expect(UrlParams.toString(request.urlParams)).toBe("cedar_ember=1&skip_spend=1");
        expect(request.headers.authorization).toBe("Bearer oauth-token");
        expect(request.headers["anthropic-beta"]).toBe("oauth-2025-04-20");
        expect(request.headers["user-agent"]).toBe("claude-cli/2.1.0 (external, cli)");
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              cedar_ember: { eligible: true, next_grant_id: "grant_a", grants: [grant({})] },
            }),
          ),
        );
      });
      const credits = yield* ClaudeResetCredits.readClaudeResetCredits(configDir, "2.1.0").pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HttpClient.HttpClient, client),
      );
      expect(credits).toEqual({ availableCount: 1, nextCreditId: "grant_a" });
    }),
  );

  it.effect("reads nothing from keychain logins or failed requests", () =>
    Effect.gen(function* () {
      const { configDir } = yield* writeLogin;
      const darwin = yield* ClaudeResetCredits.readClaudeResetCredits(configDir, "2.1.0").pipe(
        Effect.provideService(HostProcess.Platform, "darwin"),
        Effect.provideService(HttpClient.HttpClient, refuseRequests),
      );
      const limited = yield* ClaudeResetCredits.readClaudeResetCredits(configDir, "2.1.0").pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HttpClient.HttpClient, respond(429, {})),
      );
      expect([darwin, limited]).toEqual([undefined, undefined]);
    }),
  );
});

const ClaimBody = Schema.fromJsonString(
  Schema.Struct({ program: Schema.String, grant_id: Schema.String, request_id: Schema.String }),
);
const decodeClaimBody = Schema.decodeEffect(ClaimBody);

const consume = (client: HttpClient.HttpClient, ids = { grantId: "grant_a", requestId: "r-1" }) =>
  Effect.gen(function* () {
    const login = yield* writeLogin;
    return yield* ClaudeResetCredits.consumeClaudeResetCredit({
      ...login,
      version: "2.1.0",
      ...ids,
    }).pipe(
      Effect.provideService(HostProcess.Platform, "linux"),
      Effect.provideService(HttpClient.HttpClient, client),
      Effect.result,
    );
  });

effectIt.layer(NodeServices.layer)("consumeClaudeResetCredit", (it) => {
  it.effect("claims the grant for the organization", () =>
    Effect.gen(function* () {
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          expect(request.method).toBe("POST");
          expect(request.url).toBe(
            "https://api.anthropic.com/api/organizations/org-1/reset_rate_limits",
          );
          expect(request.headers.authorization).toBe("Bearer oauth-token");
          const body =
            request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
          expect(yield* decodeClaimBody(body)).toEqual({
            program: "cedar_ember",
            grant_id: "grant_a",
            request_id: "r-1",
          });
          return HttpClientResponse.fromWeb(request, Response.json({ result: "reset" }));
        }).pipe(Effect.orDie),
      );
      expect(yield* consume(client)).toMatchObject({ _tag: "Success", success: "reset" });
    }),
  );

  it.effect("maps each answer to an outcome or a failure", () =>
    Effect.gen(function* () {
      for (const [result, outcome] of [
        ["not_limited", "nothingToReset"],
        ["already_used", "alreadyRedeemed"],
        ["ineligible", "noCredit"],
      ] as const) {
        expect(yield* consume(respond(200, { result }))).toMatchObject({ success: outcome });
      }
      for (const client of [
        respond(200, { result: "cooldown" }),
        respond(429, {}),
        respond(401, {}),
      ]) {
        const result = yield* consume(client);
        expect(result).toMatchObject({ _tag: "Failure" });
        if (result._tag === "Failure") {
          expect(ClaudeResetCredits.isSettledClaudeResetCreditFailure(result.failure)).toBe(true);
        }
      }
      for (const client of [respond(500, {}), respond(200, { result: "unavailable" })]) {
        const unanswered = yield* consume(client);
        expect(unanswered).toMatchObject({ _tag: "Failure" });
        if (unanswered._tag === "Failure") {
          expect(ClaudeResetCredits.isSettledClaudeResetCreditFailure(unanswered.failure)).toBe(
            false,
          );
        }
      }
    }),
  );

  it.effect("refuses malformed ids without sending anything", () =>
    Effect.gen(function* () {
      for (const ids of [
        { grantId: "Bad Grant", requestId: "r-1" },
        { grantId: "grant_a", requestId: "has space" },
      ]) {
        expect(yield* consume(refuseRequests, ids)).toMatchObject({ _tag: "Failure" });
      }
    }),
  );
});

effectIt.layer(NodeServices.layer)("Claude limits-only OAuth reader", (it) => {
  it.effect("shares usage under the host cache directory or host home", () =>
    Effect.gen(function* () {
      for (const [env, expected] of [
        [{ XDG_CACHE_HOME: "/host/cache" }, "/host/cache/claude-usage"],
        [{ XDG_CACHE_HOME: "relative/cache" }, "/host/home/.cache/claude-usage"],
        [{}, "/host/home/.cache/claude-usage"],
      ] as const) {
        const directory = yield* ClaudeResetCredits.claudeUsageShareDirectory().pipe(
          Effect.provideService(HostProcess.Environment, env),
          Effect.provideService(HostProcess.HomeDirectory, "/host/home"),
        );
        expect(directory).toBe(expected);
      }
    }),
  );

  it.effect("keeps polling after a startup 429 without foreground demand and after success", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { configDir } = yield* writeLogin;
      const shareDirectory = yield* fs.makeTempDirectoryScoped();
      const name = path
        .resolve(configDir)
        .replace(/^\/+/, "")
        .replace(/[^A-Za-z0-9._-]+/g, "-");
      const poll = path.join(shareDirectory, `${name}.poll.json`);
      const reading = path.join(shareDirectory, `${name}.json`);
      const names = yield* Ref.make({ overageIncluded: undefined as string | undefined });
      const ticks = yield* Queue.unbounded<void>();
      const startupDone = yield* Deferred.make<void>();
      let loopCalls = 0;
      const attempts: number[] = [];
      const client = HttpClient.make((request) =>
        Effect.gen(function* () {
          attempts.push(DateTime.toEpochMillis(yield* DateTime.now));
          return HttpClientResponse.fromWeb(
            request,
            attempts.length === 1
              ? Response.json({}, { status: 429 })
              : Response.json({ five_hour: { utilization: attempts.length, resets_at: null } }),
          );
        }),
      );
      const reader = yield* ClaudeResetCredits.makeClaudeUsageLimitsReader(
        configDir,
        names,
        shareDirectory,
      ).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HttpClient.HttpClient, client),
      );
      const snapshot: ServerProvider = {
        instanceId: ProviderInstanceId.make("claude"),
        driver: ProviderDriverKind.make("claudeAgent"),
        enabled: true,
        installed: true,
        version: "2.1.0",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "1970-01-01T00:00:00.000Z",
        models: [],
        slashCommands: [],
        skills: [],
      };
      const epoch = DateTime.toEpochMillis(yield* DateTime.now);
      const provider = yield* makeManagedServerProvider({
        resolveMaintenance: () => Effect.die("maintenance is not part of usage polling"),
        getSettings: Effect.succeed({ enabled: true }),
        streamSettings: Stream.empty,
        haveSettingsChanged: () => false,
        initialSnapshot: () => Effect.succeed(snapshot),
        checkProvider: reader("2.1.0").pipe(
          Effect.andThen(Deferred.succeed(startupDone, undefined)),
          Effect.as(snapshot),
        ),
        pollUsageLimits: () =>
          Effect.gen(function* () {
            loopCalls++;
            const limits = yield* reader("2.1.0");
            yield* Queue.offer(ticks, undefined);
            return limits;
          }),
        refreshInterval: "1 hour",
      }).pipe(
        Effect.provide(
          Layer.succeed(
            ProviderHost,
            ProviderHost.of({
              paths: {
                cwd: process.cwd(),
                baseDir: "/t3",
                stateDir: "/t3/userdata",
                providerStatusCacheDir: "/t3/caches",
                attachmentsDir: "/t3/userdata/attachments",
              },
              settings: {
                get: Effect.succeed(DEFAULT_SERVER_SETTINGS),
                withSnapshot: (use) => use(DEFAULT_SERVER_SETTINGS),
                changes: Stream.empty,
                subscribe: Effect.succeed(Stream.empty),
              },
              shouldRunBackgroundWork: () => Effect.succeed(false),
              resolveAttachmentPath: () => null,
              credentials: () => Effect.die("usage polling must not access credential storage"),
            }),
          ),
        ),
      );
      yield* Deferred.await(startupDone);
      yield* TestClock.adjust("59 seconds");
      expect(loopCalls).toBe(1);
      yield* Queue.take(ticks);
      const firstPoll = yield* fs.readFileString(poll);
      expect(yield* decodeJson(firstPoll)).toMatchObject({
        attemptedAtMs: epoch,
        status: "rate_limited",
        nextAttemptAtMs: epoch + 120_000,
      });
      yield* TestClock.adjust("1 second");
      yield* Queue.take(ticks);
      expect(loopCalls).toBe(2);
      expect(attempts).toEqual([epoch]);
      expect(yield* fs.readFileString(poll)).toBe(firstPoll);
      expect(yield* fs.exists(reading)).toBe(false);
      for (const seconds of [120, 180, 240]) {
        yield* TestClock.adjust("1 minute");
        yield* Queue.take(ticks);
        expect(yield* decodeJson(yield* fs.readFileString(poll))).toMatchObject({
          attemptedAtMs: epoch + seconds * 1000,
          status: "ok",
          nextAttemptAtMs: epoch + seconds * 1000 + 55_000,
        });
        expect(yield* decodeJson(yield* fs.readFileString(reading))).toMatchObject({
          fetchedAtMs: epoch + seconds * 1000,
        });
      }
      expect(loopCalls).toBe(5);
      expect(attempts).toEqual([epoch, epoch + 120_000, epoch + 180_000, epoch + 240_000]);
      expect((yield* provider.getSnapshot).usageLimits?.windows[0]?.usedPercent).toBe(4);
    }),
  );

  it.effect("reads each instance's credentials and preserves the percentage scale", () =>
    Effect.gen(function* () {
      const { configDir } = yield* writeLogin;
      const names = yield* Ref.make({ overageIncluded: undefined as string | undefined });
      let calls = 0;
      const client = HttpClient.make((request) => {
        calls++;
        expect(request.headers.authorization).toBe("Bearer oauth-token");
        expect(UrlParams.toString(request.urlParams)).toBe("cedar_ember=1&skip_spend=1");
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              five_hour: { utilization: 60, resets_at: null },
              seven_day: { utilization: 12, resets_at: null },
              cedar_ember: { eligible: true, next_grant_id: "grant_a", grants: [grant({})] },
            }),
          ),
        );
      });
      const reader = yield* ClaudeResetCredits.makeClaudeUsageLimitsReader(configDir, names).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HttpClient.HttpClient, client),
      );
      const limits = yield* reader("2.1.0");
      expect(calls).toBe(1);
      expect(limits?.windows.map((window) => window.usedPercent)).toEqual([60, 12]);
      expect(limits?.windows[0]?.checkedAt).toBe(limits?.checkedAt);
      expect(limits?.resetCredits?.availableCount).toBe(1);
    }),
  );

  it.effect("keeps distinct config directories on their own accounts", () =>
    Effect.gen(function* () {
      const first = yield* writeLogin;
      const second = yield* writeLogin;
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      yield* fs.writeFileString(
        path.join(second.configDir, ".credentials.json"),
        '{"claudeAiOauth":{"accessToken":"second-token"}}',
      );
      const names = yield* Ref.make({ overageIncluded: undefined as string | undefined });
      const tokens: string[] = [];
      const client = HttpClient.make((request) => {
        tokens.push(request.headers.authorization!);
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              five_hour: { utilization: tokens.length * 10, resets_at: null },
            }),
          ),
        );
      });
      const reads = [];
      for (const { configDir } of [first, second]) {
        const reader = yield* ClaudeResetCredits.makeClaudeUsageLimitsReader(configDir, names).pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HttpClient.HttpClient, client),
        );
        reads.push(yield* reader("2.1.0"));
      }
      expect(tokens).toEqual(["Bearer oauth-token", "Bearer second-token"]);
      expect(reads.map((limits) => limits?.windows[0]?.usedPercent)).toEqual([10, 20]);
    }),
  );

  it.effect("reuses concurrent and recent readings until 55 seconds", () =>
    Effect.gen(function* () {
      const { configDir } = yield* writeLogin;
      const names = yield* Ref.make({ overageIncluded: undefined as string | undefined });
      let calls = 0;
      const client = HttpClient.make((request) => {
        calls++;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            Response.json({
              five_hour: { utilization: calls, resets_at: null },
            }),
          ),
        );
      });
      const reader = yield* ClaudeResetCredits.makeClaudeUsageLimitsReader(configDir, names).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HttpClient.HttpClient, client),
      );
      const [first, second] = yield* Effect.all([reader("2.1.0"), reader("2.1.0")], {
        concurrency: "unbounded",
      });
      expect(first).toBeDefined();
      expect(second).toBe(first);
      yield* TestClock.adjust("54 seconds");
      expect(yield* reader("2.1.0")).toBe(first);
      expect(calls).toBe(1);
      yield* TestClock.adjust("1 second");
      expect((yield* reader("2.1.0"))?.windows[0]?.usedPercent).toBe(2);
      expect(calls).toBe(2);
    }),
  );

  it.effect("backs off zero Retry-After for 2 then 4 minutes and resets after success", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { configDir } = yield* writeLogin;
      const shareDirectory = yield* fs.makeTempDirectoryScoped();
      const name = path
        .resolve(configDir)
        .replace(/^\/+/, "")
        .replace(/[^A-Za-z0-9._-]+/g, "-");
      const reading = path.join(shareDirectory, `${name}.json`);
      const poll = path.join(shareDirectory, `${name}.poll.json`);
      const names = yield* Ref.make({ overageIncluded: undefined as string | undefined });
      let calls = 0;
      const client = HttpClient.make((request) => {
        calls++;
        return Effect.succeed(
          HttpClientResponse.fromWeb(
            request,
            calls === 3
              ? Response.json({ five_hour: { utilization: 14, resets_at: null } })
              : Response.json({}, { status: 429, headers: { "retry-after": "0" } }),
          ),
        );
      });
      const reader = yield* ClaudeResetCredits.makeClaudeUsageLimitsReader(
        configDir,
        names,
        shareDirectory,
      ).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HttpClient.HttpClient, client),
      );
      for (const [expectedCalls, delay] of [
        [1, 120_000],
        [2, 240_000],
      ] as const) {
        const attemptedAtMs = DateTime.toEpochMillis(yield* DateTime.now);
        expect(yield* reader("2.1.0")).toBeUndefined();
        expect(yield* decodeJson(yield* fs.readFileString(poll))).toEqual({
          configDir,
          attemptedAtMs,
          status: "rate_limited",
          nextAttemptAtMs: attemptedAtMs + delay,
        });
        expect((yield* fs.stat(poll)).mode & 0o777).toBe(yield* privateFileMode);
        expect(yield* fs.exists(reading)).toBe(false);
        yield* TestClock.adjust(delay - 1);
        expect(yield* reader("2.1.0")).toBeUndefined();
        expect(calls).toBe(expectedCalls);
        yield* TestClock.adjust(1);
      }
      expect(yield* reader("2.1.0")).toBeDefined();
      const goodReading = yield* fs.readFileString(reading);
      yield* TestClock.adjust("55 seconds");
      const attemptedAtMs = DateTime.toEpochMillis(yield* DateTime.now);
      expect(yield* reader("2.1.0")).toBeUndefined();
      expect(yield* decodeJson(yield* fs.readFileString(poll))).toEqual({
        configDir,
        attemptedAtMs,
        status: "rate_limited",
        nextAttemptAtMs: attemptedAtMs + 120_000,
      });
      expect(yield* fs.readFileString(reading)).toBe(goodReading);
      yield* TestClock.adjust(119_999);
      expect(yield* reader("2.1.0")).toBeUndefined();
      expect(calls).toBe(4);
      yield* TestClock.adjust(1);
      yield* reader("2.1.0");
      expect(calls).toBe(5);
    }),
  );

  it.effect("honors positive numeric and date Retry-After and backs off invalid delays", () =>
    Effect.gen(function* () {
      const { configDir } = yield* writeLogin;
      const names = yield* Ref.make({ overageIncluded: undefined as string | undefined });
      for (const header of ["30", "120", "date", "invalid", "0", undefined]) {
        let calls = 0;
        const now = DateTime.toEpochMillis(yield* DateTime.now);
        const value = header === "date" ? httpDate(now + 120_000) : header;
        const client = HttpClient.make((request) => {
          calls++;
          return Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              Response.json(
                {},
                {
                  status: 429,
                  headers: value ? { "retry-after": value } : {},
                },
              ),
            ),
          );
        });
        const reader = yield* ClaudeResetCredits.makeClaudeUsageLimitsReader(configDir, names).pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HttpClient.HttpClient, client),
        );
        expect(yield* reader("2.1.0")).toBeUndefined();
        yield* TestClock.adjust(header === "30" ? 54_999 : 119_999);
        expect(yield* reader("2.1.0")).toBeUndefined();
        expect(calls).toBe(1);
        yield* TestClock.adjust(1);
        yield* reader("2.1.0");
        expect(calls).toBe(2);
      }
    }),
  );

  it.effect("spaces failed HTTP requests and shares their error status", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { configDir } = yield* writeLogin;
      const shareDirectory = yield* fs.makeTempDirectoryScoped();
      const names = yield* Ref.make({ overageIncluded: undefined as string | undefined });
      let calls = 0;
      const client = HttpClient.make((request) => {
        calls++;
        return Effect.succeed(
          HttpClientResponse.fromWeb(request, Response.json({}, { status: 500 })),
        );
      });
      const reader = yield* ClaudeResetCredits.makeClaudeUsageLimitsReader(
        configDir,
        names,
        shareDirectory,
      ).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HttpClient.HttpClient, client),
      );
      const attemptedAtMs = DateTime.toEpochMillis(yield* DateTime.now);
      expect(yield* reader("2.1.0")).toBeUndefined();
      const files = yield* fs.readDirectory(shareDirectory);
      expect(files).toHaveLength(1);
      expect(files[0]).toMatch(/\.poll\.json$/);
      expect(
        yield* decodeJson(yield* fs.readFileString(path.join(shareDirectory, files[0]!))),
      ).toEqual({
        configDir,
        attemptedAtMs,
        status: "error",
        nextAttemptAtMs: attemptedAtMs + 55_000,
      });
      yield* TestClock.adjust(54_999);
      expect(yield* reader("2.1.0")).toBeUndefined();
      expect(calls).toBe(1);
      yield* TestClock.adjust(1);
      yield* reader("2.1.0");
      expect(calls).toBe(2);
    }),
  );

  it.effect("spaces timed-out attempts and writes their poll status", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { configDir } = yield* writeLogin;
      const shareDirectory = yield* fs.makeTempDirectoryScoped();
      const names = yield* Ref.make({ overageIncluded: undefined as string | undefined });
      const sent = yield* Deferred.make<void>();
      let calls = 0;
      const client = HttpClient.make(() => {
        calls++;
        return Deferred.succeed(sent, undefined).pipe(Effect.andThen(Effect.never));
      });
      const reader = yield* ClaudeResetCredits.makeClaudeUsageLimitsReader(
        configDir,
        names,
        shareDirectory,
      ).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HttpClient.HttpClient, client),
      );
      const attemptedAtMs = DateTime.toEpochMillis(yield* DateTime.now);
      const pending = yield* reader("2.1.0").pipe(Effect.forkChild);
      yield* Deferred.await(sent);
      yield* TestClock.adjust("10 seconds");
      expect(yield* Fiber.join(pending)).toBeUndefined();
      const files = yield* fs.readDirectory(shareDirectory);
      expect(files).toHaveLength(1);
      expect(
        yield* decodeJson(yield* fs.readFileString(path.join(shareDirectory, files[0]!))),
      ).toEqual({
        configDir,
        attemptedAtMs,
        status: "error",
        nextAttemptAtMs: attemptedAtMs + 55_000,
      });
      yield* TestClock.adjust("44 seconds");
      expect(yield* reader("2.1.0")).toBeUndefined();
      expect(calls).toBe(1);
    }),
  );

  it.effect("shares each good reading for other local readers of the login", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const { configDir } = yield* writeLogin;
      const shareDirectory = path.join(yield* fs.makeTempDirectoryScoped(), "claude-usage");
      const names = yield* Ref.make({ overageIncluded: undefined as string | undefined });
      const shared = path.join(
        shareDirectory,
        `${configDir.replace(/^\/+/, "").replace(/[^A-Za-z0-9._-]+/g, "-")}.json`,
      );
      const failing = yield* ClaudeResetCredits.makeClaudeUsageLimitsReader(
        configDir,
        names,
        shareDirectory,
      ).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HttpClient.HttpClient, respond(500, {})),
      );
      yield* failing("2.1.0");
      expect(yield* fs.exists(shared)).toBe(false);

      const usage = { five_hour: { utilization: 14, resets_at: null } };
      const reader = yield* ClaudeResetCredits.makeClaudeUsageLimitsReader(
        configDir,
        names,
        shareDirectory,
      ).pipe(
        Effect.provideService(HostProcess.Platform, "linux"),
        Effect.provideService(HttpClient.HttpClient, respond(200, usage)),
      );
      const limits = yield* reader("2.1.0");
      const reading = yield* decodeJson(yield* fs.readFileString(shared));
      expect(reading).toEqual({
        configDir,
        fetchedAtMs: Date.parse(limits!.checkedAt),
        usage,
      });
      expect((yield* fs.stat(shared)).mode & 0o777).toBe(yield* privateFileMode);
      const poll = shared.replace(/\.json$/, ".poll.json");
      expect(yield* decodeJson(yield* fs.readFileString(poll))).toEqual({
        configDir,
        attemptedAtMs: Date.parse(limits!.checkedAt),
        status: "ok",
        nextAttemptAtMs: Date.parse(limits!.checkedAt) + 55_000,
      });
      expect((yield* fs.stat(poll)).mode & 0o777).toBe(yield* privateFileMode);
      expect((yield* fs.readDirectory(shareDirectory)).sort()).toEqual(
        [path.basename(shared), path.basename(poll)].sort(),
      );
    }),
  );

  it.effect("returns no new timestamp on HTTP or malformed-response failures", () =>
    Effect.gen(function* () {
      const { configDir } = yield* writeLogin;
      const names = yield* Ref.make({ overageIncluded: undefined as string | undefined });
      for (const client of [
        respond(500, {}),
        respond(200, { five_hour: { utilization: "wrong", resets_at: null } }),
      ]) {
        const reader = yield* ClaudeResetCredits.makeClaudeUsageLimitsReader(configDir, names).pipe(
          Effect.provideService(HostProcess.Platform, "linux"),
          Effect.provideService(HttpClient.HttpClient, client),
        );
        expect(yield* reader("2.1.0")).toBeUndefined();
      }
    }),
  );
});
