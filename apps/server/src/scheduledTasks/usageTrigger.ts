import {
  resolveUsageWindow,
  type ProviderInstanceId,
  type ScheduledTaskSchedule,
  type ScheduledTaskUsageSchedule,
  type ScheduledTaskUsageState,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";

import { isSameSchedule } from "./Schedule.ts";

/** Long enough for a fresh reading to replace a passed reset, and for jitter to be one reset. */
const RESET_HOLD_MS = 60_000;
/** Less than this fall in usage is ordinary aging out, not a credited reset. */
const EARLY_RESET_FALL_POINTS = 5;

/** `state` is the schedule's own object when nothing changed, so the caller writes only a change. */
type UsageTriggerResult = {
  readonly fire: boolean;
  readonly state: ScheduledTaskUsageState | undefined;
};

function timeOf(value: string | null | undefined): number | null {
  if (value == null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

/** A provider signed out, disabled or uninstalled keeps its last windows, which say nothing now. */
export function usageLimitsForTrigger(
  provider: ServerProvider | undefined,
): ServerProviderUsageLimits | undefined {
  return provider === undefined ||
    !provider.enabled ||
    !provider.installed ||
    provider.auth.status === "unauthenticated"
    ? undefined
    : provider.usageLimits;
}

function evaluateLine(
  schedule: ScheduledTaskUsageSchedule,
  window: ServerProviderUsageWindow,
  nowMs: number,
): UsageTriggerResult {
  const unchanged = { fire: false, state: schedule.state };
  const resetMs = timeOf(window.resetsAt);
  // The first's 0 is a placeholder and the second's percent is from before the reset, unless it
  // was read after that reset: for an idle window the merge keeps the old time on a real `0, null`.
  const readAfterReset = resetMs !== null && (timeOf(window.checkedAt) ?? -Infinity) > resetMs;
  if (!readAfterReset && (window.resetPending === true || (resetMs !== null && resetMs <= nowMs))) {
    return unchanged;
  }
  if (schedule.usedPercent === undefined) return unchanged;
  const past =
    schedule.on === "above"
      ? window.usedPercent >= schedule.usedPercent
      : window.usedPercent < schedule.usedPercent;
  const { state } = schedule;
  // `above` starts over with a new period; `below` would fire each period on an idle window.
  const tracked = schedule.on === "above" ? window.resetsAt : undefined;
  const withReset = (armed: boolean) =>
    tracked === undefined ? { armed } : { armed, resetsAt: tracked };
  const recordedMs = schedule.on === "above" ? timeOf(state?.resetsAt) : null;
  const newPeriod =
    recordedMs !== null &&
    recordedMs <= nowMs &&
    (resetMs === null || resetMs - recordedMs >= RESET_HOLD_MS);
  const armed = newPeriod ? true : state?.armed;
  if (armed === undefined) return { fire: false, state: withReset(!past) };
  if (armed && past) return { fire: true, state: withReset(false) };
  const next = withReset(armed || !past);
  return {
    fire: false,
    state: next.armed === state?.armed && next.resetsAt === state?.resetsAt ? state : next,
  };
}

/** The recorded reset that has yet to fire. One within the hold of `firedFor` is the one that did. */
function unfiredReset(state: ScheduledTaskUsageState | undefined) {
  const resetsAt = state?.resetsAt;
  const resetMs = timeOf(resetsAt);
  if (resetsAt == null || resetMs === null) return null;
  const firedMs = timeOf(state?.firedFor);
  return firedMs !== null && Math.abs(resetMs - firedMs) < RESET_HOLD_MS
    ? null
    : { resetsAt, resetMs };
}

function evaluateReset(
  schedule: ScheduledTaskUsageSchedule,
  window: ServerProviderUsageWindow,
  nowMs: number,
): UsageTriggerResult {
  const { state } = schedule;
  const resetsAt = window.resetsAt ?? null;
  const reading = { resetsAt, usedPercent: window.usedPercent };
  const readingMs = timeOf(resetsAt);
  if (state === undefined) {
    // A reset that passed before the first reading is not one this task saw coming.
    return {
      fire: false,
      state:
        resetsAt !== null && readingMs !== null && readingMs <= nowMs
          ? { ...reading, firedFor: resetsAt }
          : reading,
    };
  }
  const kept =
    state.resetsAt === resetsAt && state.usedPercent === window.usedPercent
      ? state
      : state.firedFor === undefined
        ? reading
        : { ...reading, firedFor: state.firedFor };
  const unfired = unfiredReset(state);
  if (unfired === null) return { fire: false, state: kept };
  if (unfired.resetMs <= nowMs) {
    // Stays recorded until it fires, or a fresh reading inside the hold would lose this reset.
    if (nowMs - unfired.resetMs < RESET_HOLD_MS) return { fire: false, state };
    // A window last seen at 0 had nothing to renew, so the clock alone sends no unattended work.
    return {
      fire: (state.usedPercent ?? 0) > 0,
      state: { ...reading, firedFor: unfired.resetsAt },
    };
  }
  // A cached probe after a restart: it says nothing new, and the record still fires by the clock.
  if (readingMs !== null && readingMs <= nowMs && readingMs < unfired.resetMs) {
    return { fire: false, state };
  }
  // The merge keeps the old reset on a real `0, null`, and a restart has no old reset to keep.
  const renewed =
    readingMs === null || window.usedPercent === 0 || readingMs - unfired.resetMs >= RESET_HOLD_MS;
  return renewed && (state.usedPercent ?? 0) - window.usedPercent >= EARLY_RESET_FALL_POINTS
    ? { fire: true, state: { ...reading, firedFor: unfired.resetsAt } }
    : { fire: false, state: kept };
}

export function evaluateUsageTrigger(input: {
  readonly schedule: ScheduledTaskUsageSchedule;
  readonly limits: ServerProviderUsageLimits | undefined;
  readonly nowMs: number;
}): UsageTriggerResult {
  const { schedule, limits, nowMs } = input;
  const window =
    limits === undefined || limits.unavailable !== undefined
      ? undefined
      : resolveUsageWindow(limits.windows, schedule.window);
  if (window === undefined) return { fire: false, state: schedule.state };
  return schedule.on === "reset"
    ? evaluateReset(schedule, window, nowMs)
    : evaluateLine(schedule, window, nowMs);
}

/**
 * When time alone can fire this task. A reset past its hold and still unfired had no reading to
 * fire on, so the next reading, not the clock, brings it back.
 */
export function usageTriggerDueAtMs(schedule: ScheduledTaskUsageSchedule, nowMs: number): number {
  if (schedule.on !== "reset") return Infinity;
  const unfired = unfiredReset(schedule.state);
  const dueAt = unfired === null ? Infinity : unfired.resetMs + RESET_HOLD_MS;
  return dueAt > nowMs ? dueAt : Infinity;
}

/**
 * Null when there is nothing to check the name against: no readings yet, or an `unavailable` the
 * evaluator reads as no reading, whose few windows may be all that one turn event named.
 */
export function usageWindowProblem(
  schedule: Pick<ScheduledTaskUsageSchedule, "window">,
  instanceId: string,
  limits: ServerProviderUsageLimits | undefined,
): string | null {
  if (limits?.unavailable?.reason === "unsupported") {
    return `${instanceId} reports no usage windows, so a usage task on it would never run.`;
  }
  if (
    limits === undefined ||
    limits.unavailable !== undefined ||
    limits.windows.length === 0 ||
    resolveUsageWindow(limits.windows, schedule.window) !== undefined
  ) {
    return null;
  }
  const reported = limits.windows.map((window) => `${window.id} (${window.kind})`).join(", ");
  return `${instanceId} has no usage window "${schedule.window}". It reports: ${reported}.`;
}

export function usageScheduleProblem(
  schedule: Pick<ScheduledTaskUsageSchedule, "on" | "usedPercent">,
): string | null {
  if (schedule.on === "reset") {
    return schedule.usedPercent === undefined
      ? null
      : "A usage task that runs on `reset` takes no usedPercent.";
  }
  return schedule.usedPercent === undefined
    ? `A usage task that runs on \`${schedule.on}\` needs usedPercent, a whole number from 1 to 99.`
    : null;
}

/**
 * The stored form of a saved trigger: fields in one order, so a kept trigger compares equal as
 * text, and a state only from the row. A state read while the task was paused, or for another
 * trigger or instance, describes nothing this trigger has seen.
 */
export function usageScheduleToSave(input: {
  readonly schedule: ScheduledTaskUsageSchedule;
  readonly enabled: boolean;
  readonly modelInstanceId: ProviderInstanceId;
  readonly existing: {
    readonly enabled: boolean;
    readonly schedule: ScheduledTaskSchedule;
    readonly modelSelection: { readonly instanceId: ProviderInstanceId };
  } | null;
}): ScheduledTaskUsageSchedule {
  const { schedule, existing } = input;
  const trigger: ScheduledTaskUsageSchedule = {
    type: "usage",
    ...(schedule.instanceId === undefined ? {} : { instanceId: schedule.instanceId }),
    window: schedule.window,
    on: schedule.on,
    ...(schedule.usedPercent === undefined ? {} : { usedPercent: schedule.usedPercent }),
  };
  if (existing === null || existing.schedule.type !== "usage") return trigger;
  const before = existing.schedule;
  return before.state !== undefined &&
    isSameSchedule(before, trigger) &&
    (existing.enabled || !input.enabled) &&
    (before.instanceId ?? existing.modelSelection.instanceId) ===
      (schedule.instanceId ?? input.modelInstanceId)
    ? { ...trigger, state: before.state }
    : trigger;
}
