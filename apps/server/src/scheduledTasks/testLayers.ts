import type { ServerProvider } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";

/** What ScheduledTaskService reads of the providers, with no fallback configured. */
export const layerProvidersTest = (providers: Effect.Effect<ReadonlyArray<ServerProvider>>) =>
  Layer.mergeAll(
    ServerSettings.layerTest(),
    Layer.mock(ProviderRegistry.ProviderRegistry)({
      getProviders: providers,
      streamChanges: Stream.never,
    }),
    Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
  );

export const layerNewThreadModelTest = layerProvidersTest(Effect.succeed([]));
