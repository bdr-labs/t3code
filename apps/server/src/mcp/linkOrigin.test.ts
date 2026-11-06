import * as DocumentText from "../provider/DocumentText.ts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ContextTransferId,
  EnvironmentId,
  EventId,
  MessageId,
  NodeId,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ServerConfig from "../config.ts";
import { CodexProviderCapabilitiesV2 } from "../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import { makeSubagentChildThread } from "@t3tools/provider-core/server/subagentProjection";
import * as ThreadForkService from "../orchestration-v2/ThreadForkService.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProviderReplayHarness from "../orchestration-v2/testkit/ProviderReplayHarness.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ManagedProjectFolders from "../project/ManagedProjectFolders.ts";
import * as ProjectCloneTracker from "../project/ProjectCloneTracker.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CommandReceiptStore from "../orchestration-v2/CommandReceiptStore.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";
import * as SourceControlRepositoryService from "../sourceControl/SourceControlRepositoryService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as McpHttpServer from "./McpHttpServer.ts";
import * as McpInvocationContext from "./McpInvocationContext.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as ThreadSearch from "../orchestration-v2/ThreadSearch.ts";
import * as PeerLinkRequests from "../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../peer/PeerLinks.ts";

// A linked environment's session drives this one's real orchestrator through
// its real T3 tools. What the link starts carries its origin, and the link
// changes only that.

const instanceId = ProviderInstanceId.make("codex");
const projectId = ProjectId.make("project:link-origin");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for these commands"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerOrchestrator = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProjectStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "link-origin" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);
const layerOrchestration = ThreadManagement.layer.pipe(
  Layer.provide(CommandReceiptStore.layer.pipe(Layer.provide(layerDatabase))),
  Layer.provideMerge(Layer.merge(layerOrchestrator, ServerSettings.layerTest())),
);

/** Launches dispatch the real thread.create, and nothing more: no workspace, no run. */
const layerLaunches = Layer.effect(
  ThreadLaunch.ThreadLaunchService,
  Effect.gen(function* () {
    const threads = yield* ThreadManagement.ThreadManagementService;
    return ThreadLaunch.ThreadLaunchService.of({
      launch: (input: ThreadLaunch.ThreadLaunchInput) =>
        threads
          .dispatch({
            type: "thread.create",
            commandId: input.commandId,
            threadId: input.threadId!,
            projectId: input.projectId,
            title: input.title,
            modelSelection: input.modelSelection,
            runtimeMode: input.runtimeMode,
            interactionMode: input.interactionMode,
            branch: null,
            worktreePath: null,
            ...(input.linkOrigin === undefined ? {} : { linkOrigin: input.linkOrigin }),
            ...(input.delegatedFrom === undefined ? {} : { delegatedFrom: input.delegatedFrom }),
            ...(input.openedByThreadId === undefined
              ? {}
              : { openedByThreadId: input.openedByThreadId }),
            createdBy: input.createdBy,
            creationSource: input.creationSource,
          })
          .pipe(
            Effect.flatMap(() => threads.getThreadProjection(input.threadId!)),
            Effect.map((projection) => ({
              threadId: input.threadId!,
              projection,
              resumed: false,
            })),
            Effect.orDie,
          ),
    } as unknown as ThreadLaunch.ThreadLaunchService["Service"]);
  }),
);

const layerTools = Layer.mergeAll(
  McpHttpServer.layerOrchestratorToolkit,
  McpHttpServer.layerThreadToolkit,
  McpHttpServer.layerProjectRegistration,
).pipe(
  Layer.provide(DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer))),
  Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
  Layer.provide(layerLaunches),
  Layer.provide(NodeCrypto.layer),
  Layer.provide(
    Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
  ),
  Layer.provide(
    Layer.mock(ProviderAdapterRegistry.ProviderAdapterRegistryV2)({
      list: () => Effect.succeed([]),
    }),
  ),
  Layer.provide(Layer.mock(ScheduledTaskService.ScheduledTaskService)({})),
  Layer.provide(
    Layer.mock(ProjectService.ProjectService)({
      getById: () => Effect.succeedNone,
      create: (input) =>
        Effect.succeed({
          id: input.projectId,
          title: input.title,
          workspaceRoot: input.workspaceRoot,
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-10-18T00:00:00.000Z",
          updatedAt: "2026-10-18T00:00:00.000Z",
          deletedAt: null,
        }),
      update: (input) =>
        Effect.succeed({
          id: input.projectId,
          title: input.title ?? "Untitled",
          workspaceRoot: "/p/t3code",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-10-18T00:00:00.000Z",
          updatedAt: "2026-10-18T00:00:00.000Z",
          deletedAt: null,
        }),
    }),
  ),
  Layer.provide(Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({})),
  Layer.provide(Layer.mock(SecretRequests.SecretRequests)({})),
  Layer.provide(Layer.mock(PeerForwarding.PeerForwarding)({})),
  Layer.provide(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
  Layer.provide(Layer.mock(PeerLinks.PeerLinks)({})),
  Layer.provide(ThreadSearch.layer.pipe(Layer.provide(layerDatabase))),
  Layer.provide(Layer.mock(RemoteDelegation.RemoteDelegation)({})),
  Layer.provide(
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/p" }),
  ),
  Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
  Layer.provide(
    Layer.mock(SourceControlRepositoryService.SourceControlRepositoryService)({
      cloneRepository: (input) =>
        Effect.succeed({
          cwd: input.destinationPath,
          remoteUrl: "https://github.com/pingdotgg/t3code.git",
          repository: null,
        }),
    }),
  ),
  Layer.provide(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-link-origin-" }).pipe(
      Layer.provide(NodeServices.layer),
    ),
  ),
  Layer.provide(NodeServices.layer),
);

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "link-origin", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "link-origin", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const clientScope = (
  sessionId: string,
  linked: boolean,
  access: McpInvocationContext.McpClientCaller["access"],
): McpInvocationContext.McpInvocationScope => ({
  environmentId: EnvironmentId.make("environment:box"),
  requestNamespace: `client:${sessionId}`,
  thread: undefined,
  client: { sessionId, label: `T3 Code · ${sessionId}`, access, linked },
  capabilities: new Set(["orchestration", "worktree", "pull-requests"]),
  issuedAt: 0,
});
const laptop = clientScope("laptop", true, "auto");
const desk = clientScope("desk", true, "auto");
const trusted = clientScope("trusted", true, "full-access");
const claudeCode = clientScope("claude-code", false, "full-access");
const supervised = clientScope("supervised", false, "auto");
const readOnly = clientScope("read-only", false, "read-only");

const call = (
  scope: McpInvocationContext.McpInvocationScope,
  name: string,
  args: Record<string, unknown>,
) =>
  McpServer.McpServer.pipe(
    Effect.flatMap((server) => server.callTool({ name, arguments: args })),
    Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
    Effect.provideService(McpSchema.McpServerClient, mcpClient),
  );

const failureCode = (result: McpSchema.CallToolResult) => {
  const text = result.content[0];
  return result.isError === true && text?.type === "text"
    ? (JSON.parse(text.text) as { code: string }).code
    : undefined;
};

const launch = (
  scope: McpInvocationContext.McpInvocationScope,
  title: string,
  extra: Record<string, unknown> = {},
) =>
  call(scope, "t3_thread_launch", {
    projectId,
    title,
    modelSelection: { instanceId, model: "gpt-5" },
    ...extra,
  }).pipe(
    Effect.map((result) => {
      assert.equal(result.isError, false, JSON.stringify(result.content));
      return (result.structuredContent as { threadId: ThreadId }).threadId;
    }),
  );

const usersOwnThread = Effect.gen(function* () {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threadId = ThreadId.make("thread:users-own");
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make("create:users-own"),
    threadId,
    projectId,
    title: "The user's own",
    modelSelection: { instanceId, model: "gpt-5" },
    // Within an `auto` link's modes, so only the fence decides.
    runtimeMode: "auto",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  return threadId;
});

const asThread = (threadId: ThreadId): McpInvocationContext.McpInvocationScope => ({
  ...claudeCode,
  requestNamespace: `provider:${threadId}`,
  thread: { threadId, providerSessionId: `provider:${threadId}`, providerInstanceId: instanceId },
  client: undefined,
});

/** What each tool that shows a thread answers, through its success schema. */
const shownIn = (scope: McpInvocationContext.McpInvocationScope) => {
  const structured = (name: string, args: Record<string, unknown>) =>
    call(scope, name, args).pipe(
      Effect.map((result) => {
        assert.equal(result.isError, false, `${name}: ${JSON.stringify(result.content)}`);
        return result.structuredContent as Record<string, unknown>;
      }),
    );
  const first = (rows: unknown) =>
    (rows as ReadonlyArray<Record<string, unknown>> | undefined)?.[0];
  return {
    list: (titleContains: string) =>
      structured("t3_thread_list", { projectId, titleContains }).pipe(
        Effect.map((result) => first(result.threads)),
      ),
    read: (threadId: ThreadId) =>
      structured("t3_thread_read", { threadId }).pipe(
        Effect.map((result) => result.thread as Record<string, unknown>),
      ),
    wait: (threadId: ThreadId) => structured("t3_thread_wait", { threadId, timeoutMs: 1 }),
    search: (query: string) =>
      structured("t3_thread_search", { query, projectId }).pipe(
        Effect.map((result) => first(result.matches)),
      ),
  };
};

it.layer(Layer.provideMerge(layerTools, layerOrchestration))("work a link starts", (it) => {
  it.effect("is stamped, and so is the work it derives", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const launched = yield* launch(laptop, "Started from the laptop");
      const shell = yield* projections.getThreadShell(launched);
      assert.deepEqual(shell?.linkOrigin, {
        sessionId: "laptop",
        label: "T3 Code · laptop",
        access: "auto",
      });

      // A subagent of it and a fork of it are built from its thread, origin included.
      const thread = (yield* ThreadManagement.ThreadManagementService.pipe(
        Effect.flatMap((threads) => threads.getThreadProjection(launched)),
      )).thread;
      const child = makeSubagentChildThread({
        parentThread: thread,
        childThreadId: ThreadId.make("thread:child"),
        parentNodeId: NodeId.make("node:child"),
        activeProviderThreadId: null,
        providerInstanceId: instanceId,
        modelSelection: { instanceId, model: "gpt-5" },
        title: "Child",
        now: thread.createdAt,
        createdBy: "agent",
        creationSource: "mcp",
      });
      assert.deepEqual(child.linkOrigin, shell?.linkOrigin);
      const fork = yield* ThreadForkService.ThreadForkServiceV2.pipe(
        Effect.flatMap((forks) =>
          forks.plan({
            sourceProjection: { thread },
            sourceRun: { id: RunId.make("run:source"), status: "completed" } as OrchestrationV2Run,
            sourceProviderThread: undefined,
            canonicalSourcePoint: { threadId: launched },
            transferId: ContextTransferId.make("transfer:fork"),
            targetThreadId: ThreadId.make("thread:fork"),
            createdBy: "agent",
            creationSource: "mcp",
            createdAt: thread.createdAt,
          }),
        ),
        Effect.provide(ThreadForkService.layer),
      );
      assert.deepEqual(fork.targetThread.linkOrigin, shell?.linkOrigin);

      // An ordinary outside agent's launch is not a link's.
      const plain = yield* launch(claudeCode, "Started by Claude Code");
      assert.equal((yield* projections.getThreadShell(plain))?.linkOrigin, undefined);

      // A link's delegated task names its parent there; only a link's launch may.
      const delegatedFrom = {
        environmentId: "environment-laptop",
        threadId: "thread:laptop-parent",
        title: "Laptop parent",
      };
      const task = yield* launch(laptop, "Delegated from the laptop", { delegatedFrom });
      assert.deepEqual((yield* projections.getThreadShell(task))?.delegatedFrom, delegatedFrom);
      const claimed = yield* launch(claudeCode, "Claims a parent", { delegatedFrom });
      assert.equal((yield* projections.getThreadShell(claimed))?.delegatedFrom, undefined);
    }),
  );

  it.effect("changes only that link's threads below full access", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const users = yield* usersOwnThread;
      const ownLaunch = yield* launch(laptop, "The laptop's");
      const rename = (scope: McpInvocationContext.McpInvocationScope, threadId: ThreadId) =>
        call(scope, "t3_thread_update", {
          threadId,
          action: "rename",
          title: `Renamed by ${scope.client!.sessionId}`,
        });

      // The link may change what it started.
      assert.equal((yield* rename(laptop, ownLaunch)).isError, false);
      assert.equal((yield* projections.getThreadShell(ownLaunch))?.title, "Renamed by laptop");
      // Not the user's own thread, nor another link's.
      assert.equal(failureCode(yield* rename(laptop, users)), "capability_denied");
      assert.equal(failureCode(yield* rename(desk, ownLaunch)), "capability_denied");
      assert.equal((yield* projections.getThreadShell(users))?.title, "The user's own");
      // An ordinary outside agent is not fenced.
      assert.equal((yield* rename(claudeCode, users)).isError, false);
      // Naming this environment's own id is still this environment's thread.
      for (const [name, args] of [
        ["t3_thread_send", { message: "From the laptop." }],
        ["t3_thread_interrupt", {}],
      ] as const) {
        const result = yield* call(laptop, name, {
          ...args,
          environmentId: laptop.environmentId,
          threadId: users,
        });
        assert.equal(failureCode(result), "capability_denied", name);
      }

      // Nor scheduled tasks, which belong to no thread.
      assert.equal(
        failureCode(yield* call(laptop, "delete_scheduled_task", { scheduledTaskId: "any" })),
        "capability_denied",
      );

      // Reads are not fenced.
      const read = yield* call(laptop, "t3_thread_read", { threadId: users });
      assert.equal(read.isError, false);
    }),
  );

  it.effect("tags a thread only at full access, and never across a fence", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const users = yield* usersOwnThread;
      const ownLaunch = yield* launch(laptop, "The laptop's, untagged");
      const tagsOf = (threadId: ThreadId) =>
        projections.getThreadShell(threadId).pipe(Effect.map((shell) => shell?.tags ?? []));
      const before = yield* tagsOf(users);
      const tag = (scope: McpInvocationContext.McpInvocationScope, threadId: ThreadId) =>
        call(scope, "t3_thread_update", { threadId, action: "tag", addTags: ["group:fenced"] });
      const narrowed = {
        ...claudeCode,
        client: {
          ...claudeCode.client!,
          narrowedTo: { runtimeMode: "auto", interactionMode: "default" },
        },
      } as const;

      // The fence answers first: a link below full access is told so, not told its mode.
      assert.equal(failureCode(yield* tag(laptop, users)), "capability_denied");
      assert.equal(failureCode(yield* tag(desk, ownLaunch)), "capability_denied");
      // Inside its fence, or with no fence at all, the mode still decides.
      assert.equal(failureCode(yield* tag(laptop, ownLaunch)), "runtime_mode_escalation_denied");
      assert.equal(failureCode(yield* tag(supervised, users)), "runtime_mode_escalation_denied");
      assert.equal(failureCode(yield* tag(narrowed, users)), "runtime_mode_escalation_denied");
      assert.equal(failureCode(yield* tag(readOnly, users)), "capability_denied");
      assert.deepEqual(yield* tagsOf(users), before);
      assert.deepEqual(yield* tagsOf(ownLaunch), []);

      // A field that does not fit the action fails on the decode a real call goes through.
      for (const args of [
        { action: "rename", title: "New", addTags: ["group:fenced"] },
        { action: "regenerate_title", removeTags: ["group:fenced"] },
        { action: "tag", title: "New", addTags: ["group:fenced"] },
        { action: "tag", addTags: [] },
        { action: "tag", addTags: ["x".repeat(65)] },
      ]) {
        const refused = yield* call(claudeCode, "t3_thread_update", {
          threadId: users,
          ...args,
        }).pipe(Effect.flip);
        assert.instanceOf(refused, McpSchema.InvalidParams, JSON.stringify(args));
      }
      assert.deepEqual(yield* tagsOf(users), before);

      // A thread's own modes decide for an agent inside it.
      const runningAt = (id: string, runtimeMode: "auto" | "full-access") =>
        Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const threadId = ThreadId.make(id);
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make(`create:${id}`),
            threadId,
            projectId,
            title: id,
            modelSelection: { instanceId, model: "gpt-5" },
            runtimeMode,
            interactionMode: "default",
            branch: null,
            worktreePath: null,
            createdBy: "user",
            creationSource: "web",
          });
          yield* orchestrator.dispatch({
            type: "message.dispatch",
            commandId: CommandId.make(`message:${id}`),
            threadId,
            messageId: MessageId.make(`message:${id}`),
            text: "Work",
            attachments: [],
            dispatchMode: { type: "start_immediately" },
            createdBy: "user",
            creationSource: "web",
          });
          return threadId;
        });
      const atAuto = yield* runningAt("thread:tagging-at-auto", "auto");
      const refused = yield* tag(asThread(atAuto), atAuto);
      assert.equal(failureCode(refused), "runtime_mode_escalation_denied");
      assert.include(
        JSON.stringify(refused.content),
        "Naming an opener or tags needs full access; this caller has auto",
      );
      assert.deepEqual(yield* tagsOf(atAuto), []);
      const atFullAccess = yield* runningAt("thread:tagging-at-full-access", "full-access");
      const taggedOwn = yield* tag(asThread(atFullAccess), atFullAccess);
      assert.equal(taggedOwn.isError, false, JSON.stringify(taggedOwn.content));
      assert.deepEqual(yield* tagsOf(atFullAccess), ["group:fenced"]);

      // Full access is not fenced.
      const tagged = yield* tag(trusted, users);
      assert.equal(tagged.isError, false, JSON.stringify(tagged.content));
      assert.include(
        (tagged.structuredContent as { readonly tags: ReadonlyArray<string> }).tags,
        "group:fenced",
      );
      assert.include(yield* tagsOf(users), "group:fenced");
    }),
  );

  it.effect("list and read show tags, and no such key where there are none", () =>
    Effect.gen(function* () {
      const threadId = yield* launch(claudeCode, "Carries a tag");
      const tagged = yield* call(claudeCode, "t3_thread_update", {
        threadId,
        action: "tag",
        addTags: ["group:listed"],
      });
      assert.equal(tagged.isError, false, JSON.stringify(tagged.content));
      const plain = yield* launch(claudeCode, "Plain and untagged");
      const shows = shownIn(claudeCode);
      for (const shown of [yield* shows.list("Carries a tag"), yield* shows.read(threadId)]) {
        assert.deepEqual(shown?.tags, ["group:listed"]);
      }
      for (const shown of [yield* shows.list("Plain and untagged"), yield* shows.read(plain)]) {
        assert.notProperty(shown, "tags");
      }
    }),
  );

  it.effect("every tool that shows a thread names its opener, and the opener stays no parent", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projects = yield* ProjectStore.ProjectStoreV2;
      // Search joins the project's own row, which this harness's mocks do not write.
      yield* projects.apply({
        sequence: 0,
        eventId: EventId.make(`created:${projectId}`),
        aggregateKind: "project",
        aggregateId: projectId,
        occurredAt: "2026-10-18T00:00:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "project.created",
        payload: {
          projectId,
          title: "Link origin",
          workspaceRoot: "/p/link-origin",
          defaultModelSelection: null,
          scripts: [],
          createdAt: "2026-10-18T00:00:00.000Z",
          updatedAt: "2026-10-18T00:00:00.000Z",
        },
      });
      const opener = yield* launch(claudeCode, "Opener of Lapwing");
      const threadId = yield* launch(claudeCode, "Lapwing opened", { openedByThreadId: opener });
      const plain = yield* launch(claudeCode, "Lapwing plain");
      const everywhere = (scope: McpInvocationContext.McpInvocationScope, id: ThreadId) => {
        const shows = shownIn(scope);
        return Effect.all({
          list: shows.list(id === threadId ? "Lapwing opened" : "Lapwing plain"),
          read: shows.read(id),
          wait: shows.wait(id),
          search: shows.search(id === threadId ? "Lapwing opened" : "Lapwing plain"),
        });
      };

      const hosted: McpInvocationContext.McpInvocationScope = {
        ...claudeCode,
        client: { ...claudeCode.client!, hostedAppUrl: "https://t3.example.com" },
      };
      for (const scope of [claudeCode, hosted]) {
        const link = McpInvocationContext.threadLinkFor(scope, opener);
        for (const [tool, shown] of Object.entries(yield* everywhere(scope, threadId))) {
          assert.equal(shown?.openedByThreadId, opener, tool);
          assert.equal(shown?.openedByLink, link, tool);
        }
      }
      assert.include(
        McpInvocationContext.threadLinkFor(hosted, opener),
        "https://t3.example.com/threads/",
      );
      for (const shown of Object.values(yield* everywhere(claudeCode, plain))) {
        assert.notProperty(shown, "openedByThreadId");
        assert.notProperty(shown, "openedByLink");
      }

      // An opener says nothing about lineage.
      const read = yield* shownIn(claudeCode).read(threadId);
      const listed = yield* shownIn(claudeCode).list("Lapwing opened");
      for (const shown of [read, listed]) {
        assert.equal(shown?.parentThreadId, null);
        assert.equal(shown?.relationshipToParent, null);
      }

      const capabilities = (scope: McpInvocationContext.McpInvocationScope) =>
        call(scope, "orchestrator_capabilities", {}).pipe(
          Effect.map((result) => result.structuredContent as Record<string, unknown>),
        );
      const asLaunched = asThread(threadId);
      const ownCapabilities = yield* capabilities(asLaunched);
      assert.equal(ownCapabilities.openedByThreadId, opener);
      assert.equal(
        ownCapabilities.openedByLink,
        McpInvocationContext.threadLinkFor(asLaunched, opener),
      );
      assert.equal(ownCapabilities.parentThreadId, threadId);
      const outsideCapabilities = yield* capabilities(claudeCode);
      assert.notProperty(outsideCapabilities, "openedByThreadId");
      assert.notProperty(outsideCapabilities, "openedByLink");
      const plainCapabilities = yield* capabilities(asThread(plain));
      assert.notProperty(plainCapabilities, "openedByThreadId");
      assert.notProperty(plainCapabilities, "openedByLink");

      // Once the opener is deleted, the id stays as stored and nothing links to it.
      yield* orchestrator.dispatch({
        type: "thread.delete",
        commandId: CommandId.make("delete:opener-of-lapwing"),
        threadId: opener,
      });
      for (const [tool, shown] of Object.entries(yield* everywhere(claudeCode, threadId))) {
        assert.equal(shown?.openedByThreadId, opener, tool);
        assert.notProperty(shown, "openedByLink", tool);
      }
      const afterDelete = yield* capabilities(asLaunched);
      assert.equal(afterDelete.openedByThreadId, opener);
      assert.notProperty(afterDelete, "openedByLink");
    }),
  );

  it.effect("is not fenced when the link has full access, but still says where it came from", () =>
    Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const users = yield* usersOwnThread;
      const launched = yield* launch(trusted, "Started from the desk");
      assert.deepEqual((yield* projections.getThreadShell(launched))?.linkOrigin, {
        sessionId: "trusted",
        label: "T3 Code · trusted",
        access: "full-access",
      });

      const renamed = yield* call(trusted, "t3_thread_update", {
        threadId: users,
        action: "rename",
        title: "Renamed from the desk",
      });
      assert.equal(renamed.isError, false, JSON.stringify(renamed.content));
      for (const [name, args] of [
        ["t3_project_update", { projectId, title: "The desk's now" }],
        ["t3_project_create", { title: "t3code", workspaceRoot: "/p/t3code" }],
      ] as const) {
        const changed = yield* call(trusted, name, args);
        assert.equal(changed.isError, false, `${name}: ${JSON.stringify(changed.content)}`);
      }
    }),
  );
});
