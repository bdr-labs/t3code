/**
 * Pure delivery decisions for direct APNs push, ported from `infra/relay/src/agentActivity/`.
 * Unlike the relay, which aggregates every linked environment, a server pushing directly
 * only knows its own threads, so the aggregate covers this environment alone.
 */
import type {
  RelayAgentActivityAggregateRow,
  RelayAgentActivityAggregateState,
  RelayAgentActivityState,
  RelayAgentAwarenessPreferences,
} from "@t3tools/contracts/relay";

export const LIVE_ACTIVITY_NAME = "AgentActivity";
// The Live Activity banner renders up to five rows.
export const MAX_ACTIVITY_ROWS = 5;
const MAX_SUMMARY_TEXT_LENGTH = 120;
const MAX_STATUS_TEXT_LENGTH = 40;
const MAX_DEEP_LINK_LENGTH = 512;
// Running phases expire quickly, waiting phases can sit for hours.
const RUNNING_AGENT_ACTIVITY_ROW_TTL_MS = 2 * 60 * 60 * 1_000;
const WAITING_AGENT_ACTIVITY_ROW_TTL_MS = 24 * 60 * 60 * 1_000;
// How long a finished thread keeps its Done/Failed row in the aggregate.
export const TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS = 15 * 60 * 1_000;
// Completions replayed long after the fact must not ring the device again.
export const TERMINAL_NOTIFICATION_FRESHNESS_MS = 2 * 60 * 1_000;
const MIN_LIVE_ACTIVITY_UPDATE_INTERVAL_MS = 15_000;
const STALE_AFTER_SECONDS = 10 * 60;
const DISMISS_AFTER_SECONDS = 5 * 60;
const CONTENTLESS_DISMISS_AFTER_SECONDS = 15;
const PERMANENT_APNS_TOKEN_REASONS = new Set([
  "BadDeviceToken",
  "DeviceTokenNotForTopic",
  "Unregistered",
]);

export type ApnsEnvironment = "sandbox" | "production";

/** One registered device as this server stores it. */
export interface DirectPushDevice {
  readonly deviceId: string;
  readonly label: string;
  readonly platform: "ios" | "android";
  readonly bundleId: string | null;
  readonly apsEnvironment: ApnsEnvironment | null;
  readonly pushToken: string | null;
  readonly preferences: RelayAgentAwarenessPreferences;
  readonly updatedAt: string;
  readonly activityPushToken: string | null;
  /** Last aggregate this server delivered to the current activity token. */
  readonly lastAggregate: RelayAgentActivityAggregateState | null;
  readonly lastLiveActivityDeliveryAt: string | null;
}

export interface NotificationPayload {
  readonly title: string;
  readonly body: string;
  readonly environmentId: string;
  readonly threadId: string;
  readonly deepLink: string;
  readonly phase: RelayAgentActivityState["phase"];
  readonly updatedAt: string;
}

export interface LiveActivityAlert {
  readonly title: string;
  readonly body: string;
}

export type ChosenDelivery =
  | {
      readonly kind: "live_activity_update";
      readonly token: string;
      readonly aggregate: RelayAgentActivityAggregateState;
      readonly alert: LiveActivityAlert | null;
    }
  | {
      readonly kind: "live_activity_end";
      readonly token: string;
      readonly aggregate: RelayAgentActivityAggregateState | null;
      readonly alert: LiveActivityAlert | null;
    }
  | {
      readonly kind: "push_notification";
      readonly token: string;
      readonly notification: NotificationPayload;
    };

export interface ApnsRequest {
  readonly token: string;
  readonly pushType: "liveactivity" | "alert";
  readonly priority: "5" | "10";
  readonly payload: unknown;
}

function epochMillis(iso: string): number {
  const value = Date.parse(iso);
  return Number.isNaN(value) ? Number.NaN : value;
}

export function isTerminalPhase(state: Pick<RelayAgentActivityState, "phase">): boolean {
  return state.phase === "completed" || state.phase === "failed";
}

export function isExpiredAgentActivityState(state: RelayAgentActivityState, nowMs: number) {
  const updatedAtMs = epochMillis(state.updatedAt);
  const ttlMs =
    state.phase === "running" || state.phase === "starting"
      ? RUNNING_AGENT_ACTIVITY_ROW_TTL_MS
      : WAITING_AGENT_ACTIVITY_ROW_TTL_MS;
  return !Number.isFinite(updatedAtMs) || nowMs > updatedAtMs + ttlMs;
}

function truncateText(value: string, maxLength: number): string {
  const trimmed = value.trim();
  return trimmed.length <= maxLength ? trimmed : trimmed.slice(0, maxLength - 3).trimEnd() + "...";
}

function sanitizeDeepLink(value: string): string {
  const trimmed = value.trim();
  if (!trimmed.startsWith("/") || trimmed.startsWith("//")) return "/";
  return truncateText(trimmed, MAX_DEEP_LINK_LENGTH);
}

function sanitizeRow(row: RelayAgentActivityAggregateRow): RelayAgentActivityAggregateRow {
  return {
    ...row,
    projectTitle: truncateText(row.projectTitle, MAX_SUMMARY_TEXT_LENGTH),
    threadTitle: truncateText(row.threadTitle, MAX_SUMMARY_TEXT_LENGTH),
    modelTitle: truncateText(row.modelTitle, MAX_SUMMARY_TEXT_LENGTH),
    status: truncateText(row.status, MAX_STATUS_TEXT_LENGTH),
    deepLink: sanitizeDeepLink(row.deepLink),
  };
}

function sanitizeAggregate(
  aggregate: RelayAgentActivityAggregateState,
): RelayAgentActivityAggregateState {
  return {
    ...aggregate,
    title: truncateText(aggregate.title, MAX_SUMMARY_TEXT_LENGTH),
    subtitle: truncateText(aggregate.subtitle, MAX_SUMMARY_TEXT_LENGTH),
    activities: aggregate.activities.slice(0, MAX_ACTIVITY_ROWS).map(sanitizeRow),
  };
}

export function statusForPhase(phase: RelayAgentActivityState["phase"]): string {
  switch (phase) {
    case "waiting_for_approval":
      return "Approval";
    case "waiting_for_input":
      return "Input";
    case "completed":
      return "Done";
    case "failed":
      return "Failed";
    case "starting":
      return "Connecting";
    case "running":
      return "Working";
    case "stale":
      return "Waiting";
  }
}

function aggregateRowForState(state: RelayAgentActivityState): RelayAgentActivityAggregateRow {
  return {
    environmentId: state.environmentId,
    threadId: state.threadId,
    projectTitle: state.projectTitle,
    threadTitle: state.threadTitle,
    modelTitle: state.modelTitle,
    phase: state.phase,
    status: statusForPhase(state.phase),
    updatedAt: state.updatedAt,
    deepLink: state.deepLink,
  };
}

function activityPhasePriority(phase: RelayAgentActivityState["phase"]): number {
  if (phase === "waiting_for_approval" || phase === "waiting_for_input") return 0;
  if (phase === "failed") return 1;
  if (phase === "starting" || phase === "running") return 2;
  return 3;
}

function isRecentTerminalState(state: RelayAgentActivityState, nowMs: number): boolean {
  if (!isTerminalPhase(state)) return false;
  const updatedAtMs = epochMillis(state.updatedAt);
  return (
    !Number.isNaN(updatedAtMs) && nowMs - updatedAtMs <= TERMINAL_AGENT_ACTIVITY_DISPLAY_TTL_MS
  );
}

export function makeAggregateState(input: {
  readonly states: ReadonlyArray<RelayAgentActivityState>;
  readonly terminalState: RelayAgentActivityState | null;
  readonly nowMs: number;
}): RelayAgentActivityAggregateState | null {
  const activeStates = input.states.filter(
    (state) => !isTerminalPhase(state) && !isExpiredAgentActivityState(state, input.nowMs),
  );
  const recentTerminal = input.states
    .filter((state) => isRecentTerminalState(state, input.nowMs))
    .toSorted((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  if (activeStates.length === 0) {
    if (input.terminalState !== null) {
      return sanitizeAggregate({
        title: "T3 Code",
        subtitle:
          input.terminalState.phase === "failed" ? "Agent work failed" : "Agent work completed",
        activeCount: 0,
        updatedAt: input.terminalState.updatedAt,
        activities: [aggregateRowForState(input.terminalState)],
      });
    }
    const newest = recentTerminal[0];
    if (!newest) return null;
    return sanitizeAggregate({
      title: "T3 Code",
      subtitle: newest.phase === "failed" ? "Agent work failed" : "Agent work completed",
      activeCount: 0,
      updatedAt: newest.updatedAt,
      activities: recentTerminal.slice(0, MAX_ACTIVITY_ROWS).map(aggregateRowForState),
    });
  }
  const displayed = [
    ...activeStates
      .toSorted((a, b) => activityPhasePriority(a.phase) - activityPhasePriority(b.phase))
      .slice(0, MAX_ACTIVITY_ROWS),
    ...recentTerminal,
  ].slice(0, MAX_ACTIVITY_ROWS);
  const updatedAt = [...activeStates, ...recentTerminal].reduce((latest, state) =>
    state.updatedAt.localeCompare(latest.updatedAt) > 0 ? state : latest,
  ).updatedAt;
  return sanitizeAggregate({
    title: "T3 Code",
    subtitle: "Agent work in progress",
    activeCount: activeStates.length,
    updatedAt,
    activities: displayed.map(aggregateRowForState),
  });
}

function rowKey(row: RelayAgentActivityAggregateRow): string {
  return JSON.stringify([row.environmentId, row.threadId]);
}

function isAttentionPhase(phase: string): boolean {
  return phase === "waiting_for_approval" || phase === "waiting_for_input";
}

function isFreshTerminalNotification(updatedAt: string, nowMs: number): boolean {
  const updatedAtMs = epochMillis(updatedAt);
  return !Number.isNaN(updatedAtMs) && nowMs - updatedAtMs <= TERMINAL_NOTIFICATION_FRESHNESS_MS;
}

function alertAllowedForPhase(
  preferences: RelayAgentAwarenessPreferences | null,
  phase: string,
): boolean {
  if (preferences === null) return true;
  switch (phase) {
    case "waiting_for_approval":
      return preferences.notifyOnApproval;
    case "waiting_for_input":
      return preferences.notifyOnInput;
    case "completed":
      return preferences.notifyOnCompletion;
    case "failed":
      return preferences.notifyOnFailure;
    default:
      return false;
  }
}

function newlyTerminalRows(
  previous: RelayAgentActivityAggregateState | null,
  next: RelayAgentActivityAggregateState,
  includeUnobserved: boolean,
): ReadonlyArray<RelayAgentActivityAggregateRow> {
  if (previous === null) return [];
  const previousPhases = new Map(previous.activities.map((row) => [rowKey(row), row.phase]));
  return next.activities.filter((row) => {
    if (row.phase !== "completed" && row.phase !== "failed") return false;
    const previousPhase = previousPhases.get(rowKey(row));
    return (
      (includeUnobserved || previousPhase !== undefined) &&
      previousPhase !== "completed" &&
      previousPhase !== "failed"
    );
  });
}

function alertForRows(rows: ReadonlyArray<RelayAgentActivityAggregateRow>) {
  const first = rows[0];
  if (!first) return null;
  if (rows.length === 1) {
    return { title: first.threadTitle, body: `${first.status}: ${first.projectTitle}` };
  }
  return {
    title: `${rows.length} agents ${isAttentionPhase(first.phase) ? "need attention" : "finished"}`,
    body: rows.map((row) => row.threadTitle).join(", "),
  };
}

// A missing baseline is a replay, not a transition that should buzz the phone.
function alertForTransition(input: {
  readonly previous: RelayAgentActivityAggregateState | null;
  readonly next: RelayAgentActivityAggregateState;
  readonly preferences: RelayAgentAwarenessPreferences | null;
  readonly nowMs: number;
}): LiveActivityAlert | null {
  if (input.previous === null) return null;
  const previouslyAttention = new Set(
    input.previous.activities.filter((row) => isAttentionPhase(row.phase)).map(rowKey),
  );
  const attention = input.next.activities.filter(
    (row) =>
      isAttentionPhase(row.phase) &&
      !previouslyAttention.has(rowKey(row)) &&
      alertAllowedForPhase(input.preferences, row.phase),
  );
  return (
    alertForRows(attention) ??
    alertForRows(
      newlyTerminalRows(input.previous, input.next, true).filter(
        (row) =>
          alertAllowedForPhase(input.preferences, row.phase) &&
          isFreshTerminalNotification(row.updatedAt, input.nowMs),
      ),
    )
  );
}

function alertForTerminalAggregate(
  aggregate: RelayAgentActivityAggregateState | null,
  preferences: RelayAgentAwarenessPreferences | null,
): LiveActivityAlert | null {
  const row = aggregate?.activities[0];
  if (!row || (row.phase !== "completed" && row.phase !== "failed")) return null;
  return alertAllowedForPhase(preferences, row.phase) ? alertForRows([row]) : null;
}

function shouldAlertForActivity(input: {
  readonly phase: RelayAgentActivityAggregateRow["phase"];
  readonly updatedAt: string;
  readonly preferences: RelayAgentAwarenessPreferences | null;
  readonly nowMs: number;
}): boolean {
  return (
    input.preferences?.notificationsEnabled === true &&
    alertAllowedForPhase(input.preferences, input.phase) &&
    ((input.phase !== "completed" && input.phase !== "failed") ||
      isFreshTerminalNotification(input.updatedAt, input.nowMs))
  );
}

export function notificationForAggregate(input: {
  readonly device: DirectPushDevice;
  readonly aggregate: RelayAgentActivityAggregateState | null;
  readonly nowMs: number;
}): NotificationPayload | null {
  if (!input.device.pushToken || input.aggregate === null) return null;
  const preferences = input.device.preferences;
  if (!preferences.notificationsEnabled) return null;
  const activity = input.aggregate.activities[0];
  if (!activity) return null;
  if (!shouldAlertForActivity({ ...activity, preferences, nowMs: input.nowMs })) return null;
  const row = sanitizeRow(activity);
  return {
    title: row.threadTitle,
    body: `${row.status}: ${row.projectTitle}`,
    environmentId: row.environmentId,
    threadId: row.threadId,
    deepLink: row.deepLink,
    phase: row.phase,
    updatedAt: row.updatedAt,
  };
}

function aggregateNeedsAttention(aggregate: RelayAgentActivityAggregateState): boolean {
  return aggregate.activities.some((row) => isAttentionPhase(row.phase));
}

function shouldUpdateLiveActivity(input: {
  readonly previous: RelayAgentActivityAggregateState | null;
  readonly next: RelayAgentActivityAggregateState;
  readonly lastDeliveryAt: string | null;
  readonly nowMs: number;
}): boolean {
  if (!input.previous) return true;
  if (JSON.stringify(input.previous) === JSON.stringify(input.next)) return false;
  if (input.previous.activeCount !== input.next.activeCount) return true;
  if (aggregateNeedsAttention(input.next)) return true;
  // A thread finishing must never be throttled away.
  if (newlyTerminalRows(input.previous, input.next, true).length > 0) return true;
  const lastDeliveryAtMs = input.lastDeliveryAt === null ? null : epochMillis(input.lastDeliveryAt);
  return (
    lastDeliveryAtMs === null ||
    Number.isNaN(lastDeliveryAtMs) ||
    input.nowMs - lastDeliveryAtMs >= MIN_LIVE_ACTIVITY_UPDATE_INTERVAL_MS
  );
}

// "suppressed": a Live Activity owns this state but no update is due; callers
// must not fall back to an alert push or every republish would ring the device.
function chooseLiveActivityDelivery(input: {
  readonly device: DirectPushDevice;
  readonly aggregate: RelayAgentActivityAggregateState | null;
  readonly nowMs: number;
  readonly replay: boolean;
}): ChosenDelivery | "suppressed" | null {
  const token = input.device.activityPushToken;
  if (!input.device.preferences.liveActivitiesEnabled) {
    return token ? { kind: "live_activity_end", token, aggregate: null, alert: null } : null;
  }
  // Activities are started by the app in the foreground, never remotely.
  if (!token) return null;
  if (input.aggregate === null) {
    // Several servers can feed the same card. A server only ends a card it
    // filled itself, so an idle server never ends another server's activity.
    return input.device.lastAggregate === null
      ? null
      : { kind: "live_activity_end", token, aggregate: null, alert: null };
  }
  const previous = input.device.lastAggregate;
  return shouldUpdateLiveActivity({
    previous,
    next: input.aggregate,
    lastDeliveryAt: input.device.lastLiveActivityDeliveryAt,
    nowMs: input.nowMs,
  })
    ? {
        kind: "live_activity_update",
        token,
        aggregate: input.aggregate,
        alert:
          input.replay || !input.device.preferences.notificationsEnabled
            ? null
            : alertForTransition({
                previous,
                next: input.aggregate,
                preferences: input.device.preferences,
                nowMs: input.nowMs,
              }),
      }
    : "suppressed";
}

/**
 * Everything to send to one device for one published aggregate, in order. A
 * Live Activity end that carries a companion push notification stays silent so
 * the device buzzes once.
 */
export function chooseDeliveries(input: {
  readonly device: DirectPushDevice;
  readonly aggregate: RelayAgentActivityAggregateState | null;
  readonly nowMs: number;
  readonly replay: boolean;
}): ReadonlyArray<ChosenDelivery> {
  if (input.device.platform !== "ios") return [];
  const liveActivity = chooseLiveActivityDelivery(input);
  if (liveActivity === "suppressed") return [];
  const notification = input.replay ? null : notificationForAggregate(input);
  if (liveActivity === null) {
    return notification && input.device.pushToken
      ? [{ kind: "push_notification", token: input.device.pushToken, notification }]
      : [];
  }
  if (liveActivity.kind !== "live_activity_end") return [liveActivity];
  if (notification && input.device.pushToken) {
    return [
      { ...liveActivity, alert: null },
      { kind: "push_notification", token: input.device.pushToken, notification },
    ];
  }
  return [
    {
      ...liveActivity,
      alert: input.replay
        ? null
        : alertForTerminalAggregate(liveActivity.aggregate, input.device.preferences),
    },
  ];
}

function alertPayload(alert: LiveActivityAlert) {
  return { alert: { title: alert.title, body: alert.body, sound: "default" } };
}

export function makeApnsRequest(delivery: ChosenDelivery, nowEpochSeconds: number): ApnsRequest {
  const timestamp = nowEpochSeconds;
  switch (delivery.kind) {
    case "live_activity_update":
      return {
        token: delivery.token,
        pushType: "liveactivity",
        // Alerting updates must land immediately; routine redraws stay low priority.
        priority: delivery.alert ? "10" : "5",
        payload: {
          aps: {
            timestamp,
            event: "update",
            ...(delivery.alert ? alertPayload(delivery.alert) : {}),
            "content-state": {
              name: LIVE_ACTIVITY_NAME,
              props: JSON.stringify(sanitizeAggregate(delivery.aggregate)),
            },
            "stale-date": timestamp + STALE_AFTER_SECONDS,
          },
        },
      };
    case "live_activity_end":
      return {
        token: delivery.token,
        pushType: "liveactivity",
        priority: "10",
        payload: {
          aps: {
            timestamp,
            event: "end",
            ...(delivery.aggregate
              ? {
                  "content-state": {
                    name: LIVE_ACTIVITY_NAME,
                    props: JSON.stringify(sanitizeAggregate(delivery.aggregate)),
                  },
                }
              : {}),
            ...(delivery.alert ? alertPayload(delivery.alert) : {}),
            "dismissal-date":
              timestamp +
              (delivery.aggregate ? DISMISS_AFTER_SECONDS : CONTENTLESS_DISMISS_AFTER_SECONDS),
          },
        },
      };
    case "push_notification": {
      const notification = delivery.notification;
      return {
        token: delivery.token,
        pushType: "alert",
        priority: "10",
        payload: {
          aps: {
            alert: { title: notification.title, body: notification.body },
            sound: "default",
            // Notification Center stacks alerts by thread.
            "thread-id":
              notification.threadId.length > 0
                ? `${notification.environmentId}/${notification.threadId}`
                : "t3-agent-alerts",
          },
          environmentId: notification.environmentId,
          threadId: notification.threadId,
          deepLink: notification.deepLink,
        },
      };
    }
  }
}

export function isPermanentApnsTokenFailure(status: number, reason: string | null): boolean {
  return (
    status === 410 ||
    (status === 400 && reason !== null && PERMANENT_APNS_TOKEN_REASONS.has(reason))
  );
}
