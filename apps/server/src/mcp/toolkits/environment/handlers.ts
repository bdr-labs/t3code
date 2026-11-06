import {
  OrchestratorMcpFailure,
  type OrchestratorMcpUsageLimitsResult,
  type ServerProvider,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Struct from "effect/Struct";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ProviderRegistry from "../../../provider/ProviderRegistry.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { EnvironmentToolkit } from "./tools.ts";

export function preferences(settings: ServerSettings) {
  const {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity,
    sourceControlWritingStyle,
  } = settings;
  const characters = Array.from(sourceControlWritingStyle.customInstructions);
  return {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity: { profile: backgroundActivity.profile },
    sourceControlWritingStyle: {
      ...sourceControlWritingStyle,
      customInstructions: characters.slice(0, 4000).join(""),
      truncated: characters.length > 4000,
    },
  };
}
// An absent key stays absent: `undefined` reaches a linked machine as `null`, which its decode refuses.
const usageLimits = (
  providers: ReadonlyArray<ServerProvider>,
): OrchestratorMcpUsageLimitsResult => ({
  providers: providers.flatMap((provider) => {
    if (!provider.enabled || !provider.installed) return [];
    const identity = Struct.pick(provider, ["instanceId", "driver", "displayName"]);
    if (provider.auth.status === "unauthenticated") {
      return [
        {
          ...identity,
          checkedAt: provider.checkedAt,
          windows: [],
          unavailable: { reason: "probeFailed" as const, message: "Not signed in." },
        },
      ];
    }
    const limits = provider.usageLimits;
    if (limits === undefined) return [];
    // An API key's label carries the name its owner gave it.
    const plan = provider.auth.type === "api-key" ? "API key" : provider.auth.label;
    return [
      {
        ...identity,
        ...(plan === undefined ? {} : { plan }),
        ...Struct.pick(limits, ["checkedAt", "unavailable"]),
        windows: limits.windows.map((window) =>
          Struct.pick(window, [
            "id",
            "kind",
            "label",
            "usedPercent",
            "resetsAt",
            "resetPending",
            "windowDurationMins",
            "checkedAt",
          ]),
        ),
      },
    ];
  }),
});
const access = Effect.gen(function* () {
  const context = yield* readCaller();
  const environment = yield* Environment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  if (descriptor.environmentId !== context.scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  return { ...context, descriptor, settings: yield* Settings.ServerSettingsService };
});
export const layer = McpToolAccess.toLayer(EnvironmentToolkit, {
  t3_environment_read: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const { descriptor, settings } = yield* access;
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        serverVersion: descriptor.serverVersion,
        platform: descriptor.platform,
        preferences: preferences(current),
      };
    }),
  ),
  t3_usage_limits: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      yield* access;
      const registry = yield* ProviderRegistry.ProviderRegistry;
      return usageLimits(yield* registry.getProviders);
    }),
  ),
  t3_environment_preferences_update: McpToolAccess.writesEnvironment((patch, check) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const update = Effect.gen(function* () {
        // The turn may have ended, or the thread's modes changed, while this waited for the lock.
        yield* check;
        const { settings } = yield* access;
        return preferences(
          yield* settings.updateSettings(patch).pipe(Effect.mapError(unavailable)),
        );
      });
      return yield* scope.thread === undefined
        ? update
        : executor.withLock(scope.thread.threadId, update);
    }),
  ),
});
