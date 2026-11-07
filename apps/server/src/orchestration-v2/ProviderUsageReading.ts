import type { ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";

/**
 * The latest snapshot of a provider instance, which carries its usage windows. The orchestrator
 * reads this once at build, so its layer must wrap that build. No reading counts as room.
 */
export const ProviderUsageReading = Context.Reference<
  (instanceId: ProviderInstanceId) => Effect.Effect<ServerProvider | undefined>
>("t3/orchestration-v2/ProviderUsageReading", {
  defaultValue: () => () => Effect.undefined,
});

export const layerFromProviderRegistry = Layer.effect(
  ProviderUsageReading,
  Effect.gen(function* () {
    const registry = yield* ProviderRegistry.ProviderRegistry;
    return Effect.fn("ProviderUsageReading.read")(function* (instanceId: ProviderInstanceId) {
      const providers = yield* registry.getProviders.pipe(
        // A failed read must not stop a thread.
        Effect.catchCause(() => Effect.succeed([])),
      );
      return providers.find((provider) => provider.instanceId === instanceId);
    });
  }),
);
