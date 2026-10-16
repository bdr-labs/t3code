const NIGHTLY_SERVER_VERSION_PATTERN = /^[^-+]+-(?:nightly|preview)\.\d{8}\.\d+$/;

export function formatAppDisplayName(input: {
  readonly baseName: string;
  readonly stageLabel: string;
}): string {
  if (input.stageLabel.trim().toLowerCase() === "latest") {
    return input.baseName;
  }

  return `${input.baseName} (${input.stageLabel})`;
}

export function resolveServerBackedAppStageLabel(input: {
  readonly primaryServerVersion: string | null | undefined;
  readonly fallbackStageLabel: string;
}): string {
  return input.primaryServerVersion &&
    NIGHTLY_SERVER_VERSION_PATTERN.test(input.primaryServerVersion)
    ? "Nightly"
    : input.fallbackStageLabel;
}

export function resolveServerBackedAppDisplayName(input: {
  readonly baseName: string;
  readonly fallbackDisplayName: string;
  readonly fallbackStageLabel: string;
  readonly primaryServerVersion: string | null | undefined;
}): string {
  const stageLabel = resolveServerBackedAppStageLabel({
    primaryServerVersion: input.primaryServerVersion,
    fallbackStageLabel: input.fallbackStageLabel,
  });

  return stageLabel === input.fallbackStageLabel
    ? input.fallbackDisplayName
    : formatAppDisplayName({ baseName: input.baseName, stageLabel });
}

export interface CustomizedBuild {
  readonly recipe: string;
  /** The first 7 characters of the recipe, for the sidebar label. */
  readonly shortRecipe: string;
  readonly builtAt: Date | null;
}

/** Reads the build stamp t3code-customize bakes in ("<recipe> <ISO time>"); null in stock builds. */
export function parseCustomizedBuild(raw: string | null | undefined): CustomizedBuild | null {
  const [recipe, builtAt] = (raw ?? "").trim().split(/\s+/, 2);
  if (!recipe) {
    return null;
  }
  const date = builtAt ? new Date(builtAt) : null;
  return {
    recipe,
    shortRecipe: recipe.slice(0, 7),
    builtAt: date && !Number.isNaN(date.getTime()) ? date : null,
  };
}
