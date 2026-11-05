import type {
  OrchestrationV2ProviderTurn,
  OrchestrationV2TurnItem,
  ProviderInstanceId,
  ServerProvider,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { formatDuration } from "@t3tools/shared/orchestrationTiming";
import { formatResetsIn } from "@t3tools/shared/usageLimits";
import * as DateTime from "effect/DateTime";
import { Fragment, useEffect, useRef, useState, type ReactNode } from "react";

import type { ContextWindowSnapshot } from "@t3tools/client-runtime/state/context-window";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";
import {
  COMPOSER_STATS_CLOCK_MS,
  composerLimitDisplay,
  composerLimitSourceLabel,
  composerLimitsFreshness,
  deriveContextCompaction,
  deriveResponseRate,
  deriveTimeToFirstToken,
  deriveTurnCachePercentage,
  formatCachePercentage,
  formatTimeToFirstToken,
  deriveTurnElapsedMs,
  selectComposerLimitWindows,
} from "./ComposerStats.logic";
import { recommendSubscriptionSwitch } from "./SubscriptionSwitch.logic";

function ElapsedTime({ turn }: { turn: OrchestrationV2ProviderTurn }) {
  const textRef = useRef<HTMLSpanElement>(null);
  const initialElapsed = turn.status === "running" ? 0 : deriveTurnElapsedMs(turn, 0);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- ticks the elapsed label outside React to avoid re-renders.
  useEffect(() => {
    const update = () => {
      if (textRef.current) {
        const elapsed = deriveTurnElapsedMs(turn, Date.now());
        textRef.current.textContent = elapsed === null ? "" : formatDuration(elapsed);
      }
    };
    update();
    if (turn.status !== "running") return;
    const timer = window.setInterval(update, 1000);
    return () => window.clearInterval(timer);
  }, [turn]);
  return <span ref={textRef}>{initialElapsed === null ? "" : formatDuration(initialElapsed)}</span>;
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-4">
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="text-right tabular-nums">{children}</dd>
    </div>
  );
}

function ContextBar({ percentage }: { percentage: number }) {
  return (
    <span aria-hidden="true" className="block h-2 w-full overflow-hidden rounded-sm bg-muted">
      <span
        className="block h-full bg-muted-foreground/60"
        style={{ width: `${Math.max(0, Math.min(100, percentage))}%` }}
      />
    </span>
  );
}

type Tone = "normal" | "warning" | "critical";

function toneOf(usedPercent: number): Tone {
  return usedPercent >= 90 ? "critical" : usedPercent >= 75 ? "warning" : "normal";
}

const TONE_TEXT: Record<Tone, string> = {
  normal: "text-foreground/80",
  warning: "text-warning",
  critical: "text-destructive",
};
const TONE_FILL: Record<Tone, string> = {
  normal: "bg-foreground/45",
  warning: "bg-warning",
  critical: "bg-destructive",
};

function Label({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground/70">{children}</span>;
}

function Value({ children }: { children: ReactNode }) {
  return <span className="text-foreground/80">{children}</span>;
}

/** The stats line's one shape for anything that runs out: label, small track, percent used. */
function Meter({
  label,
  percent,
  displayPercent,
  percentText,
  dimmed,
}: {
  label: string;
  percent: number;
  displayPercent: number | null;
  percentText: string;
  dimmed: boolean;
}) {
  const tone = toneOf(percent);
  return (
    <span className={`inline-flex items-center gap-1.5 ${dimmed ? "opacity-50" : ""}`}>
      <Label>{label}</Label>
      <span
        aria-hidden="true"
        className="block h-[3px] w-7 overflow-hidden rounded-full bg-foreground/10"
      >
        <span
          className={`block h-full ${dimmed ? "bg-muted-foreground/60" : TONE_FILL[tone]}`}
          style={{
            width: `${displayPercent === null ? 0 : Math.max(0, Math.min(100, displayPercent))}%`,
          }}
        />
      </span>
      <span className={dimmed ? "text-muted-foreground" : TONE_TEXT[tone]}>{percentText}</span>
    </span>
  );
}

function formatUsageTimestamp(value: string | undefined): string {
  if (value === undefined) return "unknown time";
  const timeMs = Date.parse(value);
  if (!Number.isFinite(timeMs)) return "unknown time";
  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(timeMs));
}

function usageReadingLabel(
  window: ServerProviderUsageWindow,
  fallbackCheckedAt: string | undefined,
  now: number,
): string {
  const checkedAt = window.checkedAt ?? fallbackCheckedAt;
  const freshness = composerLimitsFreshness([checkedAt], now);
  const age =
    freshness.ageMins === null
      ? "age unknown"
      : freshness.ageMins === 0
        ? "just now"
        : `${freshness.ageMins}m ago`;
  return `as of ${formatUsageTimestamp(checkedAt)} (${age}) · ${composerLimitSourceLabel(
    window.source,
  )}`;
}

/** Ages and reset countdowns share the summary clock while the popover is open. */
function UsageLimitRows({
  windows,
  checkedAt,
  now,
}: {
  windows: ReadonlyArray<ServerProviderUsageWindow>;
  checkedAt: string | undefined;
  now: number;
}) {
  return (
    <dl className="space-y-2">
      {windows.map((window) => {
        const display = composerLimitDisplay(window, checkedAt, now);
        return (
          <div key={window.id} className="space-y-1">
            <div className="flex items-baseline justify-between gap-4">
              <dt className="text-muted-foreground">{window.label}</dt>
              <dd
                className={`text-right tabular-nums ${display.dimmed ? "text-muted-foreground opacity-50" : toneOf(window.usedPercent) === "normal" ? "" : TONE_TEXT[toneOf(window.usedPercent)]}`}
              >
                {display.resetPending
                  ? "0% used"
                  : display.freshness.status === "expired"
                    ? "–"
                    : `${Math.round(window.usedPercent)}% used`}
              </dd>
            </div>
            <div className={display.dimmed ? "opacity-50" : ""}>
              <ContextBar percentage={display.displayPercent ?? 0} />
            </div>
            <p className="text-right text-muted-foreground tabular-nums">
              {usageReadingLabel(window, checkedAt, now)}
            </p>
            {display.resetPending ? (
              <p className="text-right text-muted-foreground tabular-nums">
                {window.resetsAt
                  ? `Reset at ${formatUsageTimestamp(window.resetsAt)}, waiting for a new reading`
                  : "Waiting for a new reading"}
              </p>
            ) : (
              formatResetsIn(window, now) && (
                <p className="text-right text-muted-foreground tabular-nums">
                  {formatResetsIn(window, now)}
                </p>
              )
            )}
          </div>
        );
      })}
    </dl>
  );
}

function UsageLimitsSummary({
  limits,
  providerName,
}: {
  limits: ServerProviderUsageLimits;
  providerName: string;
}) {
  const [now, setNow] = useState(Date.now);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a wall clock so limit freshness and resets stay current.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), COMPOSER_STATS_CLOCK_MS);
    return () => window.clearInterval(timer);
  }, []);
  const chips = selectComposerLimitWindows(limits);
  const freshness = composerLimitsFreshness(
    chips.map(({ window }) => window.checkedAt ?? limits.checkedAt),
    now,
  );
  if (chips.length === 0) return null;
  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={150}
        closeDelay={150}
        render={
          <button
            type="button"
            aria-label="Usage limit details"
            className="inline-flex flex-wrap items-center gap-x-4 rounded-sm text-left -outline-offset-2"
          />
        }
      >
        {chips.map(({ window, shortLabel }) => {
          const display = composerLimitDisplay(window, limits.checkedAt, now);
          return (
            <Meter
              key={window.id}
              label={shortLabel}
              percent={window.usedPercent}
              displayPercent={display.displayPercent}
              percentText={display.percentText}
              dimmed={display.dimmed}
            />
          );
        })}
      </PopoverTrigger>
      <PopoverPopup {...composerFloatingLayerProps} side="top" align="start" width="md">
        <div className="flex flex-col gap-3 text-xs">
          <div className="flex items-baseline justify-between gap-4">
            <h3 className="font-medium">Usage limits</h3>
            <span className="truncate text-muted-foreground">{providerName}</span>
          </div>
          <UsageLimitRows windows={limits.windows} checkedAt={limits.checkedAt} now={now} />
          <p className="text-muted-foreground">
            Usage comes from account and turn readings, with CLI estimates filling gaps. Stale
            values show their age; readings older than 15 minutes are hidden.
            {freshness.ageMins === null
              ? " Check time unavailable."
              : ` Checked ${freshness.ageMins === 0 ? "just now" : `${freshness.ageMins} min ago`}.`}
            {" At reset time a window shows 0% until a new reading arrives."}
          </p>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

export interface SubscriptionSwitchInput {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly instanceId: ProviderInstanceId | null;
  readonly model: string | null;
  /** Why the thread cannot move to this selection right now, if it cannot. */
  readonly getDisabledReason: (instanceId: ProviderInstanceId, model: string) => string | null;
  readonly onSwitch: (instanceId: ProviderInstanceId, model: string) => void;
}

/** "Opus 5.5 on Claude Personal": the same model on a subscription with more room. */
function SubscriptionSwitchChip({
  providers,
  instanceId,
  model,
  getDisabledReason,
  onSwitch,
}: SubscriptionSwitchInput) {
  const [now, setNow] = useState(Date.now);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- a wall clock so limit freshness and resets stay current.
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), COMPOSER_STATS_CLOCK_MS);
    return () => window.clearInterval(timer);
  }, []);
  const suggestion = recommendSubscriptionSwitch({ instanceId, model, providers, nowMs: now });
  if (!suggestion) return null;
  const disabledReason = getDisabledReason(suggestion.instanceId, suggestion.model);
  const tone =
    suggestion.kind === "pressure"
      ? "border-warning/40 text-warning hover:bg-warning/10"
      : "border-foreground/15 text-foreground/80 hover:bg-foreground/5";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            data-subscription-switch={suggestion.kind}
            aria-disabled={disabledReason !== null}
            onClick={() => {
              if (disabledReason === null) onSwitch(suggestion.instanceId, suggestion.model);
            }}
            className={`inline-flex items-center gap-1 rounded-sm border px-1.5 -outline-offset-2 ${tone} ${
              disabledReason !== null ? "cursor-not-allowed opacity-60" : "cursor-pointer"
            }`}
          />
        }
      >
        <span>
          {suggestion.modelName} on {suggestion.providerName}
        </span>
        <span aria-hidden="true">→</span>
      </TooltipTrigger>
      <TooltipPopup className="max-w-80">
        <p>{suggestion.reason}</p>
        <p className="mt-1 text-muted-foreground">
          {disabledReason ??
            `Switch this thread to ${suggestion.modelName} on ${suggestion.providerName}.`}
        </p>
      </TooltipPopup>
    </Tooltip>
  );
}

export function ComposerStats({
  context,
  turn,
  compactions,
  usageLimits,
  contextDriver,
  configuredClaudeThreshold,
  onCompact,
  compactDisabled,
  compactDisabledReason,
  isCompacting,
  subscriptionSwitch = null,
}: {
  context: ContextWindowSnapshot | null;
  turn: OrchestrationV2ProviderTurn | null;
  compactions: ReadonlyArray<Extract<OrchestrationV2TurnItem, { type: "compaction" }>>;
  usageLimits: { limits: ServerProviderUsageLimits; providerName: string } | null;
  contextDriver: string | undefined;
  configuredClaudeThreshold: unknown;
  onCompact: () => void;
  compactDisabled: boolean;
  compactDisabledReason: string | null;
  isCompacting: boolean;
  subscriptionSwitch?: SubscriptionSwitchInput | null;
}) {
  const compaction = deriveContextCompaction(context, contextDriver, configuredClaudeThreshold);
  const responseRate = deriveResponseRate(turn);
  const timeToFirstToken = deriveTimeToFirstToken(turn);
  const estimated = turn?.responseThroughput?.basis === "codex_active_windows_estimate";
  const usage = turn?.turnTokenUsage;
  const availableUsage = usage?.usageStatus !== "unavailable" ? usage : undefined;
  const cachePercentage = deriveTurnCachePercentage(availableUsage);
  const hasElapsed =
    turn !== null &&
    turn.startedAt !== null &&
    (turn.status === "running" || deriveTurnElapsedMs(turn, 0) !== null);
  const hasTokens =
    availableUsage?.inputTokens !== undefined || availableUsage?.outputTokens !== undefined;
  if (
    context === null &&
    !hasElapsed &&
    !hasTokens &&
    responseRate === null &&
    timeToFirstToken === null &&
    compactions.length === 0 &&
    selectComposerLimitWindows(usageLimits?.limits).length === 0 &&
    subscriptionSwitch === null &&
    compactDisabled
  )
    return null;
  const count = (value: number | undefined) =>
    value === undefined ? "Not reported" : value.toLocaleString("en-US");
  const stats: Array<{ key: string; node: ReactNode }> = [];
  const throughput = turn?.responseThroughput;
  const rateText =
    responseRate === null
      ? null
      : `${estimated ? "≈" : ""}${responseRate.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  const firstTokenText =
    timeToFirstToken === null ? null : formatTimeToFirstToken(timeToFirstToken);
  // T3 already shows turn time inline in the timeline, so the line shows tok/s and
  // keeps elapsed time in the details popover.
  if (turn !== null && (hasElapsed || hasTokens || rateText !== null || firstTokenText !== null)) {
    stats.push({
      key: "turn",
      node: (
        <Popover>
          <PopoverTrigger
            openOnHover
            delay={150}
            closeDelay={150}
            render={
              <button
                type="button"
                aria-label="Turn token details"
                className="inline-flex items-center gap-1 rounded-sm text-left -outline-offset-2"
              />
            }
          >
            {firstTokenText !== null && (
              <span className="me-1 inline-flex items-center gap-1">
                <Value>{firstTokenText}</Value>
                <Label>ttft</Label>
              </span>
            )}
            {rateText !== null ? (
              <>
                <Value>{rateText}</Value>
                <Label>tok/s{throughput?.partial && " partial"}</Label>
              </>
            ) : (
              firstTokenText === null && <Label>Tokens</Label>
            )}
          </PopoverTrigger>
          <PopoverPopup {...composerFloatingLayerProps} side="top" align="start" width="md">
            <div className="flex flex-col gap-3 text-xs">
              <h3 className="font-medium">
                {turn.status === "running" ? "Current" : "Latest"} main-agent turn
              </h3>
              <dl className="space-y-1.5">
                <Detail label="Status">{turn.status}</Detail>
                {rateText !== null && <Detail label="Output rate">{rateText} tok/s</Detail>}
                {firstTokenText !== null && (
                  <Detail label="Time to first token">{firstTokenText}</Detail>
                )}
                {hasElapsed && (
                  <Detail label="Elapsed wall time">
                    <ElapsedTime turn={turn} />
                  </Detail>
                )}
                <Detail label="Input tokens">{count(availableUsage?.inputTokens)}</Detail>
                <Detail label="Cache reads">{count(availableUsage?.cachedInputTokens)}</Detail>
                <Detail label="Cache writes">{count(availableUsage?.cacheCreationTokens)}</Detail>
                <Detail label="Output tokens">{count(availableUsage?.outputTokens)}</Detail>
                <Detail label="Reasoning tokens">{count(availableUsage?.reasoningTokens)}</Detail>
              </dl>
              <p className="text-muted-foreground">
                Input includes cache reads and writes; output includes reasoning. Elapsed time
                includes tools and waits. Child-agent usage is excluded.
                {usage?.hasSubagents && " This turn used subagents."}
              </p>
              {firstTokenText !== null && (
                <p className="text-muted-foreground">
                  From the turn starting on the server, so a queued turn's wait is not counted.
                </p>
              )}
              {rateText !== null && (
                <p className="text-muted-foreground">
                  {estimated
                    ? "Output rate: Codex-reported turn output tokens, including reasoning and tool arguments, divided by estimated response-active time. Observed reasoning, text and plan windows exclude local tool, approval and input waits where visible. Silent reasoning, queue time and tool argument generation may be missed."
                    : "Output rate: Claude-reported output tokens, including reasoning and tool arguments, divided by observed response start-to-stop time. Includes network, buffering and server-side waits; excludes local tool waits between responses."}
                  {throughput?.partial && " Partial coverage: some activity could not be measured."}
                </p>
              )}
              {availableUsage?.usageStatus === "partial" && (
                <p className="text-muted-foreground">
                  Partial report: counts cover only the usage this provider reported.
                </p>
              )}
            </div>
          </PopoverPopup>
        </Popover>
      ),
    });
  }
  if (cachePercentage !== null) {
    stats.push({
      key: "cache",
      node: (
        <Tooltip>
          <TooltipTrigger
            render={
              <span
                tabIndex={0}
                className="inline-flex items-center gap-1 rounded-sm -outline-offset-2"
              />
            }
          >
            <Value>{formatCachePercentage(cachePercentage)}</Value>
            <Label>cached</Label>
          </TooltipTrigger>
          <TooltipPopup>
            Input served from cache on this main-agent turn:{" "}
            {count(availableUsage?.cachedInputTokens)} of {count(availableUsage?.inputTokens)}{" "}
            tokens. Cached input generally costs less; this is not a session-wide cache rate.
          </TooltipPopup>
        </Tooltip>
      ),
    });
  }

  // Context is per thread, so it sits with the turn stats; the left side is account limits.
  if (context !== null || compactions.length > 0 || !compactDisabled || isCompacting) {
    stats.unshift({
      key: "context",
      node: (
        <Popover>
          <PopoverTrigger
            openOnHover
            delay={150}
            closeDelay={150}
            render={
              <button
                type="button"
                aria-label="Context usage details"
                className="inline-flex items-center rounded-sm text-left -outline-offset-2"
              />
            }
          >
            <span className="inline-flex items-center gap-1">
              {context?.usedPercentage != null ? (
                <span className={TONE_TEXT[toneOf(compaction.pressurePercentage)]}>
                  {Math.round(context.usedPercentage)}%
                </span>
              ) : (
                <Value>{context ? formatContextWindowTokens(context.usedTokens) : "–"}</Value>
              )}
              <Label>context</Label>
            </span>
          </PopoverTrigger>
          <PopoverPopup {...composerFloatingLayerProps} side="top" align="end" width="md">
            <div className="flex flex-col gap-3 text-xs">
              <div className="flex items-baseline justify-between gap-4">
                <h3 className="font-medium">Context usage</h3>
                <span className="text-muted-foreground tabular-nums">
                  {context?.usedPercentage != null
                    ? `${Math.round(context.usedPercentage)}% of window`
                    : "Not reported"}
                </span>
              </div>
              {context?.usedPercentage != null && (
                <ContextBar percentage={context.usedPercentage} />
              )}
              <dl className="space-y-1.5">
                <Detail label="Used tokens">
                  {context ? count(context.usedTokens) : "Not reported"}
                </Detail>
                <Detail label="Window size">{count(context?.maxTokens ?? undefined)}</Detail>
                <Detail label="Window remaining">
                  {count(context?.remainingTokens ?? undefined)}
                </Detail>
                <Detail label="Auto-compact">{compaction.status}</Detail>
                {compaction.threshold !== null && (
                  <>
                    <Detail
                      label={
                        compaction.source === "configured"
                          ? "Configured threshold"
                          : "Reported threshold"
                      }
                    >
                      {count(compaction.threshold)} tokens
                    </Detail>
                    <Detail label="Tokens to threshold">
                      {compaction.remainingTokens === null
                        ? "Not reported"
                        : count(compaction.remainingTokens)}
                    </Detail>
                  </>
                )}
                <Detail label="Recorded compactions">{compactions.length}</Detail>
              </dl>
              {compaction.source === "configured" && (
                <p className="text-muted-foreground">
                  Claude's current setting applies when a query starts. A running query may use an
                  earlier setting. Tokens to threshold use the latest context report, not a
                  countdown.
                </p>
              )}
              {compactions.length > 0 && (
                <div className="space-y-1.5">
                  <p className="font-medium">Recent compactions</p>
                  {compactions.slice(-3).map((item) => (
                    <div key={item.id} className="flex justify-between gap-4 text-muted-foreground">
                      <span>
                        {item.beforeTokenCount !== undefined
                          ? formatContextWindowTokens(item.beforeTokenCount)
                          : "Unknown"}{" "}
                        →{" "}
                        {item.afterTokenCount !== undefined
                          ? formatContextWindowTokens(item.afterTokenCount)
                          : "Unknown"}{" "}
                        tokens
                      </span>
                      <span>
                        {item.completedAt != null
                          ? new Date(DateTime.toEpochMillis(item.completedAt)).toLocaleTimeString(
                              [],
                              {
                                hour: "numeric",
                                minute: "2-digit",
                              },
                            )
                          : ""}
                      </span>
                    </div>
                  ))}
                </div>
              )}
              <p className="text-muted-foreground">
                {context
                  ? "Latest provider report, not a live token estimate or a quality score."
                  : "This provider has not reported context occupancy yet."}{" "}
                Compactions count completed events in the loaded main-agent history for this
                provider session.
              </p>
              <div className="flex flex-col gap-1.5">
                <Button
                  size="xs"
                  variant="outline"
                  disabled={compactDisabled || isCompacting}
                  onClick={onCompact}
                >
                  {isCompacting ? "Compacting…" : "Compact now"}
                </Button>
                {compactDisabled && !isCompacting && compactDisabledReason && (
                  <p className="text-muted-foreground">{compactDisabledReason}</p>
                )}
              </div>
              {context && (
                <p className="text-muted-foreground">
                  Reported{" "}
                  <time dateTime={context.updatedAt}>
                    {new Date(context.updatedAt).toLocaleString()}
                  </time>
                </p>
              )}
            </div>
          </PopoverPopup>
        </Popover>
      ),
    });
  }

  return (
    <div
      data-composer-stats="true"
      aria-label="Stats for nerds"
      className="flex flex-wrap items-center gap-x-4 gap-y-1 px-5 pt-1.5 text-2xs leading-4 text-muted-foreground tabular-nums"
    >
      {usageLimits && (
        <UsageLimitsSummary limits={usageLimits.limits} providerName={usageLimits.providerName} />
      )}
      {subscriptionSwitch && <SubscriptionSwitchChip {...subscriptionSwitch} />}
      {stats.length > 0 && (
        <span className="ms-auto inline-flex flex-wrap items-center gap-x-2.5">
          {stats.map(({ key, node }, index) => (
            <Fragment key={key}>
              {index > 0 && (
                <span aria-hidden="true" className="text-muted-foreground/40">
                  ·
                </span>
              )}
              {node}
            </Fragment>
          ))}
        </span>
      )}
    </div>
  );
}
