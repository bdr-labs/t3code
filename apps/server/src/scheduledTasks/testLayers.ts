import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";

/** What ScheduledTaskService reads to pick a fresh thread's model, with no fallback configured. */
export const layerNewThreadModelTest = Layer.mergeAll(
  ServerSettings.layerTest(),
  Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
  Layer.mock(ProjectService.ProjectService)({ getById: () => Effect.succeedNone }),
);
