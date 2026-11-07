import type {
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { formatResetsIn, windowBindsModel } from "@t3tools/shared/usageLimits";

import { composerLimitResetPending, composerLimitsFreshness } from "./ComposerStats.logic";

/**
 * Suggests running the same model on another signed-in subscription: when the
 * current one is on pace to run out before it resets, or when another one is
 * about to reset with much of its weekly allowance unused.
 */
export interface SubscriptionSwitchSuggestion {
  readonly kind: "pressure" | "expiring";
  readonly instanceId: ProviderInstanceId;
  /** The model's slug on the target subscription. */
  readonly model: string;
  readonly providerName: string;
  readonly modelName: string;
  readonly reason: string;
}

/** Used at or above this, a window counts as running out whatever its pace. */
export const SWITCH_USED_PERCENT = 90;
/** Projected to reach this by its reset, a window counts as running out. */
export const SWITCH_PROJECTED_PERCENT = 100;
/** A pace from the first slice of a window is noise. */
const MIN_ELAPSED_FRACTION = 0.1;
/** Another subscription's weekly allowance counts as expiring within this. */
export const EXPIRING_WITHIN_MS = 24 * 60 * 60_000;
/** ...when at most this much of it is used. */
export const EXPIRING_MAX_USED_PERCENT = 60;

export interface WindowPace {
  readonly window: ServerProviderUsageWindow;
  readonly usedPercent: number;
  /** Where usage lands at the reset if it keeps its pace so far; null when too early to tell. */
  readonly projectedPercent: number | null;
  readonly resetInMs: number | null;
}

export function windowPace(window: ServerProviderUsageWindow, nowMs: number): WindowPace {
  if (composerLimitResetPending(window, nowMs)) {
    return { window, usedPercent: 0, projectedPercent: null, resetInMs: null };
  }
  const resetMs = window.resetsAt === undefined ? NaN : Date.parse(window.resetsAt);
  const resetInMs = Number.isFinite(resetMs) ? Math.max(0, resetMs - nowMs) : null;
  const durationMs = (window.windowDurationMins ?? 0) * 60_000;
  let projectedPercent: number | null = null;
  if (resetInMs !== null && durationMs > 0) {
    const elapsedMs = durationMs - resetInMs;
    if (elapsedMs >= durationMs * MIN_ELAPSED_FRACTION) {
      projectedPercent = (window.usedPercent * durationMs) / elapsedMs;
    }
  }
  return { window, usedPercent: window.usedPercent, projectedPercent, resetInMs };
}

export function isRunningOut(pace: WindowPace): boolean {
  return (
    pace.usedPercent >= SWITCH_USED_PERCENT ||
    (pace.projectedPercent !== null && pace.projectedPercent >= SWITCH_PROJECTED_PERCENT)
  );
}

/**
 * The windows that limit this model: every account-wide window plus the
 * model-scoped weeklies (`seven_day_opus`, `seven_day_fable`) of its family.
 */
export function windowsForModel(
  limits: ServerProviderUsageLimits,
  model: string,
): ReadonlyArray<ServerProviderUsageWindow> {
  return limits.windows.filter((window) => windowBindsModel(window, model));
}

interface Assessment {
  readonly paces: ReadonlyArray<WindowPace>;
  readonly runningOut: WindowPace | undefined;
  /** The highest projected (or used) percent among its windows. */
  readonly worstPercent: number;
}

/** Null when the subscription's limits are unknown or too old to act on. */
export function assessSubscription(
  provider: ServerProvider,
  model: string,
  nowMs: number,
): Assessment | null {
  const limits = provider.usageLimits;
  if (!limits || limits.unavailable !== undefined) return null;
  const windows = windowsForModel(limits, model);
  if (windows.length === 0) return null;
  const freshness = composerLimitsFreshness(
    windows.map((window) => window.checkedAt ?? limits.checkedAt),
    nowMs,
  );
  if (freshness.status === "expired") return null;
  const paces = windows.map((window) => windowPace(window, nowMs));
  const runningOut = paces
    .filter(isRunningOut)
    .toSorted(
      (a, b) => (b.projectedPercent ?? b.usedPercent) - (a.projectedPercent ?? a.usedPercent),
    )[0];
  const worstPercent = Math.max(
    ...paces.map((pace) => Math.max(pace.usedPercent, pace.projectedPercent ?? 0)),
  );
  return { paces, runningOut, worstPercent };
}

function canRun(provider: ServerProvider): boolean {
  return (
    provider.enabled &&
    provider.availability !== "unavailable" &&
    (provider.status === "ready" || provider.status === "warning") &&
    provider.auth.status === "authenticated"
  );
}

function modelOn(provider: ServerProvider, model: string) {
  return provider.models.find(
    (candidate) => candidate.slug === model || candidate.aliases?.includes(model) === true,
  );
}

const providerName = (provider: ServerProvider) =>
  provider.displayName?.trim() || provider.instanceId;

function describe(pace: WindowPace, nowMs: number): string {
  const resets = formatResetsIn(pace.window, nowMs);
  const when = resets ? ` before it ${resets}` : "";
  return pace.usedPercent >= SWITCH_USED_PERCENT ||
    pace.projectedPercent === null ||
    pace.projectedPercent <= pace.usedPercent
    ? `${pace.window.label} is ${Math.round(pace.usedPercent)}% used`
    : `${pace.window.label} is on pace for ${Math.round(pace.projectedPercent)}%${when}`;
}

export function recommendSubscriptionSwitch(input: {
  readonly instanceId: ProviderInstanceId | null;
  readonly model: string | null;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly nowMs: number;
}): SubscriptionSwitchSuggestion | null {
  const { instanceId, model, providers, nowMs } = input;
  if (instanceId === null || model === null) return null;
  const current = providers.find((provider) => provider.instanceId === instanceId);
  if (!current) return null;
  const currentAssessment = assessSubscription(current, model, nowMs);
  if (currentAssessment === null) return null;

  const alternatives = providers.flatMap((provider) => {
    if (provider.instanceId === instanceId || !canRun(provider)) return [];
    const target = modelOn(provider, model);
    const assessment = target ? assessSubscription(provider, target.slug, nowMs) : null;
    return target && assessment && assessment.runningOut === undefined
      ? [{ provider, target, assessment }]
      : [];
  });
  const suggest = (
    kind: SubscriptionSwitchSuggestion["kind"],
    choice: (typeof alternatives)[number],
    reason: string,
  ): SubscriptionSwitchSuggestion => ({
    kind,
    instanceId: choice.provider.instanceId,
    model: choice.target.slug,
    providerName: providerName(choice.provider),
    modelName: choice.target.shortName ?? choice.target.name,
    reason,
  });

  if (currentAssessment.runningOut) {
    const best = alternatives.toSorted(
      (a, b) => a.assessment.worstPercent - b.assessment.worstPercent,
    )[0];
    if (!best) return null;
    return suggest(
      "pressure",
      best,
      `${describe(currentAssessment.runningOut, nowMs)} on ${providerName(current)}. ` +
        `${providerName(best.provider)} is at most ${Math.round(best.assessment.worstPercent)}% on pace.`,
    );
  }

  // Use it or lose it: another subscription's weekly allowance is about to reset largely unused.
  const currentWeeklyResetMs = Math.min(
    ...currentAssessment.paces
      .filter((pace) => pace.window.kind === "weekly" && pace.resetInMs !== null)
      .map((pace) => pace.resetInMs as number),
  );
  const expiring = alternatives.flatMap((choice) => {
    const weekly = choice.assessment.paces
      .filter(
        (pace) =>
          pace.window.kind === "weekly" &&
          pace.resetInMs !== null &&
          pace.resetInMs <= EXPIRING_WITHIN_MS &&
          pace.resetInMs < currentWeeklyResetMs &&
          pace.usedPercent <= EXPIRING_MAX_USED_PERCENT,
      )
      .toSorted((a, b) => (a.resetInMs as number) - (b.resetInMs as number))[0];
    return weekly ? [{ choice, weekly }] : [];
  });
  const soonest = expiring.toSorted(
    (a, b) => (a.weekly.resetInMs as number) - (b.weekly.resetInMs as number),
  )[0];
  if (!soonest) return null;
  const resets = formatResetsIn(soonest.weekly.window, nowMs) ?? "resets soon";
  return suggest(
    "expiring",
    soonest.choice,
    `${Math.round(100 - soonest.weekly.usedPercent)}% of ${providerName(soonest.choice.provider)}'s ` +
      `${soonest.weekly.window.label.toLowerCase()} allowance is unused and ${resets}. Use it first.`,
  );
}
