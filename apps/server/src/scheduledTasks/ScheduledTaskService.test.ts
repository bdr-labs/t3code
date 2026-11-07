import * as Scheduler from "../scheduling/Scheduler.ts";
import * as NodeUtil from "node:util";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it, vi } from "@effect/vitest";
import {
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ScheduledTaskError,
  type ScheduledTask,
  ScheduledTaskId,
  type ScheduledTaskSchedule,
  type ServerProvider,
  ServerSettingsError,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as SqlClient from "effect/sql/SqlClient";

import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";
import * as Deferred from "effect/Deferred";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ScheduledTaskService from "./ScheduledTaskService.ts";
import * as ManagedPolicy from "../policy/ManagedPolicy.ts";
import { layerNewThreadModelTest, layerProvidersTest } from "./testLayers.ts";

const isScheduledTaskError = Schema.is(ScheduledTaskError);

const codex = ProviderInstanceId.make("codex");
const alternate = ProviderInstanceId.make("codex_alternate");
const threadOn = (instanceId: ProviderInstanceId, model = "gpt-5.4") => ({
  modelSelection: { instanceId, model },
});
const ordinaryRecords = {
  thread: threadOn(codex),
  runs: [],
  turnItems: [],
  providerSessions: [],
};
// A thread whose only run ended as `failure` says, as the orchestrator stores it.
const stoppedRecords = (input: {
  readonly failureClass?: string;
  readonly resetAt?: string | null;
  readonly threadInstance?: ProviderInstanceId;
  readonly threadModel?: string;
  readonly providerSessions?: ReadonlyArray<unknown>;
  readonly completedAt?: string;
}) => {
  const at = DateTime.makeUnsafe(input.completedAt ?? "2026-09-09T11:00:00.000Z");
  return {
    thread: threadOn(input.threadInstance ?? codex, input.threadModel),
    runs: [
      {
        id: "run:stopped",
        ordinal: 1,
        status: "failed",
        providerInstanceId: codex,
        modelSelection: threadOn(codex).modelSelection,
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
        failure: {
          class: input.failureClass ?? "usage_limit",
          message: "Plan limit reached.",
          ...(input.resetAt == null ? {} : { resetAt: input.resetAt }),
        },
      },
    ],
    providerSessions: input.providerSessions ?? [],
  };
};

const runningRecords = {
  ...ordinaryRecords,
  runs: [
    { ...stoppedRecords({}).runs[0], id: "run:running", status: "running", completedAt: null },
  ],
  turnItems: [],
};
// Still running, but stopping, so the orchestrator refuses a steer at dispatch.
const stoppingRecords = { ...runningRecords };

const insertRow = (
  sql: SqlClient.SqlClient,
  row: {
    id: string | null;
    next: string | null;
    enabled: number;
    status: string;
    scheduleJson?: string;
    prompt?: string;
  },
  now: string,
) =>
  sql`INSERT INTO scheduled_tasks ${sql.insert({
    task_id: row.id,
    title: "task",
    prompt: row.prompt ?? "Run task",
    enabled: row.enabled,
    schedule_json: row.scheduleJson ?? '{"type":"interval","everyMs":60000}',
    project_id: "project:test",
    thread_id: null,
    workspace_strategy_json: '{"type":"root"}',
    model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
    runtime_mode: "full-access",
    interaction_mode: "default",
    created_by: "user",
    creation_source: "web",
    created_at: now,
    updated_at: now,
    next_run_at: row.next,
    last_run_at: null,
    last_run_status: row.status,
    last_run_error: null,
    run_count: 0,
  })}`;

it.effect("loads only due tasks and skips corrupt due rows without decoding settled tasks", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const now = "2026-09-09T12:00:00.000Z";
    const secret = "PROMPT-SECRET-DO-NOT-LOG";
    const credential = "CREDENTIAL-SECRET-DO-NOT-LOG";
    for (const row of [
      { id: "due-now", next: now, enabled: 1, status: "never" },
      { id: "", next: now, enabled: 1, status: "never" },
      { id: "   ", next: now, enabled: 1, status: "never" },
      { id: null, next: now, enabled: 1, status: "never" },
      {
        id: "due-earlier",
        next: "2026-09-09T11:00:00.000Z",
        enabled: 1,
        status: "failed",
      },
      { id: "due-bad-date", next: "", enabled: 1, status: "never" },
      {
        id: "due-corrupt",
        next: now,
        enabled: 1,
        status: "never",
        scheduleJson: "broken",
      },
      {
        id: "due-cred",
        next: now,
        enabled: 1,
        status: "never",
        scheduleJson: `{"type":"interval","everyMs":"${credential}"}`,
      },
      { id: "disabled", next: now, enabled: 0, status: "never", scheduleJson: "broken" },
      {
        id: "future",
        next: "2026-09-09T12:00:00.001Z",
        enabled: 1,
        status: "never",
        scheduleJson: "broken",
      },
      {
        id: "unscheduled",
        next: null,
        enabled: 1,
        status: "never",
        scheduleJson: "broken",
      },
      { id: "running", next: now, enabled: 1, status: "running", scheduleJson: "broken" },
    ]) {
      yield* insertRow(sql, { ...row, prompt: secret }, now);
    }
    const warnings: unknown[] = [];
    const tasks = yield* ScheduledTaskService.listDueTasks(DateTime.makeUnsafe(now)).pipe(
      Effect.provide(
        Logger.layer([
          Logger.make(({ message }) => {
            warnings.push(message);
          }),
        ]),
      ),
    );
    assert.deepEqual(
      tasks.map((task) => task.id),
      ["due-earlier", "due-now"],
    );
    assert.equal(warnings.length, 6);
    const annotations = warnings.map(
      (warning) => (warning as ReadonlyArray<unknown>)[1] as Record<string, unknown>,
    );
    assert.deepEqual(
      annotations.map((annotation) => annotation.taskId),
      ["due-bad-date", null, "", "   ", "due-corrupt", "due-cred"],
    );
    const causes = annotations.map((annotation) => annotation.cause);
    assert.deepEqual(
      causes.map((cause) => (isScheduledTaskError(cause) ? cause.taskId : undefined)),
      [undefined, undefined, undefined, undefined, "due-corrupt", "due-cred"],
    );
    for (const cause of causes) {
      if (cause !== undefined) assert.isTrue(isScheduledTaskError(cause));
    }
    const rendered = NodeUtil.inspect(annotations, { depth: null });
    assert.isFalse(rendered.includes(secret));
    assert.isFalse(rendered.includes(credential));
    const running = yield* sql<{
      last_run_status: string;
    }>`SELECT last_run_status FROM scheduled_tasks WHERE task_id = 'running'`;
    assert.equal(running[0]?.last_run_status, "running");
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "releases interrupted runs on startup and still executes due tasks, skipping corrupt rows",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-09T12:00:00.000Z";
      const hugeInterval = '{"type":"interval","everyMs":9000000000000000}';
      for (const row of [
        { id: "stuck-valid", next: now, status: "running" },
        { id: "stuck-corrupt", next: now, status: "running", scheduleJson: "broken" },
        { id: "stuck-huge", next: now, status: "running", scheduleJson: hugeInterval },
        { id: null, next: now, status: "running" },
        { id: "due-bad-date", next: "", status: "never" },
        { id: "due-healthy", next: now, status: "never" },
        { id: "due-huge", next: now, status: "never", scheduleJson: hugeInterval },
        { id: "due-second", next: now, status: "never" },
        { id: "due-third", next: now, status: "never" },
      ]) {
        yield* insertRow(sql, { ...row, enabled: 1 }, now);
      }

      yield* TestClock.setTime(Date.parse(now) + 1_000);
      const dispatched = yield* Ref.make(0);
      const lastDispatched = yield* Deferred.make<void>();
      const releaseLast = yield* Deferred.make<void>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            Layer.provideMerge(
              ScheduledTaskService.layer,
              Layer.mergeAll(
                ManagedPolicy.layerTest(),
                Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                  launch: () =>
                    Ref.updateAndGet(dispatched, (n) => n + 1).pipe(
                      Effect.andThen((n) =>
                        n === 4
                          ? Deferred.succeed(lastDispatched, undefined).pipe(
                              Effect.andThen(Deferred.await(releaseLast)),
                            )
                          : Effect.void,
                      ),
                      Effect.andThen(Effect.die(new Error("test launch failure"))),
                    ),
                }),
                Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                  namedProjectsRoot: "/projects",
                  isScratchProject: () => Effect.succeed(false),
                }),
                Layer.mock(ThreadManagementService.ThreadManagementService)({}),
                Layer.mock(SecretRequests.SecretRequests)({}),
                layerNewThreadModelTest,
                NodeCrypto.layer,
                Scheduler.layer,
              ),
            ),
          );
          // The poll delays before its first pass; advance the frozen clock once.
          yield* TestClock.adjust("6 seconds");
          yield* Deferred.await(lastDispatched);
          const inflight = yield* sql<{
            last_run_status: string;
          }>`SELECT last_run_status FROM scheduled_tasks WHERE task_id = 'due-third'`;
          assert.equal(inflight[0]?.last_run_status, "running");
          yield* Deferred.succeed(releaseLast, undefined);
        }),
      );

      const rows = yield* sql<{
        task_id: string | null;
        last_run_status: string;
        last_run_error: string | null;
        next_run_at: string | null;
        run_count: number;
      }>`SELECT task_id, last_run_status, last_run_error, next_run_at, run_count
       FROM scheduled_tasks ORDER BY task_id`;
      const byId = new Map(rows.map((row) => [row.task_id, row]));
      assert.equal(rows.length, 9);
      assert.equal(byId.get("stuck-valid")?.last_run_status, "failed");
      assert.isNotNull(byId.get("stuck-valid")?.next_run_at);
      assert.equal(byId.get("stuck-corrupt")?.last_run_status, "failed");
      assert.equal(byId.get(null)?.last_run_status, "failed");
      const stuckHuge = byId.get("stuck-huge");
      assert.equal(stuckHuge?.last_run_status, "failed");
      assert.isNull(stuckHuge?.next_run_at);
      for (const id of ["stuck-valid", "stuck-corrupt", "stuck-huge", null]) {
        const row = byId.get(id);
        assert.equal(row?.last_run_error, "Run was interrupted by a server restart.");
        assert.equal(row?.run_count, 1);
      }
      for (const id of ["due-healthy", "due-huge", "due-second"]) {
        const row = byId.get(id);
        assert.equal(row?.last_run_status, "failed");
        assert.isTrue(row?.last_run_error?.includes("test launch failure") === true);
        assert.equal(row?.run_count, 1);
      }
      assert.isNull(byId.get("due-huge")?.next_run_at);
      assert.equal(byId.get("due-bad-date")?.last_run_status, "never");
      assert.equal(byId.get("due-bad-date")?.run_count, 0);
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect(
  "treats a next_run_at corrupted before the dispatch re-read as not due instead of defecting the poll",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const now = "2026-09-09T12:00:00.000Z";
      for (const row of [
        { id: "run-a", next: now, status: "never" },
        { id: "run-b-victim", next: now, status: "never" },
        { id: "run-c", next: now, status: "never" },
        { id: "run-d", next: now, status: "never" },
      ]) {
        yield* insertRow(sql, { ...row, enabled: 1 }, now);
      }
      yield* TestClock.setTime(Date.parse(now) + 1_000);
      const dispatched = yield* Ref.make(0);
      const lastDispatched = yield* Deferred.make<void>();
      const releaseLast = yield* Deferred.make<void>();
      yield* Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            Layer.provideMerge(
              ScheduledTaskService.layer,
              Layer.mergeAll(
                ManagedPolicy.layerTest(),
                Layer.mock(ThreadLaunchService.ThreadLaunchService)({
                  launch: () =>
                    Ref.updateAndGet(dispatched, (n) => n + 1).pipe(
                      Effect.andThen((n) =>
                        n === 1
                          ? sql`UPDATE scheduled_tasks
                                SET next_run_at = ''
                                WHERE task_id = 'run-b-victim'`.pipe(Effect.asVoid, Effect.orDie)
                          : n === 3
                            ? Deferred.succeed(lastDispatched, undefined).pipe(
                                Effect.andThen(Deferred.await(releaseLast)),
                              )
                            : Effect.void,
                      ),
                      Effect.andThen(Effect.die(new Error("test launch failure"))),
                    ),
                }),
                Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
                  namedProjectsRoot: "/projects",
                  isScratchProject: () => Effect.succeed(false),
                }),
                Layer.mock(ThreadManagementService.ThreadManagementService)({}),
                Layer.mock(SecretRequests.SecretRequests)({}),
                layerNewThreadModelTest,
                NodeCrypto.layer,
                Scheduler.layer,
              ),
            ),
          );
          yield* TestClock.adjust("6 seconds");
          yield* Deferred.await(lastDispatched);
          assert.equal(yield* Ref.get(dispatched), 3);
          const rows = yield* sql<{
            task_id: string;
            last_run_status: string;
            next_run_at: string | null;
            run_count: number;
          }>`SELECT task_id, last_run_status, next_run_at, run_count
             FROM scheduled_tasks ORDER BY task_id`;
          const byId = new Map(rows.map((row) => [row.task_id, row]));
          const victim = byId.get("run-b-victim");
          assert.equal(victim?.last_run_status, "never");
          assert.equal(victim?.run_count, 0);
          assert.equal(victim?.next_run_at, "");
          for (const id of ["run-a", "run-c"]) {
            const row = byId.get(id);
            assert.equal(row?.last_run_status, "failed");
            assert.equal(row?.run_count, 1);
          }
          yield* Deferred.succeed(releaseLast, undefined);
        }),
      );
    }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("thread cleanup notifies subscribers and a finishing run cannot recreate the task", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const subscribed = yield* Deferred.make<void>();
    const running = yield* Deferred.make<void>();
    const removed = yield* Deferred.make<void>();
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(ordinaryRecords as never),
            sendToThread: () =>
              Deferred.succeed(started, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(Effect.die("test dispatch failure")),
              ),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          layerNewThreadModelTest,
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const threadId = ThreadId.make("thread:deleted-during-run");
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:deleted-during-run"),
        title: "Check orchestration",
        prompt: "Check progress",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        threadId,
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      yield* service.subscribeList().pipe(
        Stream.runForEach(({ tasks }) => {
          const current = tasks.find((candidate) => candidate.id === task.id);
          if (current === undefined) return Deferred.succeed(removed, undefined);
          return current.lastRunStatus === "running"
            ? Deferred.succeed(running, undefined)
            : Deferred.succeed(subscribed, undefined);
        }),
        Effect.forkChild,
      );
      yield* Deferred.await(subscribed);
      const run = yield* service.runNow({ id: task.id }).pipe(Effect.forkChild);
      yield* Deferred.await(started);
      yield* Deferred.await(running);
      const refused = yield* service.runNow({ id: task.id }).pipe(Effect.flip);
      assert.equal(refused.message, "Schedule task is already running.");
      yield* service.deleteForThread(threadId);
      yield* Deferred.await(removed);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(run);
      assert.lengthOf((yield* service.list()).tasks, 0);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a bound run follows its thread when promotion moves it mid-send", () =>
  Effect.gen(function* () {
    const scratch = ProjectId.make("project:scratch");
    const promoted = ProjectId.make("project:promoted");
    const sends = yield* Ref.make<Array<{ projectId: ProjectId; commandId: string }>>([]);
    // Rebind lands first, then the promotion commits between the shell read and the retry.
    const shellProjects = yield* Ref.make([scratch, promoted]);
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadRecords: () => Effect.succeed(ordinaryRecords as never),
            sendToThread: (input) =>
              Ref.updateAndGet(sends, (all) => [
                ...all,
                { projectId: input.projectId, commandId: input.commandId },
              ]).pipe(
                Effect.flatMap((all) =>
                  all.length < 3
                    ? Effect.fail(
                        new ThreadManagementService.ThreadManagementThreadNotFoundError({
                          projectId: input.projectId,
                          threadId: input.threadId,
                        }),
                      )
                    : Effect.succeed({} as never),
                ),
              ),
            getThreadShell: () =>
              Ref.modify(shellProjects, ([next, ...rest]) => [
                { projectId: next ?? promoted } as never,
                rest,
              ]),
          }),
          Layer.mock(SecretRequests.SecretRequests)({}),
          layerNewThreadModelTest,
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const threadId = ThreadId.make("thread:promoted-during-run");
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:promoted-during-run"),
        title: "Check in",
        prompt: "Check progress",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: promoted,
        threadId,
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });

      const result = yield* service.runNow({ id: task.id });

      assert.equal(result.threadId, threadId);
      const attempts = yield* Ref.get(sends);
      assert.deepEqual(
        attempts.map((attempt) => attempt.projectId),
        [promoted, scratch, promoted],
      );
      assert.equal(new Set(attempts.map((attempt) => attempt.commandId)).size, 1);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("refuses saving an enabled task above the policy ceiling", () =>
  Effect.gen(function* () {
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest({
            schemaVersion: 1,
            organization: "Example Corp",
            limits: { maxRuntimeMode: "auto-accept-edits" },
          }),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({}),
          Layer.mock(ThreadManagementService.ThreadManagementService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          layerNewThreadModelTest,
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Scheduler.layer,
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const save = (enabled: boolean) =>
        service.upsert({
          id: ScheduledTaskId.make("task:above-ceiling"),
          title: "Nightly",
          prompt: "Check progress",
          enabled,
          schedule: { type: "interval", everyMs: 60_000 },
          projectId: ProjectId.make("project:test"),
          workspaceStrategy: { type: "root" },
          modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
          runtimeMode: "full-access",
          interactionMode: "default",
        });
      const refused = yield* save(true).pipe(Effect.flip);
      assert.equal(refused.message, "Example Corp limits threads to Auto-accept edits.");
      assert.lengthOf((yield* service.list()).tasks, 0);
      // A disabled task does not run, so it can still be saved.
      yield* save(false);
      assert.lengthOf((yield* service.list()).tasks, 1);
      // Nor can it be switched back on while its mode is above the ceiling.
      const reenabled = yield* service
        .setEnabled({ id: ScheduledTaskId.make("task:above-ceiling"), enabled: true })
        .pipe(Effect.flip);
      assert.equal(reenabled.message, "Example Corp limits threads to Auto-accept edits.");
      // A task bound to a thread runs in that thread's mode, so its own is not checked.
      yield* service.upsert({
        id: ScheduledTaskId.make("task:bound"),
        title: "Follow up",
        prompt: "Check progress",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        threadId: ThreadId.make("thread:bound"),
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a run interrupted right after it reserves the task does not block the next run", () =>
  Effect.gen(function* () {
    const launches = yield* Ref.make(0);
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          ManagedPolicy.layerTest(),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: () =>
              Ref.update(launches, (n) => n + 1).pipe(
                Effect.as({ threadId: ThreadId.make("thread:launched"), resumed: false } as never),
              ),
          }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({}),
          Layer.mock(SecretRequests.SecretRequests)({}),
          layerNewThreadModelTest,
          Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
            namedProjectsRoot: "/projects",
            isScratchProject: () => Effect.succeed(false),
          }),
          NodeCrypto.layer,
          Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:interrupted-reservation"),
        title: "Check in",
        prompt: "Check progress",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        workspaceStrategy: { type: "root" },
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
        runtimeMode: "full-access",
        interactionMode: "default",
      });

      // The reservation is the first Set.add of the task id; interrupt the run right there.
      const add = Set.prototype.add;
      let interrupted = false;
      const first = yield* Effect.gen(function* () {
        using _reserve = vi.spyOn(Set.prototype, "add").mockImplementation(function (
          this: Set<unknown>,
          value: unknown,
        ) {
          const result = add.call(this, value);
          if (value === task.id && !interrupted) {
            interrupted = true;
            Fiber.getCurrent()?.interruptUnsafe();
          }
          return result;
        });
        return yield* service
          .runNow({ id: task.id })
          .pipe(Effect.forkChild, Effect.flatMap(Fiber.await));
      });
      assert.isTrue(interrupted);
      assert.isTrue(Exit.hasInterrupts(first));

      const second = yield* service.runNow({ id: task.id });
      assert.equal(second.threadId, ThreadId.make("thread:launched"));
      assert.equal(yield* Ref.get(launches), 1);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

const FIRE_AT = "2026-09-09T12:00:00.000Z";
const RESET_AT = "2026-09-09T15:00:00.000Z";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;
const later = (at: string, ms: number) =>
  DateTime.formatIso(DateTime.addDuration(DateTime.makeUnsafe(at), ms));

const taskDependencies = Layer.mergeAll(
  ManagedPolicy.layerTest(),
  Layer.mock(SecretRequests.SecretRequests)({}),
  Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
    namedProjectsRoot: "/projects",
    isScratchProject: () => Effect.succeed(false),
  }),
  NodeCrypto.layer,
);

type Fires = {
  readonly service: ScheduledTaskService.ScheduledTaskService["Service"];
  // One pass of the real due-task worker, at whatever the clock says.
  readonly sweep: Effect.Effect<void>;
  // Every send's mode, and "launch" for a fresh thread.
  readonly sent: Ref.Ref<ReadonlyArray<string>>;
  readonly records: Ref.Ref<unknown>;
  readonly stored: Effect.Effect<ScheduledTask>;
};

// One service over a mock thread; a second call on the same database is a restart.
const withFires = <A, E>(
  body: (fires: Fires) => Effect.Effect<A, E>,
  state?: Pick<Fires, "sent" | "records">,
  providers = layerNewThreadModelTest,
) =>
  Effect.gen(function* () {
    const sent = state?.sent ?? (yield* Ref.make<ReadonlyArray<string>>([]));
    const records = state?.records ?? (yield* Ref.make<unknown>(ordinaryRecords));
    const workers = new Map<string, Effect.Effect<void>>();
    const rejected = new Set<string>();
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          taskDependencies,
          providers,
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
            getThreadRecords: () =>
              Ref.get(records).pipe(
                Effect.flatMap((value) =>
                  value === "unreadable"
                    ? Effect.fail("unreadable" as never)
                    : Effect.succeed(value as never),
                ),
              ),
            // A steer reaches only a running turn, as the real service checks. A stopping
            // turn refuses it at dispatch, and its command id stays rejected.
            sendToThread: (input) =>
              Effect.gen(function* () {
                const value = yield* Ref.get(records);
                if (rejected.has(input.commandId)) {
                  return yield* new Orchestrator.OrchestratorCommandPreviouslyRejectedError({
                    commandId: input.commandId,
                    commandType: "message.dispatch",
                    detail: "Previously rejected.",
                  });
                }
                if (input.mode === "steer" && value === stoppingRecords) {
                  rejected.add(input.commandId);
                  return yield* new Orchestrator.OrchestratorDispatchError({
                    commandId: input.commandId,
                    commandType: "message.dispatch",
                    cause: "Target run run:running is stopping and cannot be steered.",
                  });
                }
                if (input.mode === "steer" && value !== runningRecords) {
                  return yield* new ThreadManagementService.ThreadManagementNoSteerableRunError({
                    threadId: input.threadId,
                    mode: "steer",
                  });
                }
                yield* Ref.update(sent, (all) => [...all, input.mode]);
                return { delivery: "started" } as never;
              }),
          }),
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      return yield* body({
        service,
        sweep: workers.get("scheduled-tasks")!,
        sent,
        records,
        stored: service.list().pipe(
          Effect.map(({ tasks }) => tasks[0]!),
          Effect.orDie,
        ),
      });
    }).pipe(Effect.provide(layer));
  });

const TASK_ID = ScheduledTaskId.make("task:bound-fire");
const boundTask = (
  schedule: ScheduledTaskSchedule,
  overrides: { readonly title?: string; readonly threadId?: ThreadId | null } = {},
) => ({
  id: TASK_ID,
  title: overrides.title ?? "Check in",
  prompt: "Check progress",
  enabled: true,
  schedule,
  projectId: ProjectId.make("project:test"),
  ...(overrides.threadId === null
    ? {}
    : { threadId: overrides.threadId ?? ThreadId.make("thread:bound-fire") }),
  workspaceStrategy: { type: "root" as const },
  modelSelection: { instanceId: codex, model: "gpt-5.4" },
  runtimeMode: "full-access" as const,
  interactionMode: "default" as const,
});

const startClock = TestClock.setTime(Date.parse(FIRE_AT));
const firesOverMemory = <A, E>(body: (fires: Fires) => Effect.Effect<A, E>) =>
  startClock.pipe(Effect.andThen(withFires(body)), Effect.provide(SqlitePersistence.layerMemory));

// Saves the task and lets it come due on a thread stopped until `resetIn` later.
const postponed = (fires: Fires, schedule: ScheduledTaskSchedule, resetIn = 3 * HOUR_MS) =>
  Effect.gen(function* () {
    const { task } = yield* fires.service.upsert(boundTask(schedule));
    const dueAt = task.nextRunAt!;
    const resetAt = later(dueAt, resetIn);
    yield* Ref.set(fires.records, stoppedRecords({ resetAt }));
    yield* TestClock.setTime(Date.parse(dueAt));
    yield* fires.sweep;
    return { dueAt, resetAt };
  });

const INTERVAL = { type: "interval", everyMs: HOUR_MS } as const;
const FIXED_TIME = { type: "fixed_time", timeOfDay: "13:17" } as const;
const ONCE = { type: "once", runAt: "2026-09-09T13:00:00.000Z" } as const;
// Long enough that the reset in postponed() comes first.
const LONG_INTERVAL = { type: "interval", everyMs: DAY_MS } as const;

it.effect.each([
  ["interval", INTERVAL],
  ["fixed_time", FIXED_TIME],
  ["once", ONCE],
] as const)(
  "%s: a stopped thread gets nothing until the reset, then one fire",
  ([type, schedule]) =>
    firesOverMemory((fires) =>
      Effect.gen(function* () {
        const { resetAt } = yield* postponed(fires, schedule);
        let held = yield* fires.stored;
        for (let check = 0; Date.parse(held.nextRunAt!) < Date.parse(resetAt); check++) {
          assert.isBelow(check, 5);
          yield* TestClock.setTime(Date.parse(held.nextRunAt!));
          yield* fires.sweep;
          held = yield* fires.stored;
        }
        assert.deepEqual(yield* Ref.get(fires.sent), []);
        assert.equal(held.lastRunStatus, "failed");
        assert.match(held.lastRunError ?? "", /usage limit/);
        assert.include(held.lastRunError ?? "", resetAt);
        assert.include(held.lastRunError ?? "", "then or at its next run");
        assert.equal(held.nextRunAt, resetAt);
        // Nothing ran, so it does not count as one.
        assert.equal(held.runCount, 0);

        yield* TestClock.setTime(Date.parse(resetAt) - 1);
        yield* fires.sweep;
        assert.deepEqual(yield* Ref.get(fires.sent), []);

        yield* TestClock.setTime(Date.parse(resetAt));
        yield* fires.sweep;
        yield* fires.sweep;
        assert.deepEqual(yield* Ref.get(fires.sent), ["queue"]);
        const fired = yield* fires.stored;
        assert.equal(fired.lastRunStatus, "succeeded");
        assert.isNull(fired.lastRunError);
        assert.equal(fired.runCount, 1);
        if (type === "once") assert.isNull(fired.nextRunAt);
        else assert.isAbove(Date.parse(fired.nextRunAt!), Date.parse(resetAt));
      }),
    ),
);

it.effect.each([
  ["an interval before the reset", INTERVAL, 3 * HOUR_MS, HOUR_MS],
  [
    "an interval past the reset",
    { type: "interval", everyMs: 5 * HOUR_MS },
    3 * HOUR_MS,
    3 * HOUR_MS,
  ],
  ["a fixed time before the reset", FIXED_TIME, 2 * DAY_MS, DAY_MS],
  ["a fixed time past the reset", FIXED_TIME, 3 * HOUR_MS, 3 * HOUR_MS],
  ["a once, which only has the reset", ONCE, 3 * HOUR_MS, 3 * HOUR_MS],
] as const)("the next run re-checks at the earlier time: %s", ([, schedule, resetIn, nextIn]) =>
  firesOverMemory((fires) =>
    Effect.gen(function* () {
      const { dueAt } = yield* postponed(fires, schedule, resetIn);
      assert.equal((yield* fires.stored).nextRunAt, later(dueAt, nextIn));
    }),
  ),
);

it.effect("an interval does not pile up across the periods it was postponed over", () =>
  firesOverMemory((fires) =>
    Effect.gen(function* () {
      const { dueAt, resetAt } = yield* postponed(fires, { type: "interval", everyMs: 900_000 });
      for (let at = Date.parse(dueAt) + 900_000; at < Date.parse(resetAt); at += 900_000) {
        yield* TestClock.setTime(at);
        yield* fires.sweep;
      }
      assert.deepEqual(yield* Ref.get(fires.sent), []);
      assert.equal((yield* fires.stored).nextRunAt, resetAt);
      assert.equal((yield* fires.stored).runCount, 0);

      // The server slept past the reset: still one fire, then the ordinary period.
      const wake = later(resetAt, 2 * HOUR_MS);
      yield* TestClock.setTime(Date.parse(wake));
      yield* fires.sweep;
      yield* fires.sweep;
      assert.deepEqual(yield* Ref.get(fires.sent), ["queue"]);
      assert.equal((yield* fires.stored).nextRunAt, later(wake, 900_000));
    }),
  ),
);

it.effect.each([
  [
    "moved to another provider",
    INTERVAL,
    stoppedRecords({ resetAt: RESET_AT, threadInstance: alternate }),
  ],
  ["resumed", INTERVAL, ordinaryRecords],
  [
    "moved to another provider",
    FIXED_TIME,
    stoppedRecords({ resetAt: "2026-09-12T00:00:00.000Z", threadInstance: alternate }),
  ],
  ["resumed", FIXED_TIME, ordinaryRecords],
] as const)("a thread %s after a postponement fires at the next period", ([, schedule, records]) =>
  firesOverMemory((fires) =>
    Effect.gen(function* () {
      const { dueAt } = yield* postponed(fires, schedule, 2 * DAY_MS);
      const held = yield* fires.stored;
      assert.isBelow(Date.parse(held.nextRunAt!), Date.parse(dueAt) + 2 * DAY_MS);
      yield* Ref.set(fires.records, records);
      yield* TestClock.setTime(Date.parse(held.nextRunAt!));
      yield* fires.sweep;
      assert.deepEqual(yield* Ref.get(fires.sent), ["queue"]);
      const fired = yield* fires.stored;
      assert.equal(fired.lastRunStatus, "succeeded");
      assert.isNull(fired.lastRunError);
    }),
  ),
);

it.effect.each([
  ["off its slots", 3 * HOUR_MS],
  ["exactly on its next slot", DAY_MS],
] as const)("a fixed-time fire with a reset %s still fires on a late sweep", ([, resetIn]) =>
  firesOverMemory((fires) =>
    Effect.gen(function* () {
      const { resetAt } = yield* postponed(fires, FIXED_TIME, resetIn);
      assert.equal((yield* fires.stored).nextRunAt, resetAt);
      yield* TestClock.setTime(Date.parse(resetAt) + 30 * 60_000);
      yield* fires.sweep;
      assert.deepEqual(yield* Ref.get(fires.sent), ["queue"]);
      assert.equal((yield* fires.stored).lastRunStatus, "succeeded");
    }),
  ),
);

it.effect.each([
  ["a slot nothing postponed", (_sql: SqlClient.SqlClient, _dueAt: string) => Effect.void],
  [
    // What a machine time-zone change leaves behind: a due time off this zone's slots.
    "a time off this zone's slots that nothing postponed",
    (sql: SqlClient.SqlClient, dueAt: string) =>
      sql`UPDATE scheduled_tasks SET next_run_at = ${later(dueAt, 3 * HOUR_MS)}`.pipe(
        Effect.asVoid,
        Effect.orDie,
      ),
  ],
  [
    "a slot after a failure of another kind",
    (sql: SqlClient.SqlClient, _dueAt: string) =>
      sql`UPDATE scheduled_tasks SET last_run_status = 'failed', last_run_error = 'Sign in again.'`.pipe(
        Effect.asVoid,
        Effect.orDie,
      ),
  ],
] as const)("an ordinary missed run is still skipped: %s", ([, prepare]) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* startClock;
    yield* withFires((fires) =>
      Effect.gen(function* () {
        const { task } = yield* fires.service.upsert(boundTask(FIXED_TIME));
        yield* prepare(sql, task.nextRunAt!);
        const dueAt = (yield* fires.stored).nextRunAt!;
        const wake = Date.parse(dueAt) + 30 * 60_000;
        yield* TestClock.setTime(wake);
        yield* fires.sweep;
        assert.deepEqual(yield* Ref.get(fires.sent), []);
        assert.isAbove(Date.parse((yield* fires.stored).nextRunAt!), wake);
      }),
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a slot that came before the reset is skipped like any missed slot", () =>
  firesOverMemory((fires) =>
    Effect.gen(function* () {
      yield* postponed(fires, FIXED_TIME, 2 * DAY_MS);
      const slot = (yield* fires.stored).nextRunAt!;
      const wake = Date.parse(slot) + 30 * 60_000;
      yield* TestClock.setTime(wake);
      yield* fires.sweep;
      assert.deepEqual(yield* Ref.get(fires.sent), []);
      assert.isAbove(Date.parse((yield* fires.stored).nextRunAt!), wake);
    }),
  ),
);

it.effect("a once survives a postponement, a restart and a second postponement", () =>
  Effect.gen(function* () {
    yield* startClock;
    const sent = yield* Ref.make<ReadonlyArray<string>>([]);
    const records = yield* Ref.make<unknown>(ordinaryRecords);
    const { resetAt } = yield* withFires((fires) => postponed(fires, ONCE), { sent, records });
    const secondReset = later(resetAt, 5 * HOUR_MS);
    yield* withFires(
      (fires) =>
        Effect.gen(function* () {
          assert.equal((yield* fires.stored).nextRunAt, resetAt);
          // A fresh limit on the retried thread moves it again instead of using it up.
          yield* Ref.set(records, stoppedRecords({ resetAt: secondReset }));
          yield* TestClock.setTime(Date.parse(resetAt));
          yield* fires.sweep;
          assert.equal((yield* fires.stored).nextRunAt, secondReset);
          assert.deepEqual(yield* Ref.get(sent), []);

          yield* TestClock.setTime(Date.parse(secondReset));
          yield* fires.sweep;
          assert.deepEqual(yield* Ref.get(sent), ["queue"]);
          const fired = yield* fires.stored;
          assert.equal(fired.lastRunStatus, "succeeded");
          assert.isNull(fired.nextRunAt);
        }),
      { sent, records },
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a reset reported with an offset is stored so the text-compared sweep finds it", () =>
  firesOverMemory((fires) =>
    Effect.gen(function* () {
      const { task } = yield* fires.service.upsert(boundTask(ONCE));
      yield* Ref.set(fires.records, stoppedRecords({ resetAt: "2026-09-09T16:00:00+01:00" }));
      yield* TestClock.setTime(Date.parse(task.nextRunAt!));
      yield* fires.sweep;
      assert.equal((yield* fires.stored).nextRunAt, RESET_AT);
      yield* TestClock.setTime(Date.parse(RESET_AT));
      yield* fires.sweep;
      assert.deepEqual(yield* Ref.get(fires.sent), ["queue"]);
    }),
  ),
);

it.effect.each([
  ["interval", INTERVAL, 3],
  ["fixed_time", FIXED_TIME, 3],
  ["once", ONCE, 1],
] as const)("%s: a limit with no reset time sends every period", ([, schedule, fires_]) =>
  firesOverMemory((fires) =>
    Effect.gen(function* () {
      yield* fires.service.upsert(boundTask(schedule));
      yield* Ref.set(fires.records, stoppedRecords({ resetAt: null }));
      for (let fired = 1; fired <= fires_; fired++) {
        yield* TestClock.setTime(Date.parse((yield* fires.stored).nextRunAt!));
        yield* fires.sweep;
        assert.lengthOf(yield* Ref.get(fires.sent), fired);
        const stored = yield* fires.stored;
        assert.equal(stored.lastRunStatus, "succeeded");
        assert.isNull(stored.lastRunError);
      }
      assert.deepEqual([...new Set(yield* Ref.get(fires.sent))], ["queue"]);
      if (schedule.type === "once") assert.isNull((yield* fires.stored).nextRunAt);
    }),
  ),
);

// The interval task below comes due at 13:00.
it.effect.each([
  ["an idle thread", ordinaryRecords],
  [
    "a running thread",
    {
      ...ordinaryRecords,
      runs: [
        {
          id: "run:live",
          ordinal: 1,
          status: "running",
          startedAt: DateTime.makeUnsafe(FIRE_AT),
          completedAt: null,
        },
      ],
    },
  ],
  ["a thread that failed for another reason", stoppedRecords({ failureClass: "provider_error" })],
  ["a limit with no reset time", stoppedRecords({ resetAt: null })],
  ["a reset that has passed", stoppedRecords({ resetAt: "2026-09-09T12:30:00.000Z" })],
  [
    "a reset that was stale when the run failed",
    stoppedRecords({ resetAt: "2026-09-09T10:59:00.000Z" }),
  ],
  [
    // Still ahead of this fire, so only the comparison with the failure lets it send.
    "a stale reset ahead of the clock",
    stoppedRecords({
      resetAt: "2026-09-09T13:30:00.000Z",
      completedAt: "2026-09-09T14:00:00.000Z",
    }),
  ],
  [
    "a reset exactly when the run failed",
    stoppedRecords({
      resetAt: "2026-09-09T14:00:00.000Z",
      completedAt: "2026-09-09T14:00:00.000Z",
    }),
  ],
  [
    "a thread moved to another provider",
    stoppedRecords({ resetAt: RESET_AT, threadInstance: alternate }),
  ],
  [
    "a thread whose session has since failed differently",
    stoppedRecords({
      resetAt: RESET_AT,
      providerSessions: [
        {
          providerInstanceId: codex,
          updatedAt: DateTime.makeUnsafe(FIRE_AT),
          lastError: "Sign in again.",
        },
      ],
    }),
  ],
  ["a thread that cannot be read", "unreadable"],
] as const)("a fire on %s is an ordinary one", ([, records]) =>
  firesOverMemory((fires) =>
    Effect.gen(function* () {
      const { task } = yield* fires.service.upsert(boundTask(INTERVAL));
      yield* Ref.set(fires.records, records);
      yield* TestClock.setTime(Date.parse(task.nextRunAt!));
      yield* fires.sweep;
      assert.deepEqual(yield* Ref.get(fires.sent), ["queue"]);
      const stored = yield* fires.stored;
      assert.equal(stored.lastRunStatus, "succeeded");
      assert.isNull(stored.lastRunError);
      assert.equal(stored.nextRunAt, later(task.nextRunAt!, HOUR_MS));
    }),
  ),
);

const exhaustedOn = (instanceId: ProviderInstanceId) =>
  Effect.succeed([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: FIRE_AT,
      models: [],
      slashCommands: [],
      skills: [],
      usageLimits: {
        checkedAt: FIRE_AT,
        windows: [
          {
            id: "seven_day",
            kind: "weekly",
            label: "Weekly",
            usedPercent: 100,
            resetsAt: RESET_AT,
          },
        ],
      },
    } satisfies ServerProvider,
  ]);

// The limit was seen on codex's gpt-5.4; only a window of the thread's new instance that binds its
// new model holds the fire.
it.effect.each([
  ["a model whose provider has room", codex, Effect.succeed([]), ["queue"]],
  ["a model whose provider cannot be read", codex, Effect.die("unreadable"), ["queue"]],
  ["a model whose provider reads its weekly at 100", codex, exhaustedOn(codex), []],
  ["another provider that reads its own weekly at 100", alternate, exhaustedOn(alternate), []],
  [
    "another provider while only the stopped one reads at 100",
    alternate,
    exhaustedOn(codex),
    ["queue"],
  ],
] as const)("a fire on a thread moved to %s", ([, threadInstance, providers, sent]) =>
  startClock.pipe(
    Effect.andThen(
      withFires(
        (fires) =>
          Effect.gen(function* () {
            const { task } = yield* fires.service.upsert(boundTask(INTERVAL));
            yield* Ref.set(
              fires.records,
              stoppedRecords({ resetAt: RESET_AT, threadInstance, threadModel: "gpt-5.5" }),
            );
            yield* TestClock.setTime(Date.parse(task.nextRunAt!));
            yield* fires.sweep;
            assert.deepEqual(yield* Ref.get(fires.sent), sent);
          }),
        undefined,
        layerProvidersTest(providers),
      ),
    ),
    Effect.provide(SqlitePersistence.layerMemory),
  ),
);

it.effect("a session failure on another instance does not lift the stop", () =>
  firesOverMemory((fires) =>
    Effect.gen(function* () {
      const { task } = yield* fires.service.upsert(boundTask(INTERVAL));
      yield* Ref.set(
        fires.records,
        stoppedRecords({
          resetAt: RESET_AT,
          providerSessions: [
            {
              providerInstanceId: alternate,
              updatedAt: DateTime.makeUnsafe(FIRE_AT),
              lastError: "Sign in again.",
            },
          ],
        }),
      );
      yield* TestClock.setTime(Date.parse(task.nextRunAt!));
      yield* fires.sweep;
      assert.deepEqual(yield* Ref.get(fires.sent), []);
    }),
  ),
);

it.effect(
  "Run now on a thread stopped until a known reset sends nothing and keeps the next run",
  () =>
    firesOverMemory((fires) =>
      Effect.gen(function* () {
        const { task } = yield* fires.service.upsert(boundTask(INTERVAL));
        yield* Ref.set(fires.records, stoppedRecords({ resetAt: RESET_AT }));
        yield* TestClock.adjust("10 minutes");
        const ran = yield* fires.service.runNow({ id: task.id });
        assert.deepEqual(yield* Ref.get(fires.sent), []);
        assert.isNull(ran.threadId);
        assert.equal(ran.task.lastRunStatus, "failed");
        assert.match(ran.task.lastRunError ?? "", /usage limit/);
        assert.include(ran.task.lastRunError ?? "", RESET_AT);
        assert.equal(ran.task.nextRunAt, task.nextRunAt);
        assert.equal((yield* fires.stored).nextRunAt, task.nextRunAt);
      }),
    ),
);

it.effect.each([
  ["no reset time", stoppedRecords({ resetAt: null })],
  [
    "a stale reset",
    stoppedRecords({
      resetAt: "2026-09-09T12:30:00.000Z",
      completedAt: "2026-09-09T13:00:00.000Z",
    }),
  ],
] as const)("Run now on a limit with %s sends", ([, records]) =>
  firesOverMemory((fires) =>
    Effect.gen(function* () {
      const { task } = yield* fires.service.upsert(boundTask(INTERVAL));
      yield* Ref.set(fires.records, records);
      const ran = yield* fires.service.runNow({ id: task.id });
      assert.deepEqual(yield* Ref.get(fires.sent), ["queue"]);
      assert.equal(ran.task.lastRunStatus, "succeeded");
    }),
  ),
);

it.effect("Run now keeps a postponed time, and sends once the reset has passed", () =>
  firesOverMemory((fires) =>
    Effect.gen(function* () {
      const { resetAt } = yield* postponed(fires, LONG_INTERVAL);
      const reason = (yield* fires.stored).lastRunError;
      yield* fires.service.runNow({ id: TASK_ID });
      assert.deepEqual(yield* Ref.get(fires.sent), []);
      assert.equal((yield* fires.stored).nextRunAt, resetAt);
      assert.equal((yield* fires.stored).lastRunError, reason);

      yield* TestClock.setTime(Date.parse(resetAt) + 1);
      const ran = yield* fires.service.runNow({ id: TASK_ID });
      assert.deepEqual(yield* Ref.get(fires.sent), ["queue"]);
      assert.equal(ran.task.lastRunStatus, "succeeded");
    }),
  ),
);

it.effect("a fire at the reset lets an armed auto-resume go first, then queues behind it", () =>
  firesOverMemory((fires) =>
    Effect.gen(function* () {
      const { resetAt } = yield* postponed(fires, FIXED_TIME);
      const records = stoppedRecords({ resetAt });
      yield* Ref.set(fires.records, {
        ...records,
        thread: {
          ...records.thread,
          limitRecovery: { runId: "run:stopped", resetAt, autoResume: true, snooze: false },
        },
      });
      yield* TestClock.setTime(Date.parse(resetAt));
      yield* fires.sweep;
      assert.deepEqual(yield* Ref.get(fires.sent), []);
      assert.equal((yield* fires.stored).nextRunAt, resetAt);

      yield* TestClock.setTime(Date.parse(resetAt) + 15_000);
      yield* fires.sweep;
      assert.deepEqual(yield* Ref.get(fires.sent), ["queue"]);
    }),
  ),
);

it.effect("a late tick gets the head start from the first sweep that saw it, restart or not", () =>
  Effect.gen(function* () {
    yield* startClock;
    const persisted = yield* withFires((fires) =>
      Effect.gen(function* () {
        const { resetAt } = yield* postponed(fires, FIXED_TIME);
        const records = stoppedRecords({ resetAt });
        yield* Ref.set(fires.records, {
          ...records,
          thread: {
            ...records.thread,
            limitRecovery: { runId: "run:stopped", resetAt, autoResume: true, snooze: false },
          },
        });
        yield* TestClock.setTime(Date.parse(resetAt) + 2 * HOUR_MS);
        yield* fires.sweep;
        yield* TestClock.adjust("10 seconds");
        yield* fires.sweep;
        assert.deepEqual(yield* Ref.get(fires.sent), []);
        return { sent: fires.sent, records: fires.records };
      }),
    );
    yield* withFires(
      (fires) =>
        Effect.gen(function* () {
          yield* TestClock.adjust("10 seconds");
          yield* fires.sweep;
          assert.deepEqual(yield* Ref.get(fires.sent), [], "a restart only restarts the wait");
          yield* TestClock.adjust("14 seconds");
          yield* fires.sweep;
          assert.deepEqual(yield* Ref.get(fires.sent), []);
          yield* TestClock.adjust("1 second");
          yield* fires.sweep;
          assert.deepEqual(yield* Ref.get(fires.sent), ["queue"]);
        }),
      persisted,
    );
  }).pipe(Effect.provide(SqlitePersistence.layerMemory)),
);

it.effect("a recovery another run has answered holds nothing back", () =>
  firesOverMemory((fires) =>
    Effect.gen(function* () {
      const { resetAt } = yield* postponed(fires, FIXED_TIME);
      const records = stoppedRecords({ resetAt });
      const at = DateTime.makeUnsafe(resetAt);
      yield* Ref.set(fires.records, {
        ...records,
        runs: [
          ...records.runs,
          {
            ...records.runs[0],
            id: "run:continued",
            ordinal: 2,
            status: "starting",
            startedAt: at,
            completedAt: null,
          },
        ],
        thread: {
          ...records.thread,
          limitRecovery: { runId: "run:stopped", resetAt, autoResume: true, snooze: false },
        },
      });
      yield* TestClock.setTime(Date.parse(resetAt));
      yield* fires.sweep;
      assert.deepEqual(yield* Ref.get(fires.sent), ["queue"]);
    }),
  ),
);

it.effect("a thread no longer stopped at the postponed time gets an ordinary fire", () =>
  firesOverMemory((fires) =>
    Effect.gen(function* () {
      const { resetAt } = yield* postponed(fires, FIXED_TIME);
      yield* Ref.set(fires.records, ordinaryRecords);
      yield* TestClock.setTime(Date.parse(resetAt));
      yield* fires.sweep;
      assert.deepEqual(yield* Ref.get(fires.sent), ["queue"]);
      assert.equal((yield* fires.stored).lastRunStatus, "succeeded");
    }),
  ),
);

it.effect("an edit keeps a postponed time unless it changes the schedule", () =>
  firesOverMemory((fires) =>
    Effect.gen(function* () {
      const { dueAt, resetAt } = yield* postponed(fires, LONG_INTERVAL);
      yield* fires.service.upsert(boundTask(LONG_INTERVAL, { title: "Renamed" }));
      assert.equal((yield* fires.stored).nextRunAt, resetAt);

      yield* fires.service.upsert(boundTask({ type: "interval", everyMs: 2 * DAY_MS }));
      assert.equal((yield* fires.stored).nextRunAt, later(dueAt, 2 * DAY_MS));
    }),
  ),
);

const STEER = { ...INTERVAL, deliverAs: "steer" } as const;

it.effect.each([
  ["steers a running turn", STEER, runningRecords, ["steer"]],
  ["starts an idle thread that it would steer", STEER, ordinaryRecords, ["queue"]],
  ["queues behind a turn that refuses the steer", STEER, stoppingRecords, ["queue"]],
  ["queues behind a running turn by default", INTERVAL, runningRecords, ["queue"]],
] as const)("a bound fire %s", ([, schedule, records, sent]) =>
  firesOverMemory((fires) =>
    Effect.gen(function* () {
      const { task } = yield* fires.service.upsert(boundTask(schedule));
      yield* Ref.set(fires.records, records);
      yield* TestClock.setTime(Date.parse(task.nextRunAt!));
      yield* fires.sweep;
      assert.deepEqual(yield* Ref.get(fires.sent), sent);
      assert.equal((yield* fires.stored).lastRunStatus, "succeeded");
    }),
  ),
);

it.effect("a steering task on a limit-stopped thread waits for the reset like any fire", () =>
  firesOverMemory((fires) =>
    Effect.gen(function* () {
      const { resetAt } = yield* postponed(fires, { ...LONG_INTERVAL, deliverAs: "steer" });
      assert.deepEqual(yield* Ref.get(fires.sent), []);
      yield* TestClock.setTime(Date.parse(resetAt));
      yield* fires.sweep;
      assert.deepEqual(yield* Ref.get(fires.sent), ["queue"]);
    }),
  ),
);

it.effect("a save without deliverAs keeps the task's, and only a bound task has one", () =>
  firesOverMemory((fires) =>
    Effect.gen(function* () {
      const deliverAs = fires.stored.pipe(
        Effect.map(({ schedule }) => (schedule.type === "webhook" ? null : schedule.deliverAs)),
      );
      yield* fires.service.upsert(boundTask(STEER));
      // As mobile and an agent's update save it.
      yield* fires.service.upsert(boundTask(FIXED_TIME, { title: "Renamed" }));
      assert.equal(yield* deliverAs, "steer");
      yield* fires.service.upsert(boundTask({ ...FIXED_TIME, deliverAs: "queue" }));
      assert.equal(yield* deliverAs, "queue");
      yield* fires.service.upsert(boundTask(STEER, { threadId: null }));
      assert.isUndefined(yield* deliverAs);
    }),
  ),
);

const OTHER_THREAD = ThreadId.make("thread:other");

it.effect.each([
  ["rebound", OTHER_THREAD],
  ["unbound", null],
] as const)("an interval %s while postponed recomputes its next run", ([, threadId]) =>
  firesOverMemory((fires) =>
    Effect.gen(function* () {
      const { dueAt, resetAt } = yield* postponed(fires, LONG_INTERVAL);
      assert.equal((yield* fires.stored).nextRunAt, resetAt);
      yield* fires.service.upsert(boundTask(LONG_INTERVAL, { threadId }));
      assert.equal((yield* fires.stored).nextRunAt, later(dueAt, DAY_MS));
    }),
  ),
);

it.effect.each([
  ["rebound", OTHER_THREAD, "queue"],
  ["unbound", null, "launch"],
] as const)("a once %s while postponed past its time fires at once", ([, threadId, sent]) =>
  firesOverMemory((fires) =>
    Effect.gen(function* () {
      const { dueAt, resetAt } = yield* postponed(fires, ONCE);
      assert.equal((yield* fires.stored).nextRunAt, resetAt);
      yield* TestClock.setTime(Date.parse(dueAt) + 60_000);
      yield* Ref.set(fires.records, ordinaryRecords);
      yield* fires.service.upsert(boundTask(ONCE, { threadId }));
      assert.equal((yield* fires.stored).nextRunAt, later(dueAt, 60_000));
      yield* fires.sweep;
      assert.deepEqual(yield* Ref.get(fires.sent), [sent]);
      assert.isNull((yield* fires.stored).nextRunAt);
    }),
  ),
);

it.effect("rebinding a once that already ran does not run it again", () =>
  firesOverMemory((fires) =>
    Effect.gen(function* () {
      const { task } = yield* fires.service.upsert(boundTask(ONCE));
      yield* TestClock.setTime(Date.parse(task.nextRunAt!));
      yield* fires.sweep;
      assert.isNull((yield* fires.stored).nextRunAt);
      yield* fires.service.upsert(boundTask(ONCE, { threadId: OTHER_THREAD }));
      assert.isNull((yield* fires.stored).nextRunAt);
      yield* fires.sweep;
      assert.deepEqual(yield* Ref.get(fires.sent), ["queue"]);
    }),
  ),
);

it.effect("pausing clears a postponed time and resuming does not bring it back", () =>
  firesOverMemory((fires) =>
    Effect.gen(function* () {
      const { dueAt, resetAt } = yield* postponed(fires, LONG_INTERVAL);
      assert.equal((yield* fires.stored).nextRunAt, resetAt);
      yield* fires.service.setEnabled({ id: TASK_ID, enabled: false });
      assert.isNull((yield* fires.stored).nextRunAt);
      yield* fires.service.setEnabled({ id: TASK_ID, enabled: true });
      assert.equal((yield* fires.stored).nextRunAt, later(dueAt, DAY_MS));
    }),
  ),
);

it.effect("a paused once past its time asks for a new one, as any paused once does", () =>
  firesOverMemory((fires) =>
    Effect.gen(function* () {
      yield* postponed(fires, ONCE);
      yield* fires.service.setEnabled({ id: TASK_ID, enabled: false });
      const refused = yield* fires.service
        .setEnabled({ id: TASK_ID, enabled: true })
        .pipe(Effect.flip);
      assert.equal(refused.message, "The run time has passed. Pick a time in the future.");
      assert.deepEqual(yield* Ref.get(fires.sent), []);
    }),
  ),
);

const storedModel = { instanceId: codex, model: "gpt-5.4" };
const fallbackModel = {
  instanceId: ProviderInstanceId.make("claudeAgent"),
  model: "claude-fable-5-1",
};
const provider = (instanceId: ProviderInstanceId, usedPercent: number): ServerProvider => ({
  instanceId,
  driver: ProviderDriverKind.make(instanceId),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: FIRE_AT,
  models: [],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt: FIRE_AT,
    windows: [
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        usedPercent,
        windowDurationMins: 300,
        resetsAt: RESET_AT,
      },
    ],
  },
});
const fallbackEverywhere = ServerSettings.layerTest({ fallbackModelSelection: fallbackModel });

// One unbound fire through runNow; returns the model the thread launched on.
const fireUnbound = (
  providers: ReadonlyArray<ServerProvider>,
  settings: Layer.Layer<ServerSettings.ServerSettingsService, ServerSettingsError>,
) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(FIRE_AT));
    const launched = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const layer = ScheduledTaskService.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          taskDependencies,
          Layer.succeed(Scheduler.Scheduler, { register: () => Effect.void }),
          settings,
          Layer.mock(ProviderRegistry.ProviderRegistry)({
            getProviders: Effect.succeed(providers),
          }),
          Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
          Layer.mock(ThreadManagementService.ThreadManagementService)({}),
          Layer.mock(ThreadLaunchService.ThreadLaunchService)({
            launch: (input) =>
              Ref.update(launched, (all) => [...all, input.modelSelection]).pipe(
                Effect.as({ threadId: ThreadId.make("thread:launched"), resumed: false } as never),
              ),
          }),
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      const service = yield* ScheduledTaskService.ScheduledTaskService;
      const { task } = yield* service.upsert({
        id: ScheduledTaskId.make("task:unbound-fire"),
        title: "Check in",
        prompt: "Check progress",
        enabled: true,
        schedule: { type: "interval", everyMs: 60_000 },
        projectId: ProjectId.make("project:test"),
        workspaceStrategy: { type: "root" },
        modelSelection: storedModel,
        runtimeMode: "full-access",
        interactionMode: "default",
      });
      const ran = yield* service.runNow({ id: task.id });
      assert.equal(ran.task.lastRunStatus, "succeeded");
      const [selection, ...rest] = yield* Ref.get(launched);
      assert.lengthOf(rest, 0);
      return selection;
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(SqlitePersistence.layerMemory));

const exhausted = provider(storedModel.instanceId, 100);
const usable = provider(storedModel.instanceId, 40);
const fallbackUsable = provider(fallbackModel.instanceId, 10);
const fallbackExhausted = provider(fallbackModel.instanceId, 100);

it.effect.each([
  [
    "moves an exhausted model to a usable fallback",
    [exhausted, fallbackUsable],
    fallbackEverywhere,
    fallbackModel,
  ],
  [
    "keeps a usable model though a fallback is set",
    [usable, fallbackUsable],
    fallbackEverywhere,
    storedModel,
  ],
  [
    "keeps an exhausted model with no fallback",
    [exhausted, fallbackUsable],
    ServerSettings.layerTest(),
    storedModel,
  ],
  [
    "keeps an exhausted model when the fallback is exhausted too",
    [exhausted, fallbackExhausted],
    fallbackEverywhere,
    storedModel,
  ],
  [
    "keeps an exhausted model when the task's project turned the fallback off",
    [exhausted, fallbackUsable],
    ServerSettings.layerTest({
      fallbackModelSelection: fallbackModel,
      projectSettingsOverrides: {
        [ProjectId.make("project:test")]: {
          providerInstances: { [fallbackModel.instanceId]: { enabled: false } },
        },
      },
    }),
    storedModel,
  ],
  [
    "ignores another project turning the fallback off",
    [exhausted, fallbackUsable],
    ServerSettings.layerTest({
      fallbackModelSelection: fallbackModel,
      projectSettingsOverrides: {
        [ProjectId.make("project:other")]: {
          providerInstances: { [fallbackModel.instanceId]: { enabled: false } },
        },
      },
    }),
    fallbackModel,
  ],
  [
    "launches the stored model when settings cannot be read",
    [exhausted, fallbackUsable],
    Layer.mock(ServerSettings.ServerSettingsService)({
      getSettings: Effect.fail(
        new ServerSettingsError({ settingsPath: "settings.json", operation: "read-file" }),
      ),
    }),
    storedModel,
  ],
] as const)("an unbound fire %s", ([, providers, settings, expected]) =>
  Effect.gen(function* () {
    assert.deepEqual(yield* fireUnbound(providers, settings), expected);
  }),
);
