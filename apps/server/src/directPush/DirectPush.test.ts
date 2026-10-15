// @effect-diagnostics nodeBuiltinImport:off -- the tests generate and verify a real P-256 key.
import * as NodeCrypto from "node:crypto";

import { assert, describe, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type {
  RelayAgentActivityState,
  RelayDeviceRegistrationRequest,
} from "@t3tools/contracts/relay";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ApnsTransport from "./ApnsTransport.ts";
import * as DirectPush from "./DirectPush.ts";

const THREAD_ID = ThreadId.make("thread-1");
const { privateKey, publicKey } = NodeCrypto.generateKeyPairSync("ec", { namedCurve: "P-256" });
const PRIVATE_KEY_PEM = privateKey.export({ format: "pem", type: "pkcs8" }).toString();
const CONFIG = {
  teamId: "Y9PUU2MN3R",
  keyId: "ABCDE12345",
  privateKey: PRIVATE_KEY_PEM,
  bundleId: "nl.example.t3code",
};

function activity(
  phase: RelayAgentActivityState["phase"],
  overrides: Partial<RelayAgentActivityState> = {},
): RelayAgentActivityState {
  return {
    environmentId: EnvironmentId.make("env-1"),
    threadId: THREAD_ID,
    projectTitle: "Project",
    threadTitle: "Fix the bug",
    phase,
    headline: phase,
    modelTitle: "Model",
    updatedAt: DateTime.formatIso(DateTime.nowUnsafe()),
    deepLink: "/threads/thread-1",
    ...overrides,
  };
}

function device(
  overrides: Partial<RelayDeviceRegistrationRequest> = {},
): RelayDeviceRegistrationRequest {
  return {
    deviceId: "device-1",
    label: "iPhone",
    platform: "ios",
    iosMajorVersion: 26,
    bundleId: "nl.example.t3code",
    apsEnvironment: "production",
    pushToken: "push-token-1",
    preferences: {
      liveActivitiesEnabled: false,
      notificationsEnabled: true,
      notifyOnApproval: true,
      notifyOnInput: true,
      notifyOnCompletion: true,
      notifyOnFailure: true,
    },
    ...overrides,
  };
}

const makeHarness = Effect.fnUntraced(function* (
  options: {
    readonly configured?: boolean;
    readonly respond?: (input: ApnsTransport.ApnsSendInput) => ApnsTransport.ApnsResponse;
  } = {},
) {
  const values = new Map<string, Uint8Array>(
    options.configured === false
      ? []
      : [[DirectPush.DIRECT_PUSH_APNS_SECRET, new TextEncoder().encode(JSON.stringify(CONFIG))]],
  );
  const secrets = ServerSecretStore.ServerSecretStore.of({
    get: (name) => Effect.succeed(Option.fromUndefinedOr(values.get(name))),
    create: (name, value) => Effect.sync(() => void values.set(name, value)),
    set: (name, value) => Effect.sync(() => void values.set(name, value)),
    remove: (name) => Effect.sync(() => void values.delete(name)),
    getOrCreateRandom: () => Effect.die("unused"),
  });
  const sent: Array<ApnsTransport.ApnsSendInput> = [];
  const transport = ApnsTransport.ApnsTransport.of({
    send: (input) =>
      Effect.sync(() => {
        sent.push(input);
        return options.respond?.(input) ?? { status: 200, reason: null, apnsId: "apns-id" };
      }),
  });
  const push = yield* DirectPush.make.pipe(
    Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    Effect.provideService(ApnsTransport.ApnsTransport, transport),
  );
  return { push, sent, values };
});

const aps = (input: ApnsTransport.ApnsSendInput) =>
  (input.request.payload as { readonly aps: Record<string, unknown> }).aps;

describe("DirectPush", () => {
  it.live("is inert without an APNs key, as upstream", () =>
    Effect.gen(function* () {
      const { push, sent, values } = yield* makeHarness({ configured: false });
      assert.isFalse(yield* push.isEnabled);
      assert.deepStrictEqual(yield* push.registerDevice(device()), { enabled: false });
      yield* push.publish({ threadId: THREAD_ID, state: activity("waiting_for_input") });
      assert.strictEqual(sent.length, 0);
      assert.isFalse(values.has(DirectPush.DIRECT_PUSH_DEVICES_SECRET));
    }),
  );

  it.live("sends an alert push when an agent needs input, once per state", () =>
    Effect.gen(function* () {
      const { push, sent } = yield* makeHarness();
      assert.deepStrictEqual(yield* push.registerDevice(device()), { enabled: true });
      yield* push.publish({ threadId: THREAD_ID, state: activity("running") });
      assert.strictEqual(sent.length, 0);
      const waiting = activity("waiting_for_input");
      yield* push.publish({ threadId: THREAD_ID, state: waiting });
      // A relay retry republishes the same state; it must not buzz twice.
      yield* push.publish({ threadId: THREAD_ID, state: { ...waiting, updatedAt: "later" } });
      assert.strictEqual(sent.length, 1);
      const [request] = sent;
      assert.strictEqual(request!.request.pushType, "alert");
      assert.strictEqual(request!.request.token, "push-token-1");
      assert.strictEqual(request!.bundleId, "nl.example.t3code");
      assert.strictEqual(request!.environment, "production");
      assert.deepStrictEqual(aps(request!).alert, {
        title: "Fix the bug",
        body: "Input: Project",
      });
    }),
  );

  it.effect("sends a completion push once the thread has stayed finished", () =>
    Effect.gen(function* () {
      const { push, sent } = yield* makeHarness();
      yield* push.registerDevice(device());
      const completed = activity("completed");
      yield* push.publish({ threadId: THREAD_ID, state: completed });
      // A relay retry while the completion waits must not restart or double it.
      yield* push.publish({ threadId: THREAD_ID, state: { ...completed, updatedAt: "later" } });
      yield* TestClock.adjust(DirectPush.COMPLETION_SETTLE_MS - 1_000);
      assert.strictEqual(sent.length, 0);
      yield* TestClock.adjust(1_000);
      assert.strictEqual(sent.length, 1);
      assert.deepStrictEqual(aps(sent[0]!).alert, { title: "Fix the bug", body: "Done: Project" });
      yield* TestClock.adjust(DirectPush.COMPLETION_SETTLE_MS);
      assert.strictEqual(sent.length, 1);
    }),
  );

  it.effect("drops a completion when the thread runs again before it settles", () =>
    Effect.gen(function* () {
      const { push, sent } = yield* makeHarness();
      yield* push.registerDevice(device());
      yield* push.publish({ threadId: THREAD_ID, state: activity("completed") });
      yield* TestClock.adjust(DirectPush.COMPLETION_SETTLE_MS / 2);
      // A background task or a delegated worker wakes the agent.
      yield* push.publish({ threadId: THREAD_ID, state: activity("running") });
      yield* TestClock.adjust(DirectPush.COMPLETION_SETTLE_MS);
      assert.strictEqual(sent.length, 0);
      yield* push.publish({
        threadId: THREAD_ID,
        state: activity("completed", { headline: "done" }),
      });
      yield* TestClock.adjust(DirectPush.COMPLETION_SETTLE_MS);
      assert.strictEqual(sent.length, 1);
      assert.deepStrictEqual(aps(sent[0]!).alert, { title: "Fix the bug", body: "Done: Project" });
    }),
  );

  it.effect("sends failures and questions at once", () =>
    Effect.gen(function* () {
      const { push, sent } = yield* makeHarness();
      yield* push.registerDevice(device());
      yield* push.publish({ threadId: THREAD_ID, state: activity("failed") });
      assert.strictEqual(sent.length, 1);
      assert.deepStrictEqual(aps(sent[0]!).alert, {
        title: "Fix the bug",
        body: "Failed: Project",
      });
    }),
  );

  it.effect("keeps a thread an agent opened quiet when it finishes, not when it asks", () =>
    Effect.gen(function* () {
      const { push, sent } = yield* makeHarness();
      yield* push.registerDevice(device());
      yield* push.publish({
        threadId: THREAD_ID,
        state: activity("completed"),
        openedByThread: true,
      });
      yield* TestClock.adjust(DirectPush.COMPLETION_SETTLE_MS * 2);
      assert.strictEqual(sent.length, 0);
      yield* push.publish({
        threadId: THREAD_ID,
        state: activity("waiting_for_approval"),
        openedByThread: true,
      });
      yield* push.publish({ threadId: THREAD_ID, state: activity("failed"), openedByThread: true });
      assert.deepStrictEqual(
        sent.map((request) => aps(request).alert),
        [
          { title: "Fix the bug", body: "Approval: Project" },
          { title: "Fix the bug", body: "Failed: Project" },
        ],
      );
    }),
  );

  it.live("skips devices of another app", () =>
    Effect.gen(function* () {
      const { push, sent } = yield* makeHarness();
      yield* push.registerDevice(device({ bundleId: "com.t3tools.t3code" }));
      yield* push.publish({ threadId: THREAD_ID, state: activity("waiting_for_input") });
      assert.strictEqual(sent.length, 0);
    }),
  );

  it.live("updates the Live Activity, alerts on attention and ends it when work is gone", () =>
    Effect.gen(function* () {
      const { push, sent } = yield* makeHarness();
      const liveActivities = {
        ...device().preferences,
        liveActivitiesEnabled: true,
      };
      yield* push.registerDevice(device({ preferences: liveActivities }));
      yield* push.registerLiveActivity({ deviceId: "device-1", activityPushToken: "la-token" });
      // Nothing to show: an idle server never ends a card it did not fill.
      assert.strictEqual(sent.length, 0);

      yield* push.publish({ threadId: THREAD_ID, state: activity("running") });
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(sent[0]!.request.pushType, "liveactivity");
      assert.strictEqual(sent[0]!.request.token, "la-token");
      assert.strictEqual(aps(sent[0]!).event, "update");
      assert.isUndefined(aps(sent[0]!).alert);

      yield* push.publish({ threadId: THREAD_ID, state: activity("waiting_for_approval") });
      assert.strictEqual(sent.length, 2);
      assert.strictEqual(sent[1]!.request.priority, "10");
      assert.deepStrictEqual(aps(sent[1]!).alert, {
        title: "Fix the bug",
        body: "Approval: Project",
        sound: "default",
      });
      const props = JSON.parse(
        (aps(sent[1]!)["content-state"] as { readonly props: string }).props,
      ) as { readonly activeCount: number };
      assert.strictEqual(props.activeCount, 1);

      yield* push.publish({ threadId: THREAD_ID, state: null });
      assert.strictEqual(sent.length, 3);
      assert.strictEqual(aps(sent[2]!).event, "end");
      assert.strictEqual(sent[2]!.request.token, "la-token");
    }),
  );

  it.live("replays the current card when its token registers again", () =>
    Effect.gen(function* () {
      const { push, sent } = yield* makeHarness();
      const liveActivities = { ...device().preferences, liveActivitiesEnabled: true };
      yield* push.registerDevice(device({ preferences: liveActivities }));
      yield* push.publish({ threadId: THREAD_ID, state: activity("running") });
      assert.strictEqual(sent.length, 0);
      yield* push.registerLiveActivity({ deviceId: "device-1", activityPushToken: "la-token" });
      assert.strictEqual(sent.length, 1);
      assert.strictEqual(aps(sent[0]!).event, "update");
      assert.isUndefined(aps(sent[0]!).alert);
      const snapshot = yield* push.snapshot;
      assert.strictEqual(snapshot?.activeCount, 1);
    }),
  );

  it.live("drops a push token APNs reports as unregistered", () =>
    Effect.gen(function* () {
      const { push, sent, values } = yield* makeHarness({
        respond: () => ({ status: 410, reason: "Unregistered", apnsId: null }),
      });
      yield* push.registerDevice(device());
      yield* push.publish({ threadId: THREAD_ID, state: activity("waiting_for_input") });
      assert.strictEqual(sent.length, 1);
      const stored = JSON.parse(
        new TextDecoder().decode(values.get(DirectPush.DIRECT_PUSH_DEVICES_SECRET)),
      ) as ReadonlyArray<{ readonly pushToken: string | null }>;
      assert.strictEqual(stored[0]!.pushToken, null);
    }),
  );

  it.live("keeps devices across a server restart", () =>
    Effect.gen(function* () {
      const first = yield* makeHarness();
      yield* first.push.registerDevice(device());
      const second = yield* makeHarness();
      for (const [name, value] of first.values) second.values.set(name, value);
      yield* second.push.publish({ threadId: THREAD_ID, state: activity("waiting_for_input") });
      assert.strictEqual(second.sent.length, 1);
    }),
  );
});

describe("ApnsTransport", () => {
  it("signs an ES256 provider token APNs can verify", () => {
    const jwt = ApnsTransport.signApnsJwt(CONFIG, 1_800_000_000);
    const [header, payload, signature] = jwt.split(".");
    assert.deepStrictEqual(JSON.parse(Buffer.from(header!, "base64url").toString()), {
      alg: "ES256",
      kid: "ABCDE12345",
    });
    assert.deepStrictEqual(JSON.parse(Buffer.from(payload!, "base64url").toString()), {
      iss: "Y9PUU2MN3R",
      iat: 1_800_000_000,
    });
    assert.isTrue(
      NodeCrypto.verify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        { key: publicKey, dsaEncoding: "ieee-p1363" },
        Buffer.from(signature!, "base64url"),
      ),
    );
  });
});
