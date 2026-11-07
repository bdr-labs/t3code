import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ScheduledTask,
  ScheduledTaskId,
  type ScheduledTaskUpsertInput,
  type ScheduledTaskUpsertSchedule,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  ThreadId,
} from "@t3tools/contracts";
import {
  makeUnavailableUsageLimits,
  makeUsageLimits,
  resolveUsageLimitsAfterProbe,
} from "@t3tools/provider-core/server/usageLimits";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";

const NOW = "2026-09-09T12:00:00.000Z";
const T = "2026-09-09T17:00:00.000Z";
const NEXT_PERIOD = "2026-09-09T22:00:00.000Z";
const T_MS = Date.parse(T);
const MINUTE_MS = 60_000;

const codex = ProviderInstanceId.make("codex");
const taskId = ScheduledTaskId.make("task:usage");
const thread = ThreadId.make("thread:usage");
const ABOVE: ScheduledTaskUpsertSchedule = {
  type: "usage",
  window: "weekly",
  on: "above",
  usedPercent: 80,
};
const BELOW: ScheduledTaskUpsertSchedule = {
  type: "usage",
  window: "weekly",
  on: "below",
  usedPercent: 20,
};
const RENEWS: ScheduledTaskUpsertSchedule = { type: "usage", window: "weekly", on: "reset" };

const usageTask = (
  schedule: ScheduledTaskUpsertSchedule,
  over: Partial<ScheduledTaskUpsertInput> = {},
): ScheduledTaskUpsertInput => ({
  id: taskId,
  title: "Check in",
  prompt: "Check progress",
  enabled: true,
  schedule,
  projectId: ProjectId.make("project:test"),
  threadId: thread,
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: codex, model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  ...over,
});

const weekly = (
  usedPercent: number,
  over: Partial<ServerProviderUsageWindow> = {},
): ServerProviderUsageWindow => ({
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent,
  resetsAt: T,
  ...over,
});
const providerWith = (
  usageLimits: ServerProviderUsageLimits | undefined,
  over: Partial<ServerProvider> = {},
): ServerProvider => ({
  instanceId: codex,
  driver: ProviderDriverKind.make("codex"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: NOW,
  models: [],
  slashCommands: [],
  skills: [],
  ...(usageLimits === undefined ? {} : { usageLimits }),
  ...over,
});
// As the registry publishes a reading: normalized at the clock's time, so a passed reset reads 0.
const reading = (usedPercent: number, over: Partial<ServerProviderUsageWindow> = {}) =>
  DateTime.now.pipe(
    Effect.map((now) => [
      providerWith(
        makeUsageLimits({
          checkedAt: DateTime.formatIso(now),
          windows: [weekly(usedPercent, over)],
        }),
      ),
    ]),
  );
const thereFor = (at: string) => TestClock.setTime(Date.parse(at));
const aboveState = (armed: boolean) => ({ armed, resetsAt: T });

type Persisted = {
  readonly sent: Ref.Ref<ReadonlyArray<string>>;
  readonly records: Ref.Ref<unknown>;
  readonly providers: Ref.Ref<ReadonlyArray<ServerProvider>>;
};

type Harness = Persisted & {
  readonly service: ScheduledTaskService.ScheduledTaskService["Service"];
  readonly sql: SqlClient.SqlClient;
  /** One pass of the real usage worker, at whatever the clock says. */
  readonly sweep: Effect.Effect<void>;
  readonly dueSweep: Effect.Effect<void>;
  /** Puts a reading on the registry's stream and returns once the service has handled it. */
  readonly publish: (providers: ReadonlyArray<ServerProvider>) => Effect.Effect<void>;
  /** How many times the worker asked for the providers: only a sweep that was not idle does. */
  readonly providerReads: Ref.Ref<number>;
  /** Runs once, in the worker, after it read the rows and before it writes. */
  readonly duringSweep: Ref.Ref<Effect.Effect<void>>;
  /** Runs once, in a save, after it read the task and before it writes. */
  readonly duringSave: Ref.Ref<Effect.Effect<void>>;
  /** What a send waits for, and fails on when it is set. */
  readonly sendGate: Ref.Ref<Effect.Effect<void, never>>;
  readonly stored: Effect.Effect<ScheduledTask>;
};

const ordinaryRecords = {
  thread: { modelSelection: { instanceId: codex, model: "gpt-5.4" } },
  runs: [],
  turnItems: [],
  providerSessions: [],
};
const stoppedRecords = (resetAt: string) => {
  const at = DateTime.makeUnsafe(NOW);
  return {
    ...ordinaryRecords,
    runs: [
      {
        id: "run:stopped",
        ordinal: 1,
        status: "failed",
        providerInstanceId: codex,
        modelSelection: ordinaryRecords.thread.modelSelection,
        rootNodeId: "node:stopped",
        startedAt: at,
        completedAt: at,
      },
    ],
    turnItems: [
      {
        type: "error",
        id: "item:stopped",
        ordinal: 1,
        status: "failed",
        runId: "run:stopped",
        nodeId: "node:stopped",
        updatedAt: at,
        failure: { class: "usage_limit", message: "Plan limit reached.", resetAt },
      },
    ],
  };
};

// One service over a fake registry; a second call on the same database is a restart.
const withUsage = <A, E>(
  body: (harness: Harness) => Effect.Effect<A, E>,
  kept?: Persisted,
  scheduler?: typeof Scheduler.layer,
) =>
  Effect.gen(function* () {
    const sent = kept?.sent ?? (yield* Ref.make<ReadonlyArray<string>>([]));
    const records = kept?.records ?? (yield* Ref.make<unknown>(ordinaryRecords));
    const providers = kept?.providers ?? (yield* Ref.make<ReadonlyArray<ServerProvider>>([]));
    const providerReads = yield* Ref.make(0);
    const duringSweep = yield* Ref.make<Effect.Effect<void>>(Effect.void);
    const duringSave = yield* Ref.make<Effect.Effect<void>>(Effect.void);
    const sendGate = yield* Ref.make<Effect.Effect<void, never>>(Effect.void);
    const changes = yield* Queue.unbounded<ReadonlyArray<ServerProvider>>();
    const pulls = yield* Queue.unbounded<void>();
    const once = (hook: Ref.Ref<Effect.Effect<void>>) =>
      Ref.getAndSet(hook, Effect.void).pipe(Effect.flatten);
    const workers = new Map<string, Effect.Effect<void>>();
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(SecretRequests.SecretRequests)({}),
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => once(duringSave).pipe(Effect.as(false)),
          }),
          NodeCrypto.layer,
          ServerSettings.layerTest(),
          Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Ref.update(providerReads, (count) => count + 1).pipe(
              Effect.andThen(once(duringSweep)),
              Effect.andThen(Ref.get(providers)),
            ),
            streamChanges: Stream.fromEffectRepeat(
              Queue.offer(pulls, undefined).pipe(Effect.andThen(Queue.take(changes))),
            ),
          }),
          scheduler ??
            Layer.succeed(Scheduler.Scheduler, {
              register: <E, R>(name: string, work: Effect.Effect<void, E, R>) =>
                Effect.gen(function* () {
                  const context = yield* Effect.context<R>();
                  workers.set(name, work.pipe(Effect.provideContext(context), Effect.orDie));
                }),
            }),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: () =>
              Ref.update(sent, (all) => [...all, "launch"]).pipe(
                Effect.as({ threadId: ThreadId.make("thread:launched"), resumed: false } as never),
              ),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Ref.get(records).pipe(Effect.map((value) => value as never)),
            sendToThread: (input) =>
              Ref.update(sent, (all) => [...all, input.mode]).pipe(
                Effect.andThen(Ref.get(sendGate)),
                Effect.flatten,
                Effect.as({ delivery: "started" } as never),
              ),
          }),
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      yield* Queue.take(pulls);
      return yield* body({
        service,
        sql: yield* SqlClient.SqlClient,
        sweep: workers.get("usage-tasks")!,
        dueSweep: workers.get("scheduled-tasks")!,
        sent,
        records,
        providers,
        providerReads,
        duringSweep,
        duringSave,
        sendGate,
        publish: (next) =>
          Effect.gen(function* () {
            yield* Ref.set(providers, next);
            yield* Queue.offer(changes, next);
            // It asks for the next change only once it has handled this one.
            yield* Queue.take(pulls);
          }),
        stored: service.list().pipe(
          Effect.map(({ tasks }) => tasks[0]!),
          Effect.orDie,
        ),
      });
    }).pipe(Effect.provide(layer));
  });

const overMemory = <A, E>(body: (harness: Harness) => Effect.Effect<A, E>) =>
  thereFor(NOW).pipe(
    Effect.andThen(withUsage(body)),
    Effect.provide(SqlitePersistence.layerMemory),
  );

const settled = (harness: Harness, usedPercent: number, over = {}) =>
  reading(usedPercent, over).pipe(Effect.flatMap(harness.publish), Effect.andThen(harness.sweep));

/** A saved task whose sweep has armed it on a reading short of the line. */
const armedAbove = (harness: Harness, over: Partial<ScheduledTaskUpsertInput> = {}) =>
  Effect.gen(function* () {
    yield* harness.service.upsert(usageTask(ABOVE, over));
    yield* settled(harness, 50);
    assert.deepEqual(scheduleOf(yield* harness.stored).state, aboveState(true));
  });
const scheduleOf = (task: ScheduledTask) => {
  assert.equal(task.schedule.type, "usage");
  return task.schedule as Extract<ScheduledTask["schedule"], { type: "usage" }>;
};

it.effect("a task created past its line waits for a crossing, then fires once for it", () =>
  overMemory((harness) =>
    Effect.gen(function* () {
      yield* harness.service.upsert(usageTask(ABOVE));
      yield* settled(harness, 90);
      assert.deepEqual(yield* Ref.get(harness.sent), []);
      assert.deepEqual(scheduleOf(yield* harness.stored).state, aboveState(false));

      yield* settled(harness, 95);
      assert.deepEqual(yield* Ref.get(harness.sent), []);

      // Under the line, but not 5 points under.
      yield* settled(harness, 79);
      assert.deepEqual(scheduleOf(yield* harness.stored).state, aboveState(false));
      yield* settled(harness, 85);
      assert.deepEqual(yield* Ref.get(harness.sent), []);

      yield* settled(harness, 50);
      assert.deepEqual(yield* Ref.get(harness.sent), []);
      assert.deepEqual(scheduleOf(yield* harness.stored).state, aboveState(true));

      yield* settled(harness, 85);
      assert.deepEqual(yield* Ref.get(harness.sent), ["queue"]);
      assert.equal((yield* harness.stored).lastRunStatus, "succeeded");

      // The fired prompt's own usage, and more readings of the same crossing.
      yield* settled(harness, 92);
      yield* settled(harness, 85);
      assert.deepEqual(yield* Ref.get(harness.sent), ["queue"]);

      // A small move is the same crossing; 5 points back is a new one.
      yield* settled(harness, 79);
      yield* settled(harness, 81);
      assert.deepEqual(yield* Ref.get(harness.sent), ["queue"]);
      yield* settled(harness, 75);
      assert.deepEqual(scheduleOf(yield* harness.stored).state, aboveState(true));
      yield* settled(harness, 81);
      assert.deepEqual(yield* Ref.get(harness.sent), ["queue", "queue"]);
    }),
  ),
);

it.effect("`below` fires at the line with no margin, and rearms only 5 points back", () =>
  overMemory((harness) =>
    Effect.gen(function* () {
      yield* harness.service.upsert(usageTask(BELOW));
      yield* settled(harness, 21);
      yield* settled(harness, 19);
      assert.deepEqual(yield* Ref.get(harness.sent), ["queue"]);

      yield* settled(harness, 21);
      assert.deepEqual(scheduleOf(yield* harness.stored).state, { armed: false });
      yield* settled(harness, 19);
      assert.deepEqual(yield* Ref.get(harness.sent), ["queue"]);

      yield* settled(harness, 25);
      assert.deepEqual(scheduleOf(yield* harness.stored).state, { armed: true });
      yield* settled(harness, 19);
      assert.deepEqual(yield* Ref.get(harness.sent), ["queue", "queue"]);
    }),
  ),
);

it.effect("a crossing and its state outlive a restart: one fire, in the one row", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* thereFor(NOW);
    const persisted = yield* withUsage((harness) =>
      Effect.gen(function* () {
        yield* armedAbove(harness);
        yield* settled(harness, 85);
        assert.deepEqual(yield* Ref.get(harness.sent), ["queue"]);
        return { sent: harness.sent, records: harness.records, providers: harness.providers };
      }),
    );
    // No new column: the trigger and what the sweep learned are both in schedule_json.
    const [row] = yield* sql<{ schedule_json: string }>`
      SELECT schedule_json FROM scheduled_tasks WHERE task_id = ${taskId}`;
    assert.deepEqual(JSON.parse(row!.schedule_json), { ...ABOVE, state: aboveState(false) });

    yield* withUsage(
      (harness) =>
        Effect.gen(function* () {
          yield* harness.sweep;
          yield* settled(harness, 85);
          assert.deepEqual(yield* Ref.get(harness.sent), ["queue"]);
        }),
      persisted,
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a renewal fires once a minute after it, on the clock alone, then once per period", () =>
  overMemory((harness) =>
    Effect.gen(function* () {
      yield* harness.service.upsert(usageTask(RENEWS));
      yield* settled(harness, 80);
      assert.deepEqual(scheduleOf(yield* harness.stored).state, { resetsAt: T, usedPercent: 80 });

      // Jitter on the reset time, however the usage moves.
      const jittered = DateTime.formatIso(DateTime.makeUnsafe(T_MS + 4_000));
      yield* settled(harness, 79, { resetsAt: jittered });
      assert.deepEqual(yield* Ref.get(harness.sent), []);
      yield* TestClock.setTime(T_MS - 30_000);
      yield* settled(harness, 80);

      yield* TestClock.setTime(T_MS + 59_000);
      const readsBefore = yield* Ref.get(harness.providerReads);
      yield* harness.sweep;
      assert.equal(yield* Ref.get(harness.providerReads), readsBefore, "idle until it is due");
      assert.deepEqual(yield* Ref.get(harness.sent), []);

      yield* TestClock.setTime(T_MS + MINUTE_MS);
      yield* harness.sweep;
      assert.deepEqual(yield* Ref.get(harness.sent), ["queue"]);

      // The placeholder, then the new period's first reading, are the same reset.
      yield* TestClock.setTime(T_MS + 2 * MINUTE_MS);
      yield* settled(harness, 80);
      yield* settled(harness, 3, { resetsAt: NEXT_PERIOD });
      assert.deepEqual(yield* Ref.get(harness.sent), ["queue"]);

      yield* TestClock.setTime(Date.parse(NEXT_PERIOD) + MINUTE_MS);
      yield* harness.sweep;
      assert.deepEqual(yield* Ref.get(harness.sent), ["queue", "queue"]);
    }),
  ),
);

it.effect("a reset before the task's first reading is not its to fire", () =>
  overMemory((harness) =>
    Effect.gen(function* () {
      yield* harness.service.upsert(usageTask(RENEWS));
      yield* thereFor("2026-09-09T18:00:00.000Z");
      // A provider that has not read since: the window still names the reset that passed.
      yield* settled(harness, 80);
      yield* TestClock.adjust("2 minutes");
      yield* harness.sweep;
      yield* settled(harness, 80);
      assert.deepEqual(yield* Ref.get(harness.sent), []);
    }),
  ),
);

it.effect("the placeholder 0 and a stale percent fire no `below`; the fresh reading does", () =>
  overMemory((harness) =>
    Effect.gen(function* () {
      yield* harness.service.upsert(usageTask(BELOW));
      yield* settled(harness, 90);
      assert.deepEqual(scheduleOf(yield* harness.stored).state, { armed: true });

      yield* TestClock.setTime(T_MS + 1_000);
      const placeholder = yield* reading(90);
      assert.equal(placeholder[0]!.usageLimits!.windows[0]!.resetPending, true);
      assert.equal(placeholder[0]!.usageLimits!.windows[0]!.usedPercent, 0);
      yield* harness.publish(placeholder);
      yield* harness.sweep;
      // The same reset not yet normalized: a percent from before it.
      yield* harness.publish([providerWith({ checkedAt: T, windows: [weekly(5)] })]);
      yield* harness.sweep;
      assert.deepEqual(yield* Ref.get(harness.sent), []);
      assert.deepEqual(scheduleOf(yield* harness.stored).state, { armed: true });

      yield* settled(harness, 4, { resetsAt: NEXT_PERIOD });
      assert.deepEqual(yield* Ref.get(harness.sent), ["queue"]);
    }),
  ),
);

const readingNow = (windows: ReadonlyArray<ServerProviderUsageWindow>) =>
  makeUsageLimits({ checkedAt: NOW, windows });

it.effect.each([
  [
    "a failed probe",
    [
      providerWith({
        ...readingNow([weekly(99)]),
        unavailable: { reason: "probeFailed" as const },
      }),
    ],
  ],
  [
    "an unavailable account",
    [
      providerWith({
        checkedAt: NOW,
        windows: [],
        unavailable: { reason: "unsupported" as const },
      }),
    ],
  ],
  ["no limits at all", [providerWith(undefined)]],
  [
    "a signed-out provider, keeping its last windows",
    [providerWith(readingNow([weekly(99)]), { auth: { status: "unauthenticated" } })],
  ],
  [
    "a disabled provider, keeping its last windows",
    [providerWith(readingNow([weekly(99)]), { enabled: false })],
  ],
  [
    "a window that is gone",
    [providerWith(readingNow([weekly(99, { id: "five_hour", kind: "session" })]))],
  ],
  ["a removed instance", []],
] as const)("%s fires nothing, throws nothing and changes no state", ([, providers]) =>
  overMemory((harness) =>
    Effect.gen(function* () {
      yield* armedAbove(harness);
      yield* harness.publish(providers);
      yield* harness.sweep;
      assert.deepEqual(yield* Ref.get(harness.sent), []);
      const task = yield* harness.stored;
      assert.deepEqual(scheduleOf(task).state, aboveState(true));
      assert.isNull(task.lastRunError);
    }),
  ),
);

it.effect("an edit that keeps the trigger keeps the state; one that changes it clears it", () =>
  overMemory((harness) =>
    Effect.gen(function* () {
      yield* harness.service.upsert(usageTask(ABOVE));
      yield* settled(harness, 90);

      const { task: edited } = yield* harness.service.upsert(
        usageTask(ABOVE, { title: "Renamed" }),
      );
      assert.equal(edited.title, "Renamed");
      assert.deepEqual(scheduleOf(edited).state, aboveState(false));
      yield* settled(harness, 90);
      assert.deepEqual(yield* Ref.get(harness.sent), []);

      const { task: changed } = yield* harness.service.upsert(
        usageTask({ ...ABOVE, usedPercent: 70 } as ScheduledTaskUpsertSchedule),
      );
      assert.isUndefined(scheduleOf(changed).state);
      // Past the new line too: a fresh start, so it waits for a crossing.
      yield* settled(harness, 90);
      assert.deepEqual(yield* Ref.get(harness.sent), []);
      assert.deepEqual(scheduleOf(yield* harness.stored).state, aboveState(false));
    }),
  ),
);

it.effect("a state that arrives with a save is ignored", () =>
  overMemory((harness) =>
    Effect.gen(function* () {
      const smuggled = { ...ABOVE, state: { armed: true } } as ScheduledTaskUpsertSchedule;
      const { task: created } = yield* harness.service.upsert(usageTask(smuggled));
      assert.isUndefined(scheduleOf(created).state);
      yield* settled(harness, 90);
      assert.deepEqual(yield* Ref.get(harness.sent), []);

      // As an MCP update sends the stored schedule back, here with a lie in it.
      const { task: updated } = yield* harness.service.upsert(usageTask(smuggled));
      assert.deepEqual(scheduleOf(updated).state, aboveState(false));
      yield* settled(harness, 90);
      assert.deepEqual(yield* Ref.get(harness.sent), []);
    }),
  ),
);

it.effect.each([
  ["setEnabled", (harness: Harness) => harness.service.setEnabled({ id: taskId, enabled: true })],
  ["an edit", (harness: Harness) => harness.service.upsert(usageTask(ABOVE))],
] as const)(
  "a paused task fires nothing, and re-enabling by %s forgets what it missed",
  ([, resume]) =>
    overMemory((harness) =>
      Effect.gen(function* () {
        yield* armedAbove(harness);
        yield* harness.service.setEnabled({ id: taskId, enabled: false });

        yield* settled(harness, 95);
        assert.deepEqual(yield* Ref.get(harness.sent), []);
        assert.deepEqual(scheduleOf(yield* harness.stored).state, aboveState(true));

        const { task } = yield* resume(harness);
        assert.isTrue(task.enabled);
        assert.isUndefined(scheduleOf(task).state);
        assert.isUndefined(scheduleOf(yield* harness.stored).state);
        assert.isNull(task.nextRunAt);

        yield* settled(harness, 95);
        assert.deepEqual(yield* Ref.get(harness.sent), []);
        assert.deepEqual(scheduleOf(yield* harness.stored).state, aboveState(false));
      }),
    ),
);

it.effect.each([
  [
    "an edit of the trigger",
    (harness: Harness) =>
      harness.service
        .upsert(usageTask({ ...ABOVE, usedPercent: 99 } as ScheduledTaskUpsertSchedule))
        .pipe(Effect.orDie, Effect.asVoid),
    (task: ScheduledTask) => assert.equal(scheduleOf(task).usedPercent, 99),
  ],
  [
    "a pause",
    (harness: Harness) =>
      harness.service.setEnabled({ id: taskId, enabled: false }).pipe(Effect.orDie, Effect.asVoid),
    (task: ScheduledTask) => assert.isFalse(task.enabled),
  ],
] as const)("%s landing mid-sweep wins: no state written over it, and no fire", ([, edit, check]) =>
  overMemory((harness) =>
    Effect.gen(function* () {
      yield* armedAbove(harness);
      yield* Ref.set(harness.duringSweep, edit(harness));
      yield* settled(harness, 90);

      assert.deepEqual(yield* Ref.get(harness.sent), []);
      const task = yield* harness.stored;
      check(task);
      assert.notEqual(scheduleOf(task).state?.armed, false);
    }),
  ),
);

it.effect("a rename that lands mid-sweep stays, and the fire uses it", () =>
  overMemory((harness) =>
    Effect.gen(function* () {
      yield* armedAbove(harness);
      yield* Ref.set(
        harness.duringSweep,
        harness.service
          .upsert(usageTask(ABOVE, { title: "Renamed" }))
          .pipe(Effect.orDie, Effect.asVoid),
      );
      yield* settled(harness, 90);

      assert.deepEqual(yield* Ref.get(harness.sent), ["queue"]);
      const task = yield* harness.stored;
      assert.equal(task.title, "Renamed");
      assert.deepEqual(scheduleOf(task).state, aboveState(false));
    }),
  ),
);

it.effect("a sweep that fires during a save is not undone by it, so the crossing stays spent", () =>
  overMemory((harness) =>
    Effect.gen(function* () {
      yield* armedAbove(harness);
      yield* Ref.set(harness.providers, yield* reading(90));
      // The save has read `armed: true` by the time this fires and moves it.
      yield* Ref.set(
        harness.duringSave,
        reading(90).pipe(Effect.flatMap(harness.publish), Effect.andThen(harness.sweep)),
      );
      yield* harness.service.upsert(
        usageTask(ABOVE, {
          title: "Renamed",
          workspaceStrategy: { type: "worktree", baseRef: "main" },
        }),
      );
      assert.deepEqual(yield* Ref.get(harness.sent), ["queue"]);
      const task = yield* harness.stored;
      assert.equal(task.title, "Renamed");
      assert.deepEqual(scheduleOf(task).state, aboveState(false));

      yield* settled(harness, 90);
      assert.deepEqual(yield* Ref.get(harness.sent), ["queue"]);
    }),
  ),
);

it.effect("a usage task never enters the due sweep or the missed-run path", () =>
  overMemory((harness) =>
    Effect.gen(function* () {
      const { task: created } = yield* harness.service.upsert(usageTask(ABOVE));
      assert.isNull(created.nextRunAt);
      const check = Effect.gen(function* () {
        yield* TestClock.adjust("40 days");
        const before = yield* harness.stored;
        yield* harness.dueSweep;
        assert.deepEqual(yield* harness.stored, before);
        assert.isNull(before.nextRunAt);
        assert.deepEqual(yield* Ref.get(harness.sent), []);
      });
      yield* check;

      const ran = yield* harness.service.runNow({ id: taskId });
      assert.equal(ran.task.lastRunStatus, "succeeded");
      assert.isNull(ran.task.nextRunAt);
      assert.deepEqual(yield* Ref.get(harness.sent), ["queue"]);
      yield* Ref.set(harness.sent, []);
      yield* check;
    }),
  ),
);

it.effect("a run interrupted by a restart leaves a usage task with no next run", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* thereFor(NOW);
    const persisted = yield* withUsage((harness) =>
      Effect.gen(function* () {
        yield* harness.service.upsert(usageTask(ABOVE));
        return { sent: harness.sent, records: harness.records, providers: harness.providers };
      }),
    );
    yield* sql`UPDATE scheduled_tasks SET last_run_status = 'running', last_run_at = ${NOW}`;
    yield* withUsage(
      (harness) =>
        Effect.gen(function* () {
          const task = yield* harness.stored;
          assert.equal(task.lastRunStatus, "failed");
          assert.isNull(task.nextRunAt);
          assert.deepEqual(yield* Ref.get(harness.sent), []);
        }),
      persisted,
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "a crossing on a limit-stopped thread with a reset ahead sends nothing, and says why",
  () =>
    overMemory((harness) =>
      Effect.gen(function* () {
        yield* armedAbove(harness);
        const resetAt = "2026-09-09T15:00:00.000Z";
        yield* Ref.set(harness.records, stoppedRecords(resetAt));
        yield* settled(harness, 90);

        assert.deepEqual(yield* Ref.get(harness.sent), []);
        const task = yield* harness.stored;
        assert.equal(task.lastRunStatus, "failed");
        assert.include(task.lastRunError ?? "", resetAt);
        assert.include(task.lastRunError ?? "", "crossing is used");
        // Not the postponed wording, which a due sweep reads as a promise to try again.
        assert.notInclude(task.lastRunError ?? "", "next run");
        assert.isNull(task.nextRunAt);
        assert.equal(task.runCount, 0);
        // The crossing is used: no postponement, and no fire when the thread is free again.
        assert.deepEqual(scheduleOf(task).state, aboveState(false));
        yield* Ref.set(harness.records, ordinaryRecords);
        yield* thereFor(resetAt);
        yield* settled(harness, 90);
        assert.deepEqual(yield* Ref.get(harness.sent), []);
      }),
    ),
);

it.effect("a failed send shows in lastRunError and does not fire the crossing again", () =>
  overMemory((harness) =>
    Effect.gen(function* () {
      yield* armedAbove(harness);
      yield* Ref.set(harness.sendGate, Effect.die(new Error("Provider refused.")));
      yield* settled(harness, 90);
      const task = yield* harness.stored;
      assert.equal(task.lastRunStatus, "failed");
      assert.include(task.lastRunError ?? "", "Provider refused.");

      yield* Ref.set(harness.sendGate, Effect.void);
      yield* settled(harness, 90);
      assert.deepEqual(yield* Ref.get(harness.sent), ["queue"]);
    }),
  ),
);

it.effect("a crossing while the task is already running starts nothing more", () =>
  overMemory((harness) =>
    Effect.gen(function* () {
      yield* armedAbove(harness);
      const entered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      yield* Ref.set(
        harness.sendGate,
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
      );
      const manual = yield* harness.service.runNow({ id: taskId }).pipe(Effect.forkChild);
      yield* Deferred.await(entered);

      yield* settled(harness, 90);
      assert.deepEqual(yield* Ref.get(harness.sent), ["queue"]);

      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(manual);
      assert.equal((yield* harness.stored).lastRunStatus, "succeeded");
    }),
  ),
);

it.effect("an unbound task launches a new thread on the crossing, on its own instance", () =>
  overMemory((harness) =>
    Effect.gen(function* () {
      const alternate = ProviderInstanceId.make("codex_alternate");
      const schedule = { ...ABOVE, instanceId: alternate } as ScheduledTaskUpsertSchedule;
      yield* harness.publish([providerWith(undefined, { instanceId: alternate })]);
      const { threadId: _threadId, ...unbound } = usageTask(schedule);
      yield* harness.service.upsert(unbound);
      const on = (usedPercent: number) =>
        harness.publish([
          providerWith(readingNow([weekly(99)]), {}),
          providerWith(readingNow([weekly(usedPercent)]), { instanceId: alternate }),
        ]);
      yield* on(50);
      yield* harness.sweep;
      assert.deepEqual(yield* Ref.get(harness.sent), []);
      yield* on(90);
      yield* harness.sweep;
      assert.deepEqual(yield* Ref.get(harness.sent), ["launch"]);
    }),
  ),
);

it.effect("saving refuses a bad percent and an unknown instance, with the reason", () =>
  overMemory((harness) =>
    Effect.gen(function* () {
      const refused = (schedule: unknown) =>
        harness.service.upsert(usageTask(schedule as ScheduledTaskUpsertSchedule)).pipe(
          Effect.flip,
          Effect.map((error) => error.message),
        );

      assert.match(yield* refused({ type: "usage", window: "weekly", on: "above" }), /usedPercent/);
      assert.match(yield* refused({ ...RENEWS, usedPercent: 50 }), /usedPercent/);
      assert.match(yield* refused({ ...RENEWS, instanceId: "gone" }), /Unknown provider instance/);
      assert.deepEqual((yield* harness.service.list()).tasks, []);
    }),
  ),
);

it.effect("saving refuses a window the instance does not report, and lists what it does", () =>
  overMemory((harness) =>
    Effect.gen(function* () {
      const typo = { ...ABOVE, window: "weekyl" } as ScheduledTaskUpsertSchedule;
      yield* harness.publish(yield* reading(50));
      const refused = yield* harness.service.upsert(usageTask(typo)).pipe(Effect.flip);
      assert.include(refused.message, "weekyl");
      assert.include(refused.message, "seven_day");
      assert.include(refused.message, "weekly");
      assert.deepEqual((yield* harness.service.list()).tasks, []);

      // A changed trigger on a saved task, and a default instance moved by a model change.
      yield* harness.service.upsert(usageTask(ABOVE));
      yield* harness.service.upsert(usageTask(typo)).pipe(Effect.flip);
      const claude = ProviderInstanceId.make("claude");
      yield* harness.publish([
        providerWith(readingNow([weekly(50)])),
        providerWith(readingNow([weekly(50, { id: "five_hour", kind: "session" })]), {
          instanceId: claude,
        }),
      ]);
      const moved = yield* harness.service
        .upsert(usageTask(ABOVE, { modelSelection: { instanceId: claude, model: "fable" } }))
        .pipe(Effect.flip);
      assert.include(moved.message, "five_hour");
      assert.equal(scheduleOf(yield* harness.stored).window, "weekly");
    }),
  ),
);

it.effect("saving refuses an instance that reports no usage, and trusts no partial reading", () =>
  overMemory((harness) =>
    Effect.gen(function* () {
      yield* harness.publish([
        providerWith(makeUnavailableUsageLimits({ checkedAt: NOW, reason: "unsupported" })),
      ]);
      const refused = yield* harness.service.upsert(usageTask(ABOVE)).pipe(Effect.flip);
      assert.include(refused.message, "reports no usage windows");
      assert.deepEqual((yield* harness.service.list()).tasks, []);

      yield* harness.publish([
        providerWith({
          checkedAt: NOW,
          windows: [weekly(50, { id: "five_hour", kind: "session" })],
          unavailable: { reason: "probeFailed" },
        }),
      ]);
      const { task } = yield* harness.service.upsert(usageTask(ABOVE));
      assert.equal(scheduleOf(task).window, "weekly");
    }),
  ),
);

it.effect("a window can go away, or not be read yet, without stopping a save", () =>
  overMemory((harness) =>
    Effect.gen(function* () {
      // No readings yet: nothing to check it against.
      yield* harness.service.upsert(usageTask(ABOVE));
      yield* harness.publish([
        providerWith(readingNow([weekly(50, { id: "five_hour", kind: "session" })])),
      ]);
      // The window is gone now, and an unchanged trigger can still be renamed.
      const { task } = yield* harness.service.upsert(usageTask(ABOVE, { title: "Renamed" }));
      assert.equal(task.title, "Renamed");
    }),
  ),
);

it.effect("`below` fires once on an idle window's first real reading, through the real merge", () =>
  overMemory((harness) =>
    Effect.gen(function* () {
      const before = makeUsageLimits({ checkedAt: NOW, windows: [weekly(85)] });
      yield* harness.publish([providerWith(before)]);
      yield* harness.service.upsert(usageTask(BELOW));
      yield* harness.sweep;
      assert.deepEqual(scheduleOf(yield* harness.stored).state, { armed: true });

      // Claude's reading of an idle window: no usage and no reset time.
      const { resetsAt: _resetsAt, ...idle } = weekly(0);
      const idleAt = (checkedAt: string) => makeUsageLimits({ checkedAt, windows: [idle] });
      yield* thereFor("2026-09-09T17:10:00.000Z");
      const first = resolveUsageLimitsAfterProbe({
        published: before,
        probed: idleAt("2026-09-09T17:10:00.000Z"),
      });
      yield* harness.publish([providerWith(first)]);
      yield* harness.sweep;
      assert.deepEqual(yield* Ref.get(harness.sent), ["queue"]);

      yield* thereFor("2026-09-09T17:20:00.000Z");
      yield* harness.publish([
        providerWith(
          resolveUsageLimitsAfterProbe({
            published: first,
            probed: idleAt("2026-09-09T17:20:00.000Z"),
          }),
        ),
      ]);
      yield* harness.sweep;
      assert.deepEqual(yield* Ref.get(harness.sent), ["queue"]);
    }),
  ),
);

it.effect("a task whose named instance was removed can still be renamed, and fires nothing", () =>
  overMemory((harness) =>
    Effect.gen(function* () {
      const schedule = { ...ABOVE, instanceId: codex } as ScheduledTaskUpsertSchedule;
      yield* harness.publish([providerWith(undefined)]);
      yield* harness.service.upsert(usageTask(schedule));
      yield* harness.publish([]);
      const { task } = yield* harness.service.upsert(usageTask(schedule, { title: "Renamed" }));
      assert.equal(task.title, "Renamed");
      yield* harness.sweep;
      assert.deepEqual(yield* Ref.get(harness.sent), []);
    }),
  ),
);

it.effect("idle ticks stay idle: only a change, a write or a due reset wakes the sweep", () =>
  overMemory((harness) =>
    Effect.gen(function* () {
      const reads = Ref.get(harness.providerReads);
      yield* harness.sweep;
      const nothing = yield* reads;
      yield* harness.sweep;
      assert.equal(yield* reads, nothing, "no tasks, no change");

      yield* harness.service.upsert(usageTask(ABOVE));
      const saved = yield* reads;
      yield* harness.sweep;
      assert.equal(yield* reads, saved + 1, "a write wakes it");
      yield* harness.sweep;
      assert.equal(yield* reads, saved + 1);

      yield* harness.publish(yield* reading(50));
      yield* harness.sweep;
      assert.equal(yield* reads, saved + 2, "a change wakes it");
      // That sweep wrote `armed`; a state-only write wakes nothing and notifies nobody.
      assert.deepEqual(scheduleOf(yield* harness.stored).state, aboveState(true));
      yield* harness.sweep;
      assert.equal(yield* reads, saved + 2);
    }),
  ),
);

it.effect("the real scheduler's tick runs the sweep on the crossing a change announced", () =>
  thereFor(NOW).pipe(
    Effect.andThen(
      withUsage(
        (harness) =>
          Effect.gen(function* () {
            const entered = yield* Deferred.make<void>();
            yield* Ref.set(harness.sendGate, Deferred.succeed(entered, undefined));
            yield* harness.service.upsert(usageTask(ABOVE));
            yield* harness.publish(yield* reading(50));
            yield* TestClock.adjust("5 seconds");
            yield* harness.publish(yield* reading(90));
            yield* TestClock.adjust("5 seconds");
            yield* Deferred.await(entered);
            assert.deepEqual(yield* Ref.get(harness.sent), ["queue"]);
          }),
        undefined,
        Scheduler.layer,
      ),
    ),
    Effect.provide(SqlitePersistence.layerMemory),
  ),
);

it.effect("one malformed row does not stop the sweep for the rest", () =>
  overMemory((harness) =>
    Effect.gen(function* () {
      const { sql } = harness;
      yield* armedAbove(harness);
      yield* sql`INSERT INTO scheduled_tasks ${sql.insert({
        task_id: "task:broken",
        title: "task",
        prompt: "Run task",
        enabled: 1,
        schedule_json: "{not json",
        project_id: "project:test",
        thread_id: null,
        workspace_strategy_json: '{"type":"root"}',
        model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
        runtime_mode: "full-access",
        interaction_mode: "default",
        created_by: "user",
        creation_source: "web",
        created_at: NOW,
        updated_at: NOW,
        next_run_at: null,
        last_run_at: null,
        last_run_status: "never",
        last_run_error: null,
        run_count: 0,
      })}`;
      yield* settled(harness, 90);
      assert.deepEqual(yield* Ref.get(harness.sent), ["queue"]);
    }),
  ),
);
