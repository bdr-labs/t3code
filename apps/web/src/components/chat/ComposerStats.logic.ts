import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
  TurnTokenUsage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";

/** Provider turn ordinals are scoped to a provider thread; children have their own nodes. */
export function selectComposerStatsTurns(projection: {
  readonly thread: Pick<OrchestrationV2ThreadProjection["thread"], "activeProviderThreadId">;
  readonly nodes: ReadonlyArray<
    Pick<OrchestrationV2ThreadProjection["nodes"][number], "id" | "kind" | "parentNodeId">
  >;
  readonly providerTurns: ReadonlyArray<OrchestrationV2ProviderTurn>;
}): ReadonlyArray<OrchestrationV2ProviderTurn> {
  const mainNodes = new Set(
    projection.nodes
      .filter((node) => node.kind === "root_turn" && node.parentNodeId === null)
      .map((node) => node.id),
  );
  return projection.providerTurns
    .filter(
      (turn) =>
        turn.providerThreadId === projection.thread.activeProviderThreadId &&
        mainNodes.has(turn.nodeId),
    )
    .toSorted((a, b) => a.ordinal - b.ordinal);
}

/** Cache reads are a subset of normalized input (which includes cache writes). */
export function deriveTurnCachePercentage(usage: TurnTokenUsage | undefined): number | null {
  if (
    usage === undefined ||
    usage.usageStatus === "unavailable" ||
    usage.inputTokens === undefined ||
    usage.inputTokens <= 0 ||
    usage.cachedInputTokens === undefined ||
    usage.cachedInputTokens > usage.inputTokens
  ) {
    return null;
  }
  return (usage.cachedInputTokens / usage.inputTokens) * 100;
}

/**
 * One decimal, truncated: 99.96% reads 99.9%, so 100% means every input token was cached.
 * The epsilon keeps exact tenths (99.8) from flooring to the tenth below.
 */
export function formatCachePercentage(percentage: number): string {
  if (percentage >= 100) return "100%";
  if (percentage <= 0) return "0%";
  return `${(Math.floor(percentage * 10 + 1e-9) / 10).toFixed(1)}%`;
}

/** Wall time includes tools and waits. It must never be used as generation time for TPS. */
export function deriveTurnElapsedMs(
  turn: Pick<OrchestrationV2ProviderTurn, "status" | "startedAt" | "completedAt">,
  nowMs: number,
): number | null {
  if (turn.startedAt === null) return null;
  const end =
    turn.status === "running"
      ? nowMs
      : turn.completedAt === null
        ? null
        : DateTime.toEpochMillis(turn.completedAt);
  const start = DateTime.toEpochMillis(turn.startedAt);
  return end !== null && Number.isFinite(end) && end >= start ? end - start : null;
}

/** These are observed completed events, not a lifetime count for a provider. */
export function selectRecordedCompactions(
  // Structure-only items (no streamed text) carry every field a compaction needs.
  items: ReadonlyArray<
    | { readonly type: Exclude<OrchestrationV2TurnItem["type"], "compaction"> }
    | Extract<OrchestrationV2TurnItem, { type: "compaction" }>
  >,
  turns: ReadonlyArray<OrchestrationV2ProviderTurn>,
): ReadonlyArray<Extract<OrchestrationV2TurnItem, { type: "compaction" }>> {
  const nodes = new Set(turns.map((turn) => turn.nodeId));
  const threads = new Set(turns.map((turn) => turn.providerThreadId));
  const turnIds = new Set(turns.map((turn) => turn.id));
  const nativeAcpTurns = new Set(
    items
      .filter(
        (item): item is Extract<OrchestrationV2TurnItem, { type: "compaction" }> =>
          item.type === "compaction" &&
          item.status === "completed" &&
          item.nativeItemRef?.nativeId?.startsWith("acp-compaction:") === true,
      )
      .map((item) => item.providerTurnId),
  );
  const seen = new Set<string>();
  return items
    .filter((item): item is Extract<OrchestrationV2TurnItem, { type: "compaction" }> => {
      if (
        item.type !== "compaction" ||
        item.status !== "completed" ||
        !(
          (item.nodeId !== null && nodes.has(item.nodeId)) ||
          (item.providerTurnId !== null && turnIds.has(item.providerTurnId))
        ) ||
        item.providerThreadId === null ||
        !threads.has(item.providerThreadId) ||
        // ACP may report the native event as well as a synthetic /compact completion.
        (item.providerTurnId !== null &&
          nativeAcpTurns.has(item.providerTurnId) &&
          item.nativeItemRef?.strength === "weak" &&
          item.nativeItemRef.nativeId?.endsWith(":compaction")) ||
        seen.has(item.id)
      )
        return false;
      seen.add(item.id);
      return true;
    })
    .toSorted((a, b) => DateTime.toEpochMillis(a.updatedAt) - DateTime.toEpochMillis(b.updatedAt));
}

/** Persisted provider telemetry is independent of whole-turn wall time. */
export function deriveResponseRate(turn: OrchestrationV2ProviderTurn | null): number | null {
  const throughput = turn?.responseThroughput;
  if (
    !(
      (turn?.nativeTurnRef?.driver === "claudeAgent" &&
        (throughput?.basis === undefined || throughput.basis === "claude_observed")) ||
      (turn?.nativeTurnRef?.driver === "codex" &&
        throughput?.basis === "codex_active_windows_estimate")
    ) ||
    throughput === undefined ||
    throughput.responseCount <= 0 ||
    !Number.isSafeInteger(throughput.responseCount) ||
    !Number.isSafeInteger(throughput.outputTokens) ||
    throughput.outputTokens < 0 ||
    !Number.isFinite(throughput.elapsedMs) ||
    throughput.elapsedMs <= 0
  )
    return null;
  return throughput.outputTokens / (throughput.elapsedMs / 1000);
}

/** Null, never 0, when the provider gave no first delta to time. */
export function deriveTimeToFirstToken(turn: OrchestrationV2ProviderTurn | null): number | null {
  const ms = turn?.timeToFirstTokenMs;
  return ms !== undefined && Number.isFinite(ms) && ms > 0 ? ms : null;
}

/** One decimal to 10 s, whole seconds beyond, and never a rounded `0.0s`. */
export function formatTimeToFirstToken(ms: number): string {
  const tenths = Math.max(1, Math.round(ms / 100));
  return tenths < 100 ? `${(tenths / 10).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
}

function windowShortLabel(window: ServerProviderUsageWindow): string {
  const mins = window.windowDurationMins;
  if (mins !== undefined && mins > 0) {
    if (mins % 10_080 === 0) return mins === 10_080 ? "Week" : `${mins / 10_080}wk`;
    if (mins % 1_440 === 0) return `${mins / 1_440}d`;
    if (mins % 60 === 0) return `${mins / 60}h`;
    return `${mins}m`;
  }
  return window.kind === "session" ? "Session" : window.kind === "weekly" ? "Week" : window.label;
}

/**
 * The account-wide session and weekly windows for the inline stats line, in
 * that order. Model-scoped weeklies stay in the popover; providers list the
 * account-wide window of each kind first.
 */
export function selectComposerLimitWindows(
  limits: ServerProviderUsageLimits | undefined,
): ReadonlyArray<{ readonly window: ServerProviderUsageWindow; readonly shortLabel: string }> {
  if (!limits || limits.unavailable?.reason === "unsupported") return [];
  return (["session", "weekly"] as const).flatMap((kind) => {
    const window = limits.windows.find((candidate) => candidate.kind === kind);
    return window ? [{ window, shortLabel: windowShortLabel(window) }] : [];
  });
}

export const COMPOSER_STATS_CLOCK_MS = 30_000;

/** Age of the newest valid fetch among the displayed windows. */
export function composerLimitsFreshness(
  checkedAts: ReadonlyArray<string | undefined>,
  nowMs: number,
): {
  readonly status: "fresh" | "stale" | "expired";
  readonly ageMins: number | null;
  readonly checkedAt: string | undefined;
} {
  const times = checkedAts.flatMap((checkedAt) => {
    const time = checkedAt === undefined ? NaN : Date.parse(checkedAt);
    // The render clock can trail a newly received fetch by one interval.
    return Number.isFinite(time) && time <= nowMs + COMPOSER_STATS_CLOCK_MS
      ? [{ time, checkedAt }]
      : [];
  });
  const newest = times.toSorted((a, b) => b.time - a.time)[0];
  if (!newest) return { status: "expired", ageMins: null, checkedAt: undefined };
  const ageMs = Math.max(0, nowMs - newest.time);
  return {
    status: ageMs <= 3 * 60_000 ? "fresh" : ageMs <= 15 * 60_000 ? "stale" : "expired",
    ageMins: Math.floor(ageMs / 60_000),
    checkedAt: newest.checkedAt,
  };
}

export function composerLimitResetPending(
  window: Pick<ServerProviderUsageWindow, "resetPending" | "resetsAt">,
  nowMs: number,
): boolean {
  if (window.resetPending === true) return true;
  if (window.resetsAt === undefined) return false;
  const resetMs = Date.parse(window.resetsAt);
  return Number.isFinite(resetMs) && resetMs <= nowMs;
}

export function composerLimitSourceLabel(
  source: ServerProviderUsageWindow["source"],
): "account" | "turn" | "CLI estimate" {
  return source === "account" ? "account" : source === "turn" ? "turn" : "CLI estimate";
}

export function composerLimitDisplay(
  window: ServerProviderUsageWindow,
  fallbackCheckedAt: string | undefined,
  nowMs: number,
): {
  readonly freshness: ReturnType<typeof composerLimitsFreshness>;
  readonly resetPending: boolean;
  readonly displayPercent: number | null;
  readonly percentText: string;
  readonly dimmed: boolean;
} {
  const freshness = composerLimitsFreshness([window.checkedAt ?? fallbackCheckedAt], nowMs);
  const resetPending = composerLimitResetPending(window, nowMs);
  if (resetPending) {
    return {
      freshness,
      resetPending: true,
      displayPercent: 0,
      percentText: "0%",
      dimmed: true,
    };
  }
  if (freshness.status === "expired") {
    return {
      freshness,
      resetPending: false,
      displayPercent: null,
      percentText: "–",
      dimmed: true,
    };
  }
  const age =
    freshness.status === "stale" && freshness.ageMins !== null ? ` · ${freshness.ageMins}m` : "";
  return {
    freshness,
    resetPending: false,
    displayPercent: window.usedPercent,
    percentText: `${Math.round(window.usedPercent)}%${age}`,
    dimmed: freshness.status !== "fresh",
  };
}

/** A configured limit is a launch setting, not proof of the running query's limit. */
export function deriveContextCompaction(
  context: Pick<
    ContextWindowSnapshot,
    "usedTokens" | "usedPercentage" | "autoCompactThreshold" | "compactsAutomatically"
  > | null,
  driver: string | undefined,
  configuredClaudeThreshold: unknown,
) {
  const configured =
    driver === "claudeAgent" &&
    typeof configuredClaudeThreshold === "string" &&
    /^\d+$/.test(configuredClaudeThreshold.trim())
      ? Number(configuredClaudeThreshold)
      : null;
  const validConfigured =
    configured !== null && configured >= 100_000 && configured <= 1_000_000 ? configured : null;
  const reported = context?.autoCompactThreshold;
  const validReported =
    context?.compactsAutomatically !== false &&
    typeof reported === "number" &&
    Number.isFinite(reported) &&
    reported > 0
      ? reported
      : null;
  const threshold =
    context?.compactsAutomatically === false ? null : (validReported ?? validConfigured);
  const source = threshold === null ? null : validReported !== null ? "reported" : "configured";
  const usedTokens = context?.usedTokens;
  const remainingTokens =
    threshold !== null && usedTokens !== undefined ? Math.max(0, threshold - usedTokens) : null;
  const thresholdPercentage =
    threshold !== null && usedTokens !== undefined ? (usedTokens / threshold) * 100 : null;
  const pressurePercentage = Math.max(context?.usedPercentage ?? 0, thresholdPercentage ?? 0);
  const status =
    context?.compactsAutomatically === false
      ? "Reported off"
      : threshold !== null
        ? source === "reported"
          ? "Provider reported"
          : "Claude setting"
        : driver === "claudeAgent"
          ? "Managed by Claude (threshold not reported)"
          : driver === "codex"
            ? "Managed by Codex (threshold not reported)"
            : context?.compactsAutomatically === true
              ? "On (threshold not reported)"
              : "Not reported";
  return { threshold, source, remainingTokens, thresholdPercentage, pressurePercentage, status };
}
