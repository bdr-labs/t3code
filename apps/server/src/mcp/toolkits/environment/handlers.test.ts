import { NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
  type ServerProvider,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as PeerLinks from "../../../peer/PeerLinks.ts";
import {
  descriptorOf,
  layerLinkingEnvironment,
  linkTo,
  servePeer,
} from "../../../peer/PeerLinks.testkit.ts";
import * as PeerMcpClient from "../../../peer/PeerMcpClient.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as EnvironmentHandlers from "./handlers.ts";
import { EnvironmentToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:preferences");
const threadId = ThreadId.make("thread:preferences");

it.effect("refuses a preferences update when the caller's turn ends while it waits", () =>
  Effect.gen(function* () {
    const caller = yield* Ref.make<OrchestrationV2ThreadShell>(liveThreadShell(threadId));
    const updates = yield* Ref.make(0);
    const checked = yield* Deferred.make<void>();
    const layerDependencies = Layer.mergeAll(
      ThreadCommandExecutor.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "provider:preferences",
        thread: {
          threadId,
          providerSessionId: "provider:preferences",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Ref.get(caller).pipe(Effect.tap(() => Deferred.succeed(checked, undefined))),
      }),
      Layer.mock(Environment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId,
          label: "Test",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0",
          capabilities: { repositoryIdentity: false },
        }),
      }),
      Layer.mock(Settings.ServerSettingsService)({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        updateSettings: () =>
          Ref.update(updates, (count) => count + 1).pipe(Effect.as(DEFAULT_SERVER_SETTINGS)),
      }),
    );
    yield* Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* executor
        .withLock(
          threadId,
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const update = yield* toolkit
        .handle("t3_environment_preferences_update", { newWorktreesStartFromOrigin: true })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.forkChild);
      yield* Deferred.await(checked);
      yield* Ref.update(caller, (shell) => ({ ...shell, activeRunId: null }));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      const result = yield* Fiber.join(update);
      expect(result.at(-1)?.result).toMatchObject({ code: "parent_not_active" });
      expect(yield* Ref.get(updates)).toBe(0);
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
          Layer.provideMerge(layerDependencies),
        ),
      ),
    );
  }),
);

const provider = (instanceId: string, fields: Partial<ServerProvider>): ServerProvider => ({
  instanceId: ProviderInstanceId.make(instanceId),
  driver: ProviderDriverKind.make("claudeAgent"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-06T10:00:00.000Z",
  models: [],
  slashCommands: [],
  skills: [],
  ...fields,
});

const usageLayer = (
  providers: ReadonlyArray<ServerProvider>,
  call: PeerForwarding.PeerForwarding["Service"]["call"] = () => Effect.die("not forwarded"),
) =>
  McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
    Layer.provideMerge(
      Layer.mergeAll(
        ThreadCommandExecutor.layer,
        Layer.succeed(McpInvocationContext.McpInvocationContext, {
          environmentId,
          requestNamespace: "client:usage",
          thread: undefined,
          client: { sessionId: "usage", label: "Client", access: "read-only" },
          capabilities: new Set(["orchestration" as const]),
          issuedAt: 0,
        }),
        Layer.mock(ThreadManagement.ThreadManagementService)({}),
        Layer.mock(Environment.ServerEnvironment)({
          getDescriptor: Effect.succeed({
            environmentId,
            label: "Test",
            platform: { os: "linux", arch: "x64" },
            serverVersion: "0.0.0",
            capabilities: { repositoryIdentity: false },
          }),
        }),
        Layer.mock(Settings.ServerSettingsService)({}),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed(providers),
        }),
        Layer.mock(PeerForwarding.PeerForwarding)({ call }),
      ),
    ),
  );

it.effect("t3_usage_limits lists enabled providers that report limits, and no other", () =>
  Effect.gen(function* () {
    const toolkit = yield* EnvironmentToolkit;
    const chunks = yield* toolkit
      .handle("t3_usage_limits", {})
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(chunks.at(-1)?.isFailure).toBe(false);
    expect(chunks.at(-1)?.encodedResult).toEqual({
      providers: [
        {
          instanceId: "claude-work",
          driver: "claudeAgent",
          displayName: "Claude work",
          plan: "Claude Max Subscription",
          checkedAt: "2026-11-06T10:00:00.000Z",
          windows: [
            {
              id: "weekly",
              kind: "weekly",
              label: "Weekly",
              usedPercent: 41,
              resetsAt: "2026-11-09T10:00:00.000Z",
              windowDurationMins: 10_080,
              checkedAt: "2026-11-06T09:59:00.000Z",
            },
            {
              id: "session",
              kind: "session",
              label: "Session",
              usedPercent: 0,
              resetPending: true,
            },
          ],
        },
        {
          instanceId: "cursor",
          driver: "claudeAgent",
          plan: "Cursor account",
          checkedAt: "2026-11-06T10:00:00.000Z",
          windows: [],
          unavailable: { reason: "probeFailed", message: "Cursor could not read usage limits." },
        },
        {
          instanceId: "failed-read",
          driver: "claudeAgent",
          plan: "Claude Pro Subscription",
          checkedAt: "2026-11-06T08:00:00.000Z",
          windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 12 }],
        },
        {
          instanceId: "signed-out-after-reading",
          driver: "claudeAgent",
          checkedAt: "2026-11-06T10:05:00.000Z",
          windows: [],
          unavailable: { reason: "probeFailed", message: "Not signed in." },
        },
        {
          instanceId: "never-signed-in",
          driver: "claudeAgent",
          checkedAt: "2026-11-06T10:05:00.000Z",
          windows: [],
          unavailable: { reason: "probeFailed", message: "Not signed in." },
        },
      ],
    });
  }).pipe(
    Effect.provide(
      usageLayer([
        provider("claude-work", {
          displayName: "Claude work",
          auth: { status: "authenticated", label: "Claude Max Subscription" },
          usageLimits: {
            checkedAt: "2026-11-06T10:00:00.000Z",
            windows: [
              {
                id: "weekly",
                kind: "weekly",
                label: "Weekly",
                source: "account",
                checkedAt: "2026-11-06T09:59:00.000Z",
                usedPercent: 41,
                resetsAt: "2026-11-09T10:00:00.000Z",
                windowDurationMins: 10_080,
              },
              {
                id: "session",
                kind: "session",
                label: "Session",
                usedPercent: 0,
                resetPending: true,
              },
            ],
          },
        }),
        provider("codex-disabled", {
          enabled: false,
          status: "disabled",
          auth: { status: "authenticated", label: "ChatGPT Pro Subscription" },
          usageLimits: {
            checkedAt: "2026-11-06T10:00:00.000Z",
            windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 90 }],
          },
        }),
        provider("cursor", {
          auth: { status: "authenticated", label: "Cursor account" },
          usageLimits: {
            checkedAt: "2026-11-06T10:00:00.000Z",
            windows: [],
            unavailable: { reason: "probeFailed", message: "Cursor could not read usage limits." },
          },
        }),
        // A failed read keeps the last reading: an old checkedAt and no flag.
        provider("failed-read", {
          auth: { status: "authenticated", label: "Claude Pro Subscription" },
          usageLimits: {
            checkedAt: "2026-11-06T08:00:00.000Z",
            windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 12 }],
          },
        }),
        provider("signed-out-after-reading", {
          status: "error",
          auth: { status: "unauthenticated", label: "Sign in with Acme" },
          checkedAt: "2026-11-06T10:05:00.000Z",
          usageLimits: {
            checkedAt: "2026-11-06T08:00:00.000Z",
            windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 77 }],
          },
        }),
        provider("never-signed-in", {
          status: "error",
          auth: { status: "unauthenticated" },
          checkedAt: "2026-11-06T10:05:00.000Z",
        }),
        provider("uninstalled", {
          installed: false,
          auth: { status: "authenticated", label: "Claude Max Subscription" },
          usageLimits: {
            checkedAt: "2026-11-06T08:00:00.000Z",
            windows: [{ id: "weekly", kind: "weekly", label: "Weekly", usedPercent: 55 }],
          },
        }),
        provider("no-limits", { auth: { status: "unknown" } }),
      ]),
    ),
  ),
);

it.effect("t3_usage_limits runs in the linked environment it names", () => {
  const forwarded: Array<string> = [];
  return Effect.gen(function* () {
    const toolkit = yield* EnvironmentToolkit;
    const chunks = yield* toolkit
      .handle("t3_usage_limits", { environmentId: EnvironmentId.make("environment:linked") })
      .pipe(Stream.unwrap, Stream.runCollect);
    expect(chunks.at(-1)?.encodedResult).toEqual({ providers: [] });
    expect(forwarded).toEqual(["t3_usage_limits", "environment:linked"]);
  }).pipe(
    Effect.provide(
      usageLayer([], (_scope, tool, target) =>
        Effect.sync(() => {
          forwarded.push(tool.name, target);
          return { providers: [] } as never;
        }),
      ),
    ),
  );
});

it.effect("t3_usage_limits survives the trip from a real linked environment", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const box = descriptorOf("environment-box", "Box");
      const peer = yield* servePeer(
        box,
        McpHttpServer.toolkitRegistration(EnvironmentToolkit, EnvironmentHandlers.layer).pipe(
          Layer.provide(ThreadCommandExecutor.layer),
          Layer.provide(Layer.mock(ThreadManagement.ThreadManagementService)({})),
          Layer.provide(
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Effect.succeed([
                provider("full", {
                  displayName: "Full",
                  auth: { status: "authenticated", label: "Claude Max Subscription" },
                  usageLimits: {
                    checkedAt: "2026-11-06T10:00:00.000Z",
                    windows: [
                      {
                        id: "weekly",
                        kind: "weekly",
                        label: "Weekly",
                        usedPercent: 41,
                        resetsAt: "2026-11-09T10:00:00.000Z",
                        resetPending: false,
                        windowDurationMins: 10_080,
                        checkedAt: "2026-11-06T09:59:00.000Z",
                      },
                    ],
                    unavailable: { reason: "probeFailed", message: "Could not read usage." },
                  },
                }),
                provider("bare", {
                  usageLimits: {
                    checkedAt: "2026-11-06T10:00:00.000Z",
                    windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 3 }],
                  },
                }),
              ]),
            }),
          ),
        ),
      );
      const context = yield* Layer.build(
        layerLinkingEnvironment(descriptorOf("environment-a", "A")),
      );
      yield* linkTo(Context.get(context, PeerLinks.PeerLinks), peer);
      const answer = yield* Context.get(context, PeerMcpClient.PeerMcpClient).call({
        environmentId: box.environmentId,
        tool: "t3_usage_limits",
        arguments: {},
        limits: { runtimeMode: "full-access", interactionMode: "default" },
        success: EnvironmentToolkit.tools.t3_usage_limits.successSchema,
      });
      expect(answer).toEqual({
        providers: [
          {
            instanceId: "full",
            driver: "claudeAgent",
            displayName: "Full",
            plan: "Claude Max Subscription",
            checkedAt: "2026-11-06T10:00:00.000Z",
            windows: [
              {
                id: "weekly",
                kind: "weekly",
                label: "Weekly",
                usedPercent: 41,
                resetsAt: "2026-11-09T10:00:00.000Z",
                resetPending: false,
                windowDurationMins: 10_080,
                checkedAt: "2026-11-06T09:59:00.000Z",
              },
            ],
            unavailable: { reason: "probeFailed", message: "Could not read usage." },
          },
          {
            instanceId: "bare",
            driver: "claudeAgent",
            checkedAt: "2026-11-06T10:00:00.000Z",
            windows: [{ id: "session", kind: "session", label: "Session", usedPercent: 3 }],
          },
        ],
      });
    }),
  ).pipe(Effect.provide(NodeHttpServer.layerTest)),
);
