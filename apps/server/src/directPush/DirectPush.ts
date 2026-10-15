/**
 * Sends agent activity to APNs directly, for apps under their own bundle id that the
 * T3 relay cannot reach. The APNs key lives in the server secret store; without one,
 * every method is inert and the server behaves as upstream.
 */
import {
  RelayAgentActivityAggregateState,
  RelayAgentAwarenessPreferences,
  type RelayAgentActivityState,
  type RelayDeviceRegistrationRequest,
  type RelayLiveActivityRegistrationRequest,
} from "@t3tools/contracts/relay";
import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  chooseDeliveries,
  type ChosenDelivery,
  type DirectPushDevice,
  isPermanentApnsTokenFailure,
  isTerminalPhase,
  makeAggregateState,
  makeApnsRequest,
} from "./agentActivityDelivery.ts";
import * as ApnsTransport from "./ApnsTransport.ts";

/** `<stateDir>/secrets/direct-push-apns.bin`: JSON with the APNs key and app identity. */
export const DIRECT_PUSH_APNS_SECRET = "direct-push-apns";
/** `<stateDir>/secrets/direct-push-devices.bin`: devices registered for direct push. */
export const DIRECT_PUSH_DEVICES_SECRET = "direct-push-devices";

/**
 * How long a finished thread stays finished before its Done push goes out. A
 * thread that runs again in the meantime (a wake from a background task or a
 * delegated worker, a queued message) does not ring for the run it left.
 */
export const COMPLETION_SETTLE_MS = 60_000;

const ApnsEnvironmentSchema = Schema.Literals(["sandbox", "production"]);

export const DirectPushApnsConfig = Schema.Struct({
  teamId: Schema.String.check(Schema.isPattern(/^[A-Z0-9]{10}$/)),
  keyId: Schema.String.check(Schema.isPattern(/^[A-Z0-9]{10}$/)),
  /** PKCS#8 PEM of the .p8 key (escaped `\n` allowed). */
  privateKey: Schema.String.check(Schema.isPattern(/PRIVATE KEY/)),
  /** The app's bundle id, the APNs topic. Devices of other apps are skipped. */
  bundleId: Schema.String.check(Schema.isMinLength(1)),
  /** Used when a device does not say; TestFlight and App Store builds use production. */
  environment: Schema.optional(ApnsEnvironmentSchema),
});
export type DirectPushApnsConfig = typeof DirectPushApnsConfig.Type;

const StoredDevice = Schema.Struct({
  deviceId: Schema.String,
  label: Schema.String,
  platform: Schema.Literals(["ios", "android"]),
  bundleId: Schema.NullOr(Schema.String),
  apsEnvironment: Schema.NullOr(ApnsEnvironmentSchema),
  pushToken: Schema.NullOr(Schema.String),
  preferences: RelayAgentAwarenessPreferences,
  updatedAt: Schema.String,
  activityPushToken: Schema.NullOr(Schema.String),
  lastAggregate: Schema.NullOr(RelayAgentActivityAggregateState),
  lastLiveActivityDeliveryAt: Schema.NullOr(Schema.String),
});
const StoredDevices = Schema.Array(StoredDevice);

const decodeConfig = Schema.decodeUnknownOption(Schema.fromJsonString(DirectPushApnsConfig));
const decodeDevices = Schema.decodeUnknownOption(Schema.fromJsonString(StoredDevices));

// Used for a Live Activity token that arrives before its device registration.
const DEFAULT_PREFERENCES: RelayAgentAwarenessPreferences = {
  liveActivitiesEnabled: true,
  notificationsEnabled: false,
  notifyOnApproval: true,
  notifyOnInput: true,
  notifyOnCompletion: true,
  notifyOnFailure: true,
};

/** Whether a valid APNs config is stored, for code that runs without the service. */
export const readDirectPushConfigured = (
  secrets: ServerSecretStore.ServerSecretStore["Service"],
): Effect.Effect<boolean> =>
  secrets.get(DIRECT_PUSH_APNS_SECRET).pipe(
    Effect.map(
      (bytes) =>
        Option.isSome(bytes) && Option.isSome(decodeConfig(new TextDecoder().decode(bytes.value))),
    ),
    Effect.orElseSucceed(() => false),
  );

export interface DirectPushRegistrationResult {
  readonly enabled: boolean;
}

export class DirectPush extends Context.Service<
  DirectPush,
  {
    /** Whether an APNs key is configured, so this server pushes itself. */
    readonly isEnabled: Effect.Effect<boolean>;
    readonly registerDevice: (
      request: RelayDeviceRegistrationRequest,
    ) => Effect.Effect<DirectPushRegistrationResult>;
    readonly registerLiveActivity: (
      request: RelayLiveActivityRegistrationRequest,
    ) => Effect.Effect<DirectPushRegistrationResult>;
    readonly snapshot: Effect.Effect<RelayAgentActivityAggregateState | null>;
    /**
     * Delivers one thread's new activity state (null when it no longer shows).
     * A completion waits `COMPLETION_SETTLE_MS`; a thread an agent opened
     * (`openedByThread`) never reports one, it reports to its opener instead.
     */
    readonly publish: (input: {
      readonly threadId: ThreadId;
      readonly state: RelayAgentActivityState | null;
      readonly openedByThread?: boolean;
    }) => Effect.Effect<void>;
  }
>()("t3/directPush/DirectPush") {}

function publishIdentity(state: RelayAgentActivityState | null): string {
  if (state === null) return "null";
  const { updatedAt: _updatedAt, ...rest } = state;
  return JSON.stringify(rest);
}

function liveActivityAggregateFor(input: {
  readonly device: DirectPushDevice;
  readonly states: ReadonlyArray<RelayAgentActivityState>;
  readonly state: RelayAgentActivityState | null;
  readonly nowMs: number;
}) {
  if (input.device.preferences.liveActivitiesEnabled) {
    return makeAggregateState({
      states: input.states,
      terminalState: input.state && isTerminalPhase(input.state) ? input.state : null,
      nowMs: input.nowMs,
    });
  }
  // Without Live Activities a device only hears about the thread that changed.
  if (!input.device.preferences.notificationsEnabled || input.state === null) return null;
  return makeAggregateState({
    states: isTerminalPhase(input.state) ? [] : [input.state],
    terminalState: isTerminalPhase(input.state) ? input.state : null,
    nowMs: input.nowMs,
  });
}

export const make = Effect.gen(function* () {
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const transport = yield* ApnsTransport.ApnsTransport;
  const lock = yield* Semaphore.make(1);
  const states = new Map<ThreadId, RelayAgentActivityState>();
  const publishedIdentities = new Map<ThreadId, string>();
  const pendingCompletions = new Map<
    ThreadId,
    { readonly identity: string; readonly timer: Fiber.Fiber<void> }
  >();
  let devices: Map<string, DirectPushDevice> | undefined;

  const readSecretString = (name: string) =>
    secrets.get(name).pipe(
      Effect.map((bytes) => (Option.isSome(bytes) ? new TextDecoder().decode(bytes.value) : null)),
      Effect.catch((error) =>
        Effect.logWarning("direct push secret read failed", { name, error: error.message }).pipe(
          Effect.as(null),
        ),
      ),
    );

  const readConfig = readSecretString(DIRECT_PUSH_APNS_SECRET).pipe(
    Effect.flatMap((raw) => {
      if (raw === null || raw.trim() === "") return Effect.succeed(null);
      const config = Option.getOrNull(decodeConfig(raw));
      return config === null
        ? Effect.logWarning("direct push APNs config is invalid; direct push stays off").pipe(
            Effect.as(null),
          )
        : Effect.succeed(config);
    }),
  );

  const loadDevices = Effect.gen(function* () {
    if (devices !== undefined) return devices;
    const raw = yield* readSecretString(DIRECT_PUSH_DEVICES_SECRET);
    const stored = raw === null ? [] : Option.getOrElse(decodeDevices(raw), () => []);
    devices = new Map(stored.map((device) => [device.deviceId, device]));
    return devices;
  });

  const saveDevices = (current: Map<string, DirectPushDevice>) =>
    secrets
      .set(
        DIRECT_PUSH_DEVICES_SECRET,
        new TextEncoder().encode(JSON.stringify([...current.values()])),
      )
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("direct push device store write failed", { error: error.message }),
        ),
      );

  const nowIso = DateTime.now.pipe(Effect.map(DateTime.formatIso));

  // Sends the chosen deliveries in order and returns the device as it stands
  // afterwards: delivery bookkeeping on success, dead tokens dropped.
  const deliver = Effect.fnUntraced(function* (
    config: DirectPushApnsConfig,
    initial: DirectPushDevice,
    deliveries: ReadonlyArray<ChosenDelivery>,
  ) {
    const device = { ...initial };
    for (const delivery of deliveries) {
      const now = yield* DateTime.now;
      const environment = device.apsEnvironment ?? config.environment ?? "production";
      const result = yield* transport
        .send({
          credentials: config,
          environment,
          bundleId: config.bundleId,
          request: makeApnsRequest(delivery, Math.floor(now.epochMilliseconds / 1_000)),
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("direct push APNs request failed", {
              deviceId: device.deviceId,
              kind: delivery.kind,
              error: error.message,
            }).pipe(Effect.as(null)),
          ),
        );
      if (result === null) continue;
      const ok = result.status >= 200 && result.status < 300;
      yield* (ok ? Effect.logInfo : Effect.logWarning)("direct push APNs delivery", {
        deviceId: device.deviceId,
        kind: delivery.kind,
        environment,
        status: result.status,
        reason: result.reason,
        apnsId: result.apnsId,
      });
      if (ok && delivery.kind !== "push_notification") {
        const ended = delivery.kind === "live_activity_end";
        Object.assign(device, {
          activityPushToken: ended ? null : device.activityPushToken,
          lastAggregate: ended ? null : delivery.aggregate,
          lastLiveActivityDeliveryAt: DateTime.formatIso(now),
        });
      } else if (!ok && isPermanentApnsTokenFailure(result.status, result.reason)) {
        Object.assign(
          device,
          delivery.kind === "push_notification"
            ? { pushToken: null }
            : { activityPushToken: null, lastAggregate: null },
        );
      }
    }
    return device;
  });

  // Delivers the current aggregate to the given devices and persists changes.
  const deliverToDevices = Effect.fnUntraced(function* (input: {
    readonly config: DirectPushApnsConfig;
    readonly deviceIds: ReadonlyArray<string>;
    readonly state: RelayAgentActivityState | null;
    readonly replay: boolean;
  }) {
    const current = yield* loadDevices;
    const nowMs = (yield* DateTime.now).epochMilliseconds;
    const allStates = [...states.values()];
    let changed = false;
    for (const deviceId of input.deviceIds) {
      const device = current.get(deviceId);
      if (!device || (device.bundleId !== null && device.bundleId !== input.config.bundleId)) {
        continue;
      }
      const aggregate = liveActivityAggregateFor({
        device,
        states: allStates,
        state: input.state,
        nowMs,
      });
      const deliveries = chooseDeliveries({ device, aggregate, nowMs, replay: input.replay });
      if (deliveries.length === 0) continue;
      const next = yield* deliver(input.config, device, deliveries);
      if (next !== device) {
        current.set(deviceId, next);
        changed = true;
      }
    }
    if (changed) yield* saveDevices(current);
  });

  const isEnabled = readConfig.pipe(Effect.map((config) => config !== null));

  const registerDevice: DirectPush["Service"]["registerDevice"] = (request) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const config = yield* readConfig;
        if (config === null) return { enabled: false };
        const current = yield* loadDevices;
        const previous = current.get(request.deviceId);
        const updatedAt = yield* nowIso;
        // A push token belongs to one install; drop it from any other record.
        if (request.pushToken) {
          for (const [deviceId, device] of current) {
            if (deviceId !== request.deviceId && device.pushToken === request.pushToken) {
              current.set(deviceId, { ...device, pushToken: null });
            }
          }
        }
        current.set(request.deviceId, {
          deviceId: request.deviceId,
          label: request.label,
          platform: request.platform,
          bundleId: request.bundleId ?? null,
          apsEnvironment: request.apsEnvironment ?? null,
          pushToken: request.pushToken ?? previous?.pushToken ?? null,
          preferences: request.preferences,
          updatedAt,
          activityPushToken: previous?.activityPushToken ?? null,
          lastAggregate: previous?.lastAggregate ?? null,
          lastLiveActivityDeliveryAt: previous?.lastLiveActivityDeliveryAt ?? null,
        });
        yield* saveDevices(current);
        yield* Effect.logInfo("direct push device registered", {
          deviceId: request.deviceId,
          hasPushToken: request.pushToken !== undefined,
          liveActivitiesEnabled: request.preferences.liveActivitiesEnabled,
          notificationsEnabled: request.preferences.notificationsEnabled,
        });
        // Repaints (or ends) the device's card, as the relay does on registration.
        yield* deliverToDevices({
          config,
          deviceIds: [request.deviceId],
          state: null,
          replay: true,
        });
        return { enabled: true };
      }),
    );

  const registerLiveActivity: DirectPush["Service"]["registerLiveActivity"] = (request) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const config = yield* readConfig;
        if (config === null) return { enabled: false };
        const current = yield* loadDevices;
        const updatedAt = yield* nowIso;
        // An activity token addresses one card; detach it from any other device.
        for (const [deviceId, device] of current) {
          if (
            deviceId !== request.deviceId &&
            device.activityPushToken === request.activityPushToken
          ) {
            current.set(deviceId, { ...device, activityPushToken: null, lastAggregate: null });
          }
        }
        const previous = current.get(request.deviceId);
        const sameCard = previous?.activityPushToken === request.activityPushToken;
        current.set(request.deviceId, {
          deviceId: request.deviceId,
          label: previous?.label ?? "iOS device",
          platform: previous?.platform ?? "ios",
          bundleId: previous?.bundleId ?? null,
          apsEnvironment: previous?.apsEnvironment ?? null,
          pushToken: previous?.pushToken ?? null,
          preferences: previous?.preferences ?? DEFAULT_PREFERENCES,
          updatedAt,
          activityPushToken: request.activityPushToken,
          // Re-registering the same card keeps what this server last showed on
          // it, so the replay neither re-alerts nor forgets to end it.
          lastAggregate: sameCard ? (previous?.lastAggregate ?? null) : null,
          lastLiveActivityDeliveryAt: sameCard
            ? (previous?.lastLiveActivityDeliveryAt ?? null)
            : null,
        });
        yield* saveDevices(current);
        yield* Effect.logInfo("direct push live activity registered", {
          deviceId: request.deviceId,
          sameCard,
        });
        yield* deliverToDevices({
          config,
          deviceIds: [request.deviceId],
          state: null,
          replay: true,
        });
        return { enabled: true };
      }),
    );

  const snapshot: DirectPush["Service"]["snapshot"] = Effect.gen(function* () {
    if ((yield* readConfig) === null) return null;
    const nowMs = (yield* DateTime.now).epochMilliseconds;
    return makeAggregateState({ states: [...states.values()], terminalState: null, nowMs });
  });

  // Callers hold the lock.
  const deliverState = Effect.fnUntraced(function* (
    config: DirectPushApnsConfig,
    threadId: ThreadId,
    state: RelayAgentActivityState | null,
    identity: string,
  ) {
    publishedIdentities.set(threadId, identity);
    if (state === null) {
      states.delete(threadId);
    } else {
      states.set(threadId, state);
    }
    const current = yield* loadDevices;
    yield* deliverToDevices({ config, deviceIds: [...current.keys()], state, replay: false });
  });

  const publish: DirectPush["Service"]["publish"] = ({
    threadId,
    state: published,
    openedByThread,
  }) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const config = yield* readConfig;
        if (config === null) return;
        const state = openedByThread && published?.phase === "completed" ? null : published;
        // The relay publisher retries failed relay calls; a retry must not
        // deliver the same state to the device twice.
        const identity = publishIdentity(state);
        const pending = pendingCompletions.get(threadId);
        if (pending?.identity === identity) return;
        if (pending !== undefined) {
          pendingCompletions.delete(threadId);
          yield* Fiber.interrupt(pending.timer);
        }
        if (publishedIdentities.get(threadId) === identity) return;
        if (state?.phase !== "completed") {
          yield* deliverState(config, threadId, state, identity);
          return;
        }
        const timer = yield* Effect.sleep(COMPLETION_SETTLE_MS).pipe(
          Effect.andThen(
            lock.withPermits(1)(
              Effect.gen(function* () {
                if (pendingCompletions.get(threadId)?.identity !== identity) return;
                pendingCompletions.delete(threadId);
                const latest = yield* readConfig;
                if (latest !== null) yield* deliverState(latest, threadId, state, identity);
              }),
            ),
          ),
          Effect.forkDetach,
        );
        pendingCompletions.set(threadId, { identity, timer });
      }),
    );

  return DirectPush.of({ isEnabled, registerDevice, registerLiveActivity, snapshot, publish });
});

export const layer = Layer.effect(DirectPush, make).pipe(Layer.provide(ApnsTransport.layer));
