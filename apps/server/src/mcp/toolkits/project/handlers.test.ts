import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ProviderDriverKind,
  type ServerProvider,
  ThreadId,
  type Project as ProjectRecord,
  type ModelSelection,
  type RuntimeMode,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as DocumentText from "../../../provider/DocumentText.ts";
import { OrchestratorRuntimeModeAboveCeilingError } from "../../../orchestration-v2/Orchestrator.ts";
import * as ThreadLaunch from "../../../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerConfig from "../../../config.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as Project from "../../../project/ProjectService.ts";
import * as ProjectCloneTracker from "../../../project/ProjectCloneTracker.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as GitVcsDriver from "../../../vcs/GitVcsDriver.ts";
import * as VcsProcess from "../../../vcs/VcsProcess.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as ProjectHandlers from "./handlers.ts";
import { ProjectToolkit } from "./tools.ts";

it.effect("attributes a launched thread and its first message to the calling thread", () =>
  Effect.gen(function* () {
    const sourceThreadId = ThreadId.make("source-thread");
    const projectId = ProjectId.make("project");
    const providerInstanceId = ProviderInstanceId.make("codex");
    const modelSelection = { instanceId: providerInstanceId, model: "gpt-5" };
    const caller = {
      id: sourceThreadId,
      projectId,
      providerInstanceId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      activeRunId: "active-run",
      archivedAt: null,
      deletedAt: null,
    } as OrchestrationV2ThreadShell;
    let launchedSender: ThreadId | undefined;
    let launchedOpener: ThreadId | undefined;
    const layerDependencies = Layer.mergeAll(
      Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
      ServerSettings.layerTest(),
      NodeCrypto.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId: EnvironmentId.make("environment"),
        requestNamespace: "session",
        thread: {
          threadId: sourceThreadId,
          providerSessionId: "session",
          providerInstanceId,
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(caller),
      }),
      Layer.mock(ThreadLaunch.ThreadLaunchService)({
        launch: (input) => {
          launchedSender = input.initialMessage?.senderThreadId;
          launchedOpener = input.openedByThreadId;
          return Effect.succeed({
            threadId: input.threadId,
            projection: {
              thread: { id: input.threadId, title: input.title, projectId, modelSelection },
              runs: [],
            },
            resumed: false,
          } as unknown as ThreadLaunch.ThreadLaunchResult);
        },
      }),
      Layer.mock(Project.ProjectService)({}),
      Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({ namedProjectsRoot: "/projects" }),
      Layer.mock(GitVcsDriver.GitVcsDriver)({}),
      DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer)),
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-source-link-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
          Layer.provide(layerDependencies),
        ),
      ),
    );
    const result = yield* toolkit
      .handle("t3_thread_launch", { title: "Audit", message: "Review the change" })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
    expect(result.at(-1)?.result).toMatchObject({ projectId, modelSelection });
    expect(launchedSender).toBe(sourceThreadId);
    expect(launchedOpener).toBe(sourceThreadId);

    // A thread is its launch's opener: even at full access it cannot name another.
    const namedOpener = ThreadId.make("named-opener");
    const namingAnother = yield* toolkit
      .handle("t3_thread_launch", {
        title: "Audit",
        message: "Review the change",
        openedByThreadId: namedOpener,
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(layerDependencies));
    expect(namingAnother.at(-1)?.result).toMatchObject({
      code: "invalid_request",
      message: "a calling thread is its launch's opener",
    });
    expect(launchedSender).toBe(sourceThreadId);
    expect(launchedOpener).toBe(sourceThreadId);
  }),
);

const clientLaunchHarness = (input: {
  readonly runtimeModeCeiling: McpInvocationContext.McpClientCaller["access"];
  readonly narrowedTo?: McpInvocationContext.ClientModes;
  /** Calls as this thread's agent instead of as an outside client. */
  readonly callerThread?: OrchestrationV2ThreadShell;
  /** Threads the environment already has, such as an opener. */
  readonly threads?: ReadonlyArray<OrchestrationV2ThreadShell>;
  /** Gets one entry per Scratch project a launch asks for. */
  readonly scratchProjects?: Array<ProjectId>;
  readonly defaultRuntimeMode?: RuntimeMode;
  readonly fallbackModel?: ModelSelection;
  readonly providers?: readonly ServerProvider[];
  /** Where Settings saves a project's model; the legacy project field stays null. */
  readonly overrideModel?: ModelSelection;
  readonly launched: Array<ThreadLaunch.ThreadLaunchInput>;
  readonly workspaceRoot?: string;
  readonly checkWorktreeBase?: ThreadLaunch.ThreadLaunchService["Service"]["checkWorktreeBase"];
  readonly hostedAppUrl?: string;
  /** The orchestrator refuses the new thread's mode, as under a managed ceiling. */
  readonly refusedByCeiling?: true;
  /** The thread is claimed, then a tag dispatch fails, so the launch fails with its thread live. */
  readonly diesOnTag?: boolean;
}) => {
  const projectId = ProjectId.make("project:client-target");
  const modelSelection = {
    instanceId: ProviderInstanceId.make("claudeAgent"),
    model: "claude-opus",
  };
  // The project's own default model, which a test can clear between launches.
  const projectDefaults: { model: ModelSelection | null } = {
    model: input.overrideModel === undefined ? modelSelection : null,
  };
  const layerDependencies = Layer.mergeAll(
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: Effect.succeed(input.providers ?? []),
    }),
    ServerSettings.layerTest({
      fallbackModelSelection: input.fallbackModel ?? null,
      ...(input.defaultRuntimeMode === undefined
        ? {}
        : { defaultRuntimeMode: input.defaultRuntimeMode }),
      ...(input.overrideModel === undefined
        ? {}
        : {
            projectSettingsFolded: true,
            projectSettingsOverrides: {
              [projectId]: { defaultModelSelection: input.overrideModel },
            },
          }),
    }),
    Layer.succeed(McpInvocationContext.McpInvocationContext, {
      environmentId: EnvironmentId.make("environment"),
      requestNamespace: "client:session-1",
      thread:
        input.callerThread === undefined
          ? undefined
          : {
              threadId: input.callerThread.id,
              providerSessionId: "session",
              providerInstanceId: input.callerThread.providerInstanceId,
            },
      client:
        input.callerThread === undefined
          ? {
              sessionId: "session-1",
              label: "Claude Code",
              access: input.runtimeModeCeiling,
              hostedAppUrl: input.hostedAppUrl,
              narrowedTo: input.narrowedTo,
            }
          : undefined,
      issuedAt: 0,
      capabilities: new Set(["orchestration" as const]),
    }),
    Layer.mock(ThreadManagement.ThreadManagementService)({
      // A thread exists once a launch started it.
      getThreadShell: (threadId) => {
        const existing = [...(input.threads ?? []), input.callerThread].find(
          (candidate) => candidate?.id === threadId,
        );
        if (existing !== undefined) return Effect.succeed(existing);
        const launch = input.launched.find((candidate) => candidate.threadId === threadId);
        return Effect.succeed(
          launch === undefined
            ? null
            : ({
                id: launch.threadId,
                projectId: launch.projectId,
                modelSelection: launch.modelSelection,
                deletedAt: null,
              } as unknown as OrchestrationV2ThreadShell),
        );
      },
      getDraftReservation: () => Effect.succeed(null),
    }),
    Layer.mock(ThreadLaunch.ThreadLaunchService)({
      checkWorktreeBase: input.checkWorktreeBase ?? (() => Effect.void),
      launch: (launch) => {
        input.launched.push(launch);
        if (input.diesOnTag) {
          return Effect.fail(
            new ThreadLaunch.ThreadLaunchError({
              operation: "update-thread",
              commandId: launch.commandId,
              projectId: launch.projectId,
              cause: "The tag dispatch failed.",
            }),
          );
        }
        if (input.refusedByCeiling) {
          return Effect.fail(
            new ThreadLaunch.ThreadLaunchError({
              operation: "create-thread",
              commandId: launch.commandId,
              projectId: launch.projectId,
              cause: new OrchestratorRuntimeModeAboveCeilingError({
                commandId: launch.commandId,
                threadId: launch.threadId ?? ThreadId.make("thread:refused"),
                refused: "mode",
                runtimeMode: launch.runtimeMode,
                maxRuntimeMode: "approval-required",
                organization: "Example Corp",
              }),
            }),
          );
        }
        return Effect.succeed({
          threadId: launch.threadId,
          projection: {
            thread: {
              id: launch.threadId,
              projectId: launch.projectId,
              title: launch.title,
              modelSelection: launch.modelSelection,
            },
            runs: [],
          },
          resumed: false,
        } as unknown as ThreadLaunch.ThreadLaunchResult);
      },
    }),
    Layer.mock(Project.ProjectService)({
      getById: (id) =>
        Effect.succeed(
          id === projectId
            ? Option.some({
                id,
                workspaceRoot: input.workspaceRoot ?? "/projects/client-target",
                defaultModelSelection: projectDefaults.model,
              } as unknown as ProjectRecord)
            : Option.none(),
        ),
    }),
    Layer.mock(PeerForwarding.PeerForwarding)({}),
    Layer.mock(ManagedProjectFolders.ManagedProjectFolders)({
      namedProjectsRoot: "/projects",
      ensureScratchProject: Effect.sync(() => {
        input.scratchProjects?.push(projectId);
        return { projectId };
      }),
    }),
    DocumentText.layer.pipe(Layer.provideMerge(NodeServices.layer)),
  ).pipe(
    Layer.provideMerge(GitVcsDriver.layer),
    Layer.provideMerge(VcsProcess.layer),
    Layer.provideMerge(
      ServerConfig.layerTest(process.cwd(), { prefix: "t3-client-launch-" }).pipe(
        Layer.provide(NodeServices.layer),
      ),
    ),
    Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
  );
  return { projectId, modelSelection, projectDefaults, dependencies: layerDependencies };
};

it.effect(
  "a client launches with the project's default model and mode, capped at its ceiling",
  () =>
    Effect.gen(function* () {
      const launchWith = Effect.fn("test.launchWith")(function* (
        runtimeModeCeiling: RuntimeMode,
        defaultRuntimeMode: RuntimeMode,
        params: {
          readonly title: string;
          readonly message?: string;
          readonly runtimeMode?: RuntimeMode;
          readonly targeted?: false;
          readonly overrideModel?: ModelSelection;
          readonly hostedAppUrl?: string;
          readonly refusedByCeiling?: true;
        },
      ) {
        const { targeted, overrideModel, hostedAppUrl, refusedByCeiling, ...input } = params;
        const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
        const { projectId, modelSelection, dependencies } = clientLaunchHarness({
          runtimeModeCeiling,
          defaultRuntimeMode,
          launched,
          ...(overrideModel === undefined ? {} : { overrideModel }),
          ...(hostedAppUrl === undefined ? {} : { hostedAppUrl }),
          ...(refusedByCeiling === undefined ? {} : { refusedByCeiling }),
        });
        const toolkit = yield* ProjectToolkit.pipe(
          Effect.provide(
            McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
              Layer.provide(dependencies),
            ),
          ),
        );
        const result = yield* toolkit
          .handle("t3_thread_launch", targeted === false ? input : { ...input, projectId })
          .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
        return { result: result.at(-1)?.result, launched, projectId, modelSelection };
      });

      const belowCeiling = yield* launchWith("full-access", "approval-required", {
        title: "Fix",
        message: "Fix the bug",
      });
      expect(belowCeiling.result).toMatchObject({
        projectId: belowCeiling.projectId,
        modelSelection: belowCeiling.modelSelection,
        link: `<t3-thread://v2/environment/${belowCeiling.launched[0]?.threadId}>`,
      });
      expect(belowCeiling.launched[0]?.runtimeMode).toBe("approval-required");
      expect(belowCeiling.launched[0]?.initialMessage?.senderThreadId).toBeUndefined();
      expect(belowCeiling.launched[0]?.openedByThreadId).toBeUndefined();
      expect(belowCeiling.launched[0]).not.toHaveProperty("tags");

      const aboveCeiling = yield* launchWith("auto-accept-edits", "full-access", {
        title: "Fix",
        hostedAppUrl: "https://t3.example.com",
      });
      expect(aboveCeiling.launched[0]?.runtimeMode).toBe("auto-accept-edits");
      expect(aboveCeiling.launched[0]).not.toHaveProperty("openedByThreadId");
      expect(aboveCeiling.launched[0]).not.toHaveProperty("tags");
      expect(aboveCeiling.result).toMatchObject({
        link: `https://t3.example.com/threads/environment/${encodeURIComponent(aboveCeiling.launched[0]?.threadId ?? "")}`,
      });

      const requested = yield* launchWith("full-access", "approval-required", {
        title: "Fix",
        runtimeMode: "auto",
      });
      expect(requested.launched[0]?.runtimeMode).toBe("auto");

      const escalated = yield* launchWith("auto-accept-edits", "auto-accept-edits", {
        title: "Fix",
        runtimeMode: "full-access",
      });
      expect(escalated.result).toMatchObject({ code: "runtime_mode_escalation_denied" });
      expect(escalated.launched).toHaveLength(0);

      const untargeted = yield* launchWith("full-access", "full-access", {
        title: "Fix",
        targeted: false,
      });
      expect(untargeted.result).toMatchObject({ code: "target_required" });

      const overrideModel = {
        instanceId: ProviderInstanceId.make("codex"),
        model: "gpt-settings",
      };
      const fromSettings = yield* launchWith("full-access", "full-access", {
        title: "Fix",
        overrideModel,
      });
      expect(fromSettings.launched[0]?.modelSelection).toEqual(overrideModel);

      // An administrator's ceiling the orchestrator enforces is named, not reported as unavailable.
      const managed = yield* launchWith("full-access", "full-access", {
        title: "Fix",
        refusedByCeiling: true,
      });
      expect(managed.result).toMatchObject({
        code: "invalid_request",
        message: "Example Corp limits threads to Supervised.",
      });
    }),
);

const delegatedFrom = {
  environmentId: EnvironmentId.make("environment-laptop"),
  threadId: ThreadId.make("thread:laptop-parent"),
  title: "Laptop parent",
};

/** One launch through the real tool, parameter decoding included. */
const launchAs = Effect.fn("test.launchAs")(function* (
  session: Pick<
    Parameters<typeof clientLaunchHarness>[0],
    "runtimeModeCeiling" | "narrowedTo" | "callerThread" | "threads" | "diesOnTag"
  >,
  params: {
    readonly openedByThreadId?: string;
    readonly tags?: ReadonlyArray<string>;
    readonly scratch?: true;
    readonly clientRequestId?: string;
    readonly delegatedFrom?: typeof delegatedFrom;
  },
  /** Shared by the attempts of one retried launch, so its thread is live on the second. */
  launched: Array<ThreadLaunch.ThreadLaunchInput> = [],
) {
  const scratchProjects: Array<ProjectId> = [];
  const { projectId, dependencies } = clientLaunchHarness({
    ...session,
    launched,
    scratchProjects,
  });
  const toolkit = yield* ProjectToolkit.pipe(
    Effect.provide(
      McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
    ),
  );
  const parts = yield* toolkit
    .handle("t3_thread_launch", {
      title: "Mate",
      message: "Do the work",
      ...(params.scratch === true ? {} : { projectId }),
      ...params,
    } as never)
    .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
  const last = parts.at(-1);
  return { result: last?.result, failureOrigin: last?.failureOrigin, launched, scratchProjects };
});

const narrowed = { runtimeMode: "auto", interactionMode: "default" } as const;
const captain = liveThreadShell(ThreadId.make("thread:captain"));

it.effect.each([
  { name: "auto", mode: "auto", session: { runtimeModeCeiling: "auto" } },
  {
    name: "auto-accept-edits",
    mode: "auto-accept-edits",
    session: { runtimeModeCeiling: "auto-accept-edits" },
  },
  {
    name: "approval-required",
    mode: "approval-required",
    session: { runtimeModeCeiling: "approval-required" },
  },
  {
    name: "narrowed",
    mode: "auto",
    session: { runtimeModeCeiling: "full-access", narrowedTo: narrowed },
  },
  {
    name: "a thread at auto",
    mode: "auto",
    session: {
      runtimeModeCeiling: "full-access",
      callerThread: liveThreadShell(ThreadId.make("thread:auto"), { runtimeMode: "auto" }),
    },
  },
] as const)(
  "refuses an opener or tags below full access and creates nothing: $name",
  ({ session, mode }) =>
    Effect.gen(function* () {
      for (const fields of [
        { openedByThreadId: captain.id },
        { tags: ["group:fleet"] },
        { openedByThreadId: captain.id, tags: ["group:fleet"] },
        { tags: [] },
      ]) {
        // Scratch creates its project first, so it shows a check that came too late.
        const { result, launched, scratchProjects } = yield* launchAs(
          { ...session, threads: [captain] },
          { ...fields, scratch: true },
        );
        expect(result, JSON.stringify(fields)).toMatchObject({
          code: "runtime_mode_escalation_denied",
          message: `Naming an opener or tags needs full access; this caller has ${mode}`,
        });
        expect(launched).toEqual([]);
        expect(scratchProjects).toEqual([]);
      }
    }),
);

it.effect("refuses a read-only client naming an opener or tags and creates nothing", () =>
  Effect.gen(function* () {
    for (const fields of [{ openedByThreadId: captain.id }, { tags: ["group:fleet"] }]) {
      const { result, launched, scratchProjects } = yield* launchAs(
        { runtimeModeCeiling: "read-only", threads: [captain] },
        { ...fields, scratch: true },
      );
      expect(result).toMatchObject({ code: "capability_denied" });
      expect(launched).toEqual([]);
      expect(scratchProjects).toEqual([]);
    }
  }),
);

it.effect("refuses an opener that does not resolve and creates nothing", () =>
  Effect.gen(function* () {
    const deleted = {
      ...liveThreadShell(ThreadId.make("thread:deleted")),
      deletedAt: captain.updatedAt,
    };
    for (const openedByThreadId of [ThreadId.make("thread:unknown"), deleted.id]) {
      const { result, launched, scratchProjects } = yield* launchAs(
        { runtimeModeCeiling: "full-access", threads: [deleted] },
        { openedByThreadId, scratch: true },
      );
      expect(result).toMatchObject({ code: "thread_not_found" });
      expect(launched).toEqual([]);
      expect(scratchProjects).toEqual([]);
    }
  }),
);

it.effect("refuses a tag or tag list the schema does not allow and creates nothing", () =>
  Effect.gen(function* () {
    for (const tags of [
      ["x".repeat(65)],
      ["group:\nfleet"],
      ["group:\u0000fleet"],
      ["group:\ud800"],
      ["   "],
      Array.from({ length: 17 }, (_, index) => `tag-${index}`),
    ]) {
      const { failureOrigin, launched, scratchProjects } = yield* launchAs(
        { runtimeModeCeiling: "full-access" },
        { tags, scratch: true },
      );
      expect(failureOrigin, JSON.stringify(tags)).toBe("parameters");
      expect(launched).toEqual([]);
      expect(scratchProjects).toEqual([]);
    }
  }),
);

it.effect("records a named opener and tags from a full-access outside session", () =>
  Effect.gen(function* () {
    const atLimit = Array.from({ length: 16 }, (_, index) => `${index}`.padEnd(64, "x"));
    const { result, launched } = yield* launchAs(
      { runtimeModeCeiling: "full-access", threads: [captain] },
      { openedByThreadId: captain.id, tags: atLimit },
    );
    expect(result).toMatchObject({ threadId: launched[0]?.threadId });
    expect(launched).toHaveLength(1);
    expect(launched[0]?.openedByThreadId).toBe(captain.id);
    expect(launched[0]?.tags).toEqual(atLimit);
    expect(launched[0]?.initialMessage?.senderThreadId).toBeUndefined();
    expect(launched[0]?.autoSettleDisabled).toBe(true);
  }),
);

it.effect("lets a full-access session in plan mode name an opener and tags", () =>
  Effect.gen(function* () {
    const { result, launched } = yield* launchAs(
      {
        runtimeModeCeiling: "full-access",
        narrowedTo: { runtimeMode: "full-access", interactionMode: "plan" },
        threads: [captain],
      },
      { openedByThreadId: captain.id, tags: ["group:fleet"] },
    );
    expect(result).toMatchObject({ threadId: launched[0]?.threadId });
    expect(launched[0]).toMatchObject({
      openedByThreadId: captain.id,
      tags: ["group:fleet"],
      runtimeMode: "full-access",
      interactionMode: "plan",
    });
  }),
);

const deletedCaptain = { ...captain, deletedAt: captain.updatedAt };

it.effect.each([
  { name: "an accepted launch whose reply was lost", diesOnTag: false },
  { name: "a launch that died on a tag", diesOnTag: true },
] as const)("a retry of $name survives its opener being deleted", ({ diesOnTag }) =>
  Effect.gen(function* () {
    const params = {
      openedByThreadId: captain.id,
      tags: ["group:fleet"],
      clientRequestId: "launch-once",
    };
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const first = yield* launchAs(
      { runtimeModeCeiling: "full-access", threads: [captain], diesOnTag },
      params,
      launched,
    );
    expect(first.result).toMatchObject(diesOnTag ? { code: "orchestration_error" } : {});

    const retried = yield* launchAs(
      { runtimeModeCeiling: "full-access", threads: [deletedCaptain] },
      params,
      launched,
    );
    // The same command again, so the launch service replays it rather than starting a thread.
    expect(retried.result).toMatchObject({ threadId: launched[0]?.threadId });
    expect(launched).toHaveLength(2);
    expect(launched[1]?.commandId).toBe(launched[0]?.commandId);
    expect(launched[1]?.tags).toEqual(["group:fleet"]);
  }),
);

it.effect("a retry with no live thread of its own still answers for its opener", () =>
  Effect.gen(function* () {
    const { result, launched, scratchProjects } = yield* launchAs(
      { runtimeModeCeiling: "full-access", threads: [deletedCaptain] },
      { openedByThreadId: captain.id, clientRequestId: "launch-never-landed", scratch: true },
    );
    expect(result).toMatchObject({ code: "thread_not_found" });
    expect(launched).toEqual([]);
    expect(scratchProjects).toEqual([]);

    // Whatever the retry finds, the mode answers first.
    const retried: Array<ThreadLaunch.ThreadLaunchInput> = [];
    yield* launchAs(
      { runtimeModeCeiling: "full-access", threads: [captain] },
      { openedByThreadId: captain.id, clientRequestId: "launch-once" },
      retried,
    );
    // Its own thread deleted too: nothing to replay, so the opener answers.
    const ownDeleted = { ...deletedCaptain, id: retried[0]?.threadId ?? captain.id };
    const gone = yield* launchAs(
      { runtimeModeCeiling: "full-access", threads: [deletedCaptain, ownDeleted] },
      { openedByThreadId: captain.id, clientRequestId: "launch-once" },
      retried,
    );
    expect(gone.result).toMatchObject({ code: "thread_not_found" });

    const below = yield* launchAs(
      { runtimeModeCeiling: "auto", threads: [deletedCaptain] },
      { openedByThreadId: captain.id, clientRequestId: "launch-once" },
      retried,
    );
    expect(below.result).toMatchObject({ code: "runtime_mode_escalation_denied" });
    expect(retried).toHaveLength(1);
  }),
);

const threadAt = (runtimeMode: RuntimeMode) =>
  liveThreadShell(ThreadId.make("thread:calling"), { runtimeMode });

it.effect("refuses a thread caller naming another opener and creates nothing", () =>
  Effect.gen(function* () {
    const { result, launched, scratchProjects } = yield* launchAs(
      {
        runtimeModeCeiling: "full-access",
        callerThread: threadAt("full-access"),
        threads: [captain],
      },
      { openedByThreadId: captain.id, clientRequestId: "launch-once", scratch: true },
    );
    expect(result).toMatchObject({
      code: "invalid_request",
      message: "a calling thread is its launch's opener",
    });
    expect(launched).toEqual([]);
    expect(scratchProjects).toEqual([]);
  }),
);

it.effect("lets a thread caller name itself as the opener", () =>
  Effect.gen(function* () {
    const caller = threadAt("full-access");
    const { result, launched } = yield* launchAs(
      { runtimeModeCeiling: "full-access", callerThread: caller },
      { openedByThreadId: caller.id },
    );
    expect(result).toMatchObject({ threadId: launched[0]?.threadId });
    expect(launched[0]?.openedByThreadId).toBe(caller.id);
    expect(launched[0]?.initialMessage?.senderThreadId).toBe(caller.id);
    expect(launched[0]?.autoSettleDisabled).toBeUndefined();
  }),
);

it.effect.each(["full-access", "auto"] as const)(
  "refuses delegatedFrom from a thread at %s with no link and creates nothing",
  (runtimeMode) =>
    Effect.gen(function* () {
      const { result, launched, scratchProjects } = yield* launchAs(
        { runtimeModeCeiling: "full-access", callerThread: threadAt(runtimeMode) },
        { delegatedFrom, scratch: true },
      );
      expect(result).toMatchObject({
        code: "invalid_request",
        message:
          "delegatedFrom is set by a linked environment; your thread is recorded as the opener",
      });
      expect(launched).toEqual([]);
      expect(scratchProjects).toEqual([]);
    }),
);

it.effect("keeps delegatedFrom from a thread a link started, and from an outside client", () =>
  Effect.gen(function* () {
    const linkOrigin = { sessionId: "laptop", label: "Laptop", access: "full-access" } as const;
    const linkedThread = { ...threadAt("full-access"), linkOrigin };
    const fromLinkedThread = yield* launchAs(
      { runtimeModeCeiling: "full-access", callerThread: linkedThread },
      { delegatedFrom },
    );
    expect(fromLinkedThread.launched[0]).toMatchObject({ delegatedFrom, linkOrigin });

    // The orchestrator drops it for a thread with no link: only stamped work names a parent.
    const outside = yield* launchAs({ runtimeModeCeiling: "full-access" }, { delegatedFrom });
    expect(outside.launched[0]?.delegatedFrom).toEqual(delegatedFrom);
    expect(outside.launched[0]).not.toHaveProperty("linkOrigin");
  }),
);

it.effect("forwards an opener and tags for the linked environment to check", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const forwarded: Array<unknown> = [];
    const harness = clientLaunchHarness({ runtimeModeCeiling: "full-access", launched });
    const dependencies = Layer.merge(
      harness.dependencies,
      Layer.mock(PeerForwarding.PeerForwarding)({
        call: (_scope, _tool, _target, params) =>
          Effect.sync(() => {
            forwarded.push(params);
            return {
              threadId: "thread:there",
              projectId: harness.projectId,
              modelSelection: harness.modelSelection,
              runId: null,
              status: null,
            } as never;
          }),
      }),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    // The opener lives there, so this side cannot resolve it.
    const params = {
      projectId: harness.projectId,
      title: "Mate",
      openedByThreadId: ThreadId.make("thread:only-there"),
      tags: ["group:fleet"],
    };
    yield* toolkit
      .handle("t3_thread_launch", { ...params, environmentId: EnvironmentId.make("there") })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(forwarded).toEqual([expect.objectContaining(params)]);
    expect(launched).toEqual([]);
  }),
);

it.effect("a launch steps an inherited mode down to the provider's, and refuses one it lacks", () =>
  Effect.gen(function* () {
    // Pi offers no Auto; a mode a provider lacks would run as Supervised.
    const pi = ProviderInstanceId.make("pi");
    const launchPi = Effect.fn("test.launchPi")(function* (runtimeMode?: RuntimeMode) {
      const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
      const { projectId, dependencies } = clientLaunchHarness({
        runtimeModeCeiling: "auto",
        launched,
        providers: [
          {
            instanceId: pi,
            driver: ProviderDriverKind.make("pi"),
            enabled: true,
            installed: true,
            status: "ready",
            version: null,
            auth: { status: "authenticated" },
            checkedAt: "2026-01-01T00:00:00Z",
            models: [],
            slashCommands: [],
            skills: [],
            supportedRuntimeModes: ["approval-required", "auto-accept-edits", "full-access"],
          },
        ],
      });
      const toolkit = yield* ProjectToolkit.pipe(
        Effect.provide(
          McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(
            Layer.provide(dependencies),
          ),
        ),
      );
      const result = yield* toolkit
        .handle("t3_thread_launch", {
          projectId,
          title: "Fix",
          modelSelection: { instanceId: pi, model: "pi-model" },
          ...(runtimeMode === undefined ? {} : { runtimeMode }),
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
      return { result: result.at(-1)?.result, launched };
    });

    const inherited = yield* launchPi();
    expect(inherited.launched[0]?.runtimeMode).toBe("auto-accept-edits");

    const requested = yield* launchPi("auto");
    expect(requested.result).toMatchObject({ code: "invalid_request" });
    expect(requested.launched).toHaveLength(0);

    const offered = yield* launchPi("approval-required");
    expect(offered.launched[0]?.runtimeMode).toBe("approval-required");
  }),
);

it.effect("a launch retried with the same clientRequestId replays the first one", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launch = (clientRequestId: string | undefined) =>
      toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          projectId,
          message: "Fix the bug",
          ...(clientRequestId === undefined ? {} : { clientRequestId }),
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    yield* launch("fix-1");
    yield* launch("fix-1");
    yield* launch("fix-2");
    yield* launch(undefined);
    yield* launch(undefined);
    const ids = launched.map((input) => [input.commandId, input.threadId]);
    // The same key sends the same command and thread ids, which the launch
    // service replays instead of starting a second thread.
    expect(ids[0]).toEqual(ids[1]);
    expect(ids[0]?.[0]).toMatch(/^mcp:launch:[0-9a-f]{64}$/);
    expect(ids[2]).not.toEqual(ids[0]);
    // Without a key every launch is new.
    expect(ids[3]).not.toEqual(ids[4]);
  }),
);

it.effect("a launch key of any length or content gives a short id and never a defect", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launch = (clientRequestId: string) =>
      toolkit
        .handle("t3_thread_launch", { title: "Fix", projectId, clientRequestId })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    // Percent-encoding would grow this six times; scratch folders are named from the id.
    yield* launch("\u00e9".repeat(256));
    expect(launched.map((input) => input.commandId)).toEqual([
      expect.stringMatching(/^mcp:launch:[0-9a-f]{64}$/),
    ]);

    const loneSurrogate = yield* launch("key-\ud800").pipe(Effect.exit);
    expect(Exit.isFailure(loneSurrogate) && Cause.hasDies(loneSurrogate.cause)).toBe(false);
    expect(launched).toHaveLength(1);
  }),
);

it.effect("a retried launch replays after the project loses its default model", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, modelSelection, projectDefaults, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launch = toolkit
      .handle("t3_thread_launch", { title: "Fix", projectId, clientRequestId: "fix-1" })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    yield* launch;
    projectDefaults.model = null;
    const retried = (yield* launch).at(-1)?.result;
    expect(retried).toMatchObject({ projectId, modelSelection });
    expect(launched.map((input) => input.threadId)).toEqual([
      launched[0]?.threadId,
      launched[0]?.threadId,
    ]);
  }),
);

it.effect("a launch binds only an existing checkout that is one of the project's worktrees", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-launch-worktree-" });
    const repo = path.join(root, "repo");
    const worktree = path.join(root, "feature");
    const outside = path.join(root, "outside");
    yield* fileSystem.makeDirectory(repo);
    yield* fileSystem.makeDirectory(outside);

    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      workspaceRoot: repo,
    });
    const git = yield* GitVcsDriver.GitVcsDriver.pipe(Effect.provide(dependencies));
    for (const args of [
      ["init", "-b", "main"],
      ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
      ["worktree", "add", "-b", "feature", worktree],
    ]) {
      yield* git.execute({ operation: "test.setupRepo", cwd: repo, args });
    }
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launchInto = (worktreePath: string) =>
      toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          projectId,
          workspaceStrategy: { type: "existing_worktree", worktreePath },
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    expect((yield* launchInto(worktree)).at(-1)?.result).toMatchObject({ projectId });
    expect((yield* launchInto(repo)).at(-1)?.result).toMatchObject({ projectId });
    for (const elsewhere of [outside, path.join(worktree, "..", "outside"), "/"]) {
      expect((yield* launchInto(elsewhere)).at(-1)?.result).toMatchObject({
        code: "invalid_request",
      });
    }
    expect(launched.map((launch) => launch.workspaceStrategy)).toEqual([
      { type: "existing_worktree", worktreePath: worktree },
      { type: "existing_worktree", worktreePath: repo },
    ]);

    yield* fileSystem.remove(worktree, { recursive: true });
    yield* fileSystem.makeDirectory(worktree);
    expect((yield* launchInto(worktree)).at(-1)?.result).toMatchObject({
      code: "invalid_request",
    });
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

it.effect("a launch into a new worktree creates nothing when its base ref has no commit", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      checkWorktreeBase: ({ projectId, workspaceStrategy }) =>
        workspaceStrategy.type === "worktree" && workspaceStrategy.baseRef === "t3/renamed"
          ? Effect.fail(
              new ThreadLaunch.ThreadLaunchBaseRefError({
                projectId,
                projectTitle: "Client target",
                workspaceRoot: "/projects/client-target",
                baseRef: workspaceStrategy.baseRef,
              }),
            )
          : Effect.void,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launchFrom = (baseRef: string) =>
      toolkit
        .handle("t3_thread_launch", {
          title: "Fix",
          projectId,
          workspaceStrategy: { type: "worktree", baseRef, startFromOrigin: false },
        })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    const refused = (yield* launchFrom("t3/renamed")).at(-1)?.result;
    expect(refused).toMatchObject({ code: "invalid_request" });
    expect((refused as { message: string }).message).toContain(
      'Base ref "t3/renamed" does not resolve to a commit in project "Client target" (/projects/client-target). No thread was created.',
    );
    expect(launched).toHaveLength(0);

    expect((yield* launchFrom("main")).at(-1)?.result).toMatchObject({ projectId });
    expect(launched).toHaveLength(1);
  }),
);

it.effect("a retried worktree launch replays after its base ref is gone", () =>
  Effect.gen(function* () {
    const launched: Array<ThreadLaunch.ThreadLaunchInput> = [];
    const base = { exists: true };
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "auto",
      launched,
      checkWorktreeBase: ({ projectId, workspaceStrategy }) =>
        base.exists || workspaceStrategy.type !== "worktree"
          ? Effect.void
          : Effect.fail(
              new ThreadLaunch.ThreadLaunchBaseRefError({
                projectId,
                projectTitle: "Client target",
                workspaceRoot: "/projects/client-target",
                baseRef: workspaceStrategy.baseRef,
              }),
            ),
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const launch = toolkit
      .handle("t3_thread_launch", {
        title: "Fix",
        projectId,
        clientRequestId: "fix-worktree",
        workspaceStrategy: { type: "worktree", baseRef: "feature", startFromOrigin: false },
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    yield* launch;
    base.exists = false;
    expect((yield* launch).at(-1)?.result).toMatchObject({ projectId });
    expect(launched.map((input) => input.threadId)).toEqual([
      launched[0]?.threadId,
      launched[0]?.threadId,
    ]);
  }),
);

it.effect("a client launches with the fallback for an exhausted default", () =>
  Effect.gen(function* () {
    const launched: ThreadLaunch.ThreadLaunchInput[] = [];
    const fallbackModel = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
    const providers: ServerProvider[] = ["claudeAgent", "codex"].map((driver) => ({
      instanceId: ProviderInstanceId.make(driver),
      driver: ProviderDriverKind.make(driver),
      enabled: true,
      installed: true,
      status: "ready",
      version: null,
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00Z",
      models: [],
      slashCommands: [],
      skills: [],
      ...(driver === "claudeAgent"
        ? {
            usageLimits: {
              checkedAt: "2026-01-01T00:00:00Z",
              windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 100 }],
            },
          }
        : {}),
    }));
    const { projectId, dependencies } = clientLaunchHarness({
      runtimeModeCeiling: "full-access",
      launched,
      fallbackModel,
      providers,
    });
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const result = yield* toolkit
      .handle("t3_thread_launch", {
        projectId,
        title: "Fallback",
      })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    expect(result.at(-1)?.result).toMatchObject({
      modelSelection: fallbackModel,
    });
    expect(launched[0]?.modelSelection).toEqual(fallbackModel);
  }),
);

it.effect("deleting a project through MCP also discards its clone record", () =>
  Effect.gen(function* () {
    const discarded: Array<ProjectId> = [];
    const harness = clientLaunchHarness({ runtimeModeCeiling: "full-access", launched: [] });
    const dependencies = Layer.merge(
      harness.dependencies,
      Layer.mergeAll(
        Layer.mock(Project.ProjectService)({
          delete: (input) =>
            Effect.succeed({
              id: input.projectId,
              title: "client-target",
              workspaceRoot: "/projects/client-target",
              repositoryIdentity: null,
              faviconPath: null,
              defaultModelSelection: null,
              defaultThreadEnvMode: null,
              autoPull: false,
              projectIcon: null,
              scripts: [],
              createdAt: "2026-01-01T00:00:00.000Z",
              updatedAt: "2026-01-01T00:00:00.000Z",
              deletedAt: "2026-01-01T00:00:00.000Z",
            }),
        }),
        Layer.mock(ProjectCloneTracker.ProjectCloneTracker)({
          discard: (projectId) => Effect.sync(() => void discarded.push(projectId)),
        }),
      ),
    );
    const toolkit = yield* ProjectToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(ProjectHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );

    yield* toolkit
      .handle("t3_project_delete", { projectId: harness.projectId })
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));

    expect(discarded).toEqual([harness.projectId]);
  }),
);
