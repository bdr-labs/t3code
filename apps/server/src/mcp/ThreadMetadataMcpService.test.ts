import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  OrchestratorMcpFailure,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as ThreadMetadataMcpService from "./ThreadMetadataMcpService.ts";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for these commands"),
} as ProviderAdapter.ProviderAdapterV2["Service"];

const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = ThreadMetadataMcpService.layer.pipe(
  Layer.provideMerge(
    ThreadManagement.layer.pipe(
      Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
      Layer.provideMerge(
        Layer.mergeAll(
          layerDatabase,
          ServerSettings.layerTest(),
          ProviderReplayHarness.layerWithRegistry(
            { name: "thread-metadata" },
            ProviderAdapterRegistry.layerFromAdapters([adapter]),
            { databaseLayer: layerDatabase, runEffectWorker: false },
          ),
        ),
      ),
    ),
  ),
  Layer.provide(NodeCrypto.layer),
);

const ship: McpInvocationScope = {
  environmentId: EnvironmentId.make("environment"),
  requestNamespace: "client:ship",
  thread: undefined,
  client: { sessionId: "ship", label: "The Ship", access: "full-access" },
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

const makeThread = Effect.fn("test.makeThread")(function* (id: string) {
  const threads = yield* ThreadManagement.ThreadManagementService;
  const threadId = ThreadId.make(id);
  yield* threads.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${id}`),
    threadId,
    projectId: ProjectId.make("project:thread-metadata"),
    title: "Before",
    modelSelection: { instanceId, model: "gpt-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return threadId;
});

const tagEvents = Effect.fn("test.tagEvents")(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM orchestration_events
    WHERE stream_id = ${threadId} AND event_type = 'thread.tags-updated'
  `;
  return rows[0]?.count ?? 0;
});

const update = (
  input: Parameters<ThreadMetadataMcpService.ThreadMetadataMcpService["Service"]["update"]>[1],
  scope: McpInvocationScope = ship,
) =>
  ThreadMetadataMcpService.ThreadMetadataMcpService.pipe(
    Effect.flatMap((service) => service.update(scope, input)),
  );

it.effect("adds and removes tags with one event per change, and reads them back", () =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = yield* makeThread("thread:tagged");

    const added = yield* update({ threadId, action: "tag", addTags: ["group:fleet", "hide"] });
    assert.equal(added.action, "tag");
    assert.equal(added.threadId, threadId);
    assert.deepEqual(added.tags, ["group:fleet", "hide"]);
    assert.isAbove(added.sequence, 0);
    assert.equal(added.title, "Before");
    assert.equal(yield* tagEvents(threadId), 2);
    assert.deepEqual((yield* threads.getThreadShell(threadId))?.tags, ["group:fleet", "hide"]);

    const changed = yield* update({
      threadId,
      action: "tag",
      addTags: ["keep"],
      removeTags: ["hide"],
    });
    assert.deepEqual(changed.tags, ["group:fleet", "keep"]);
    assert.equal(yield* tagEvents(threadId), 4);

    const emptied = yield* update({ threadId, action: "tag", removeTags: ["group:fleet", "keep"] });
    assert.deepEqual(emptied.tags, []);
    assert.equal(yield* tagEvents(threadId), 6);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a tag call that changes nothing emits nothing and rewrites nothing", () =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = yield* makeThread("thread:no-op");
    yield* update({ threadId, action: "tag", addTags: ["a", "b", "a"] });
    assert.equal(yield* tagEvents(threadId), 2);
    const before = yield* threads.getThreadShell(threadId);

    for (const noOp of [
      { addTags: ["a"] },
      { addTags: ["b", "a", "b"] },
      { removeTags: ["absent"] },
      { addTags: ["a"], removeTags: ["absent"] },
    ]) {
      const result = yield* update({ threadId, action: "tag", ...noOp });
      assert.deepEqual(result.tags, ["a", "b"], JSON.stringify(noOp));
      assert.equal(result.sequence, 0, JSON.stringify(noOp));
    }
    assert.equal(yield* tagEvents(threadId), 2);
    assert.deepEqual(yield* threads.getThreadShell(threadId), before);

    // A real change in the same call leaves the tags it does not name in place.
    const mixed = yield* update({ threadId, action: "tag", addTags: ["a", "c"] });
    assert.deepEqual(mixed.tags, ["a", "b", "c"]);
    assert.equal(yield* tagEvents(threadId), 3);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("a tag call retried with its clientRequestId sets nothing twice", () =>
  Effect.gen(function* () {
    const threadId = yield* makeThread("thread:retried");
    const call = { threadId, action: "tag", addTags: ["a"], clientRequestId: "key-1" } as const;
    const first = yield* update(call);
    const retry = yield* update(call);
    assert.equal(retry.commandId, first.commandId);
    assert.deepEqual(retry.tags, ["a"]);
    assert.equal(yield* tagEvents(threadId), 1);

    // A replay after a later removal stays a replay: it does not bring the tag back.
    yield* update({ threadId, action: "tag", removeTags: ["a"] });
    const replay = yield* update(call);
    assert.deepEqual(replay.tags, []);
    assert.equal(yield* tagEvents(threadId), 2);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("rename and regenerate_title answer as they did and leave tags alone", () =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const threadId = yield* makeThread("thread:renamed");
    yield* update({ threadId, action: "tag", addTags: ["a"] });

    const renamed = yield* update({ threadId, action: "rename", title: "After" });
    assert.equal(renamed.title, "After");
    assert.notProperty(renamed, "tags");
    assert.isAbove(renamed.sequence, 0);
    assert.notProperty(yield* update({ threadId, action: "regenerate_title" }), "tags");

    assert.equal(yield* tagEvents(threadId), 1);
    assert.deepEqual((yield* threads.getThreadShell(threadId))?.tags, ["a"]);
  }).pipe(Effect.provide(layerTest)),
);

it.effect("refuses a tag call with no live thread to tag or no right to orchestrate", () =>
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    const deleted = yield* makeThread("thread:deleted");
    yield* threads.dispatch({
      type: "thread.delete",
      commandId: CommandId.make("delete:thread:deleted"),
      threadId: deleted,
    });
    const code = (input: Parameters<typeof update>[0], scope?: McpInvocationScope) =>
      update(input, scope).pipe(
        Effect.flip,
        Effect.map((failure: OrchestratorMcpFailure) => failure.code),
      );
    const addTags = ["a"];

    assert.equal(
      yield* code({ threadId: ThreadId.make("thread:unknown"), action: "tag", addTags }),
      "thread_not_found",
    );
    assert.equal(yield* code({ threadId: deleted, action: "tag", addTags }), "thread_not_found");
    assert.equal(yield* code({ action: "tag", addTags }), "target_required");
    assert.equal(
      yield* code(
        { threadId: deleted, action: "tag", addTags },
        { ...ship, capabilities: new Set() },
      ),
      "capability_denied",
    );
    assert.equal(yield* tagEvents(deleted), 0);
  }).pipe(Effect.provide(layerTest)),
);
