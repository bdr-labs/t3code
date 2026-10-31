import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";

const WINDOW_KIND_ORDER: Record<ServerProviderUsageWindow["kind"], number> = {
  session: 0,
  weekly: 1,
  monthly: 2,
  other: 3,
};

const PROBE_AUTHORITY_WINDOW_MS = 15 * 60_000;

export function clampPercent(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : 0;
}

function sortWindows(
  windows: Iterable<ServerProviderUsageWindow>,
): ReadonlyArray<ServerProviderUsageWindow> {
  return [...windows].toSorted(
    (left, right) =>
      WINDOW_KIND_ORDER[left.kind] - WINDOW_KIND_ORDER[right.kind] ||
      left.id.localeCompare(right.id),
  );
}

function parseTimeMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * A reset that has passed must not leave the old percentage looking current.
 * Keep the window so the client can show the reset state until a fresh reading
 * replaces it.
 */
function normalizeUsageWindow(
  window: ServerProviderUsageWindow,
  nowMs: number,
): ServerProviderUsageWindow {
  const resetMs = parseTimeMs(window.resetsAt);
  if (window.resetPending === true && resetMs === undefined) {
    return { ...window, usedPercent: 0 };
  }
  if (resetMs !== undefined && resetMs <= nowMs) {
    return { ...window, usedPercent: 0, resetPending: true };
  }
  if (window.resetPending !== true) return window;
  const { resetPending: _resetPending, ...cleared } = window;
  return cleared;
}

function normalizeUsageLimitsAt(
  limits: ServerProviderUsageLimits,
  nowMs: number,
): ServerProviderUsageLimits {
  let changed = false;
  const windows = limits.windows.map((window) => {
    const withCheckedAt =
      window.checkedAt === undefined ? { ...window, checkedAt: limits.checkedAt } : window;
    if (withCheckedAt !== window) changed = true;
    const normalized = normalizeUsageWindow(withCheckedAt, nowMs);
    if (normalized !== withCheckedAt) changed = true;
    return normalized;
  });
  return changed ? { ...limits, windows } : limits;
}

function windowFetchMs(window: ServerProviderUsageWindow, fallback: string): number | undefined {
  return parseTimeMs(window.checkedAt ?? fallback);
}

/** A reading may not carry a reset that already happened before it was fetched. */
function isPreResetReading(window: ServerProviderUsageWindow, fallbackCheckedAt: string): boolean {
  const fetchedAtMs = windowFetchMs(window, fallbackCheckedAt);
  const resetMs = parseTimeMs(window.resetsAt);
  return fetchedAtMs !== undefined && resetMs !== undefined && resetMs <= fetchedAtMs;
}

function hasRecentAuthority(
  existing: ServerProviderUsageWindow,
  incomingFetchMs: number | undefined,
): boolean {
  if (incomingFetchMs === undefined) return false;
  const source = existing.source;
  if (source !== "account" && source !== "turn") return false;
  const existingFetchMs = parseTimeMs(existing.checkedAt);
  return (
    existingFetchMs !== undefined &&
    incomingFetchMs >= existingFetchMs &&
    incomingFetchMs - existingFetchMs < PROBE_AUTHORITY_WINDOW_MS
  );
}

export function makeUsageLimits(input: {
  readonly checkedAt: string;
  readonly windows: Iterable<ServerProviderUsageWindow>;
}): ServerProviderUsageLimits {
  const nowMs = parseTimeMs(input.checkedAt);
  return {
    checkedAt: input.checkedAt,
    windows: sortWindows(
      [...input.windows].map((window) =>
        nowMs === undefined ? window : normalizeUsageWindow(window, nowMs),
      ),
    ),
  };
}

export function makeUnavailableUsageLimits(input: {
  readonly checkedAt: string;
  readonly reason: "unsupported" | "probeFailed";
  readonly message?: string;
}): ServerProviderUsageLimits {
  return {
    checkedAt: input.checkedAt,
    windows: [],
    unavailable: {
      reason: input.reason,
      ...(input.message ? { message: input.message } : {}),
    },
  };
}

export function applyUsageLimitsUpdate(input: {
  readonly previous: ServerProviderUsageLimits | undefined;
  readonly update: ProviderUsageLimitsUpdate;
  readonly checkedAt: string;
}): ServerProviderUsageLimits | undefined {
  const { previous, update } = input;
  if (previous?.unavailable?.reason === "unsupported") {
    return previous;
  }
  const previousCheckedAtMs = parseTimeMs(previous?.checkedAt);
  const updateCheckedAtMs = parseTimeMs(input.checkedAt);
  const mergeNowMs =
    previousCheckedAtMs !== undefined && updateCheckedAtMs !== undefined
      ? Math.max(previousCheckedAtMs, updateCheckedAtMs)
      : (updateCheckedAtMs ?? previousCheckedAtMs);
  const normalizedPrevious =
    previous === undefined || mergeNowMs === undefined
      ? previous
      : normalizeUsageLimitsAt(previous, mergeNowMs);
  if (update.windows.length === 0 && (update.replaces ?? []).length === 0) {
    return normalizedPrevious;
  }
  const merged = new Map(normalizedPrevious?.windows.map((window) => [window.id, window] as const));
  // Keep the newest fetch time even for unchanged values so delayed events cannot look newer.
  let changed = normalizedPrevious !== previous;
  // A window the account no longer has (a plan without a 5h limit) drops out
  // unless a reading newer than this one still reports it.
  for (const id of update.replaces ?? []) {
    if (update.windows.some((window) => window.id === id)) continue;
    const existing = merged.get(id);
    if (existing === undefined) continue;
    const existingCheckedAtMs = parseTimeMs(existing.checkedAt);
    if (
      updateCheckedAtMs !== undefined &&
      existingCheckedAtMs !== undefined &&
      existingCheckedAtMs > updateCheckedAtMs
    ) {
      continue;
    }
    merged.delete(id);
    changed = true;
  }
  for (const window of update.windows) {
    const existing = merged.get(window.id);
    const checkedAt = window.checkedAt ?? input.checkedAt;
    if (isPreResetReading(window, input.checkedAt)) continue;
    const incomingFetchMs = windowFetchMs(window, input.checkedAt);
    const incomingSource = window.source ?? "probe";
    if (existing && incomingSource === "probe" && hasRecentAuthority(existing, incomingFetchMs)) {
      continue;
    }
    const checkedAtMs = parseTimeMs(checkedAt);
    const existingCheckedAtMs = parseTimeMs(existing?.checkedAt);
    if (
      checkedAtMs !== undefined &&
      existingCheckedAtMs !== undefined &&
      checkedAtMs < existingCheckedAtMs
    ) {
      continue;
    }
    const next = normalizeUsageWindow(
      {
        ...window,
        checkedAt,
        usedPercent: clampPercent(window.usedPercent),
        ...(window.resetsAt === undefined && existing?.resetsAt !== undefined
          ? { resetsAt: existing.resetsAt }
          : {}),
        ...(window.windowDurationMins === undefined && existing?.windowDurationMins !== undefined
          ? { windowDurationMins: existing.windowDurationMins }
          : {}),
      },
      mergeNowMs ?? Date.parse(checkedAt),
    );
    if (
      existing === undefined ||
      !usageWindowEquals(existing, next) ||
      existing.checkedAt !== checkedAt
    ) {
      merged.set(window.id, next);
      changed = true;
    }
  }
  if (!changed) {
    return normalizedPrevious;
  }
  const unavailable =
    normalizedPrevious === undefined
      ? { reason: "probeFailed" as const }
      : normalizedPrevious.unavailable;
  return {
    ...makeUsageLimits({
      checkedAt:
        normalizedPrevious && Date.parse(normalizedPrevious.checkedAt) > Date.parse(input.checkedAt)
          ? normalizedPrevious.checkedAt
          : input.checkedAt,
      windows: merged.values(),
    }),
    ...(normalizedPrevious?.resetCredits !== undefined
      ? { resetCredits: normalizedPrevious.resetCredits }
      : {}),
    ...(unavailable !== undefined ? { unavailable } : {}),
  };
}

export function usageWindowEquals(
  a: ServerProviderUsageWindow,
  b: ServerProviderUsageWindow,
): boolean {
  return (
    a.id === b.id &&
    a.kind === b.kind &&
    a.label === b.label &&
    a.source === b.source &&
    a.usedPercent === b.usedPercent &&
    a.resetsAt === b.resetsAt &&
    a.resetPending === b.resetPending &&
    a.windowDurationMins === b.windowDurationMins
  );
}

/** Merge full reads by window fetch time, retaining newer sparse turn updates. */
export function resolveUsageLimitsAfterProbe(input: {
  readonly published: ServerProviderUsageLimits | undefined;
  readonly probed: ServerProviderUsageLimits | undefined;
}): ServerProviderUsageLimits | undefined {
  const { published, probed } = input;
  if (!probed) return published;
  if (!published) return probed.unavailable ? probed : makeUsageLimitsSnapshot(probed);
  const probeCheckedAtMs = parseTimeMs(probed.checkedAt);
  const publishedCheckedAtMs = parseTimeMs(published.checkedAt);
  const mergeNowMs =
    probeCheckedAtMs !== undefined && publishedCheckedAtMs !== undefined
      ? Math.max(probeCheckedAtMs, publishedCheckedAtMs)
      : (probeCheckedAtMs ?? publishedCheckedAtMs);
  const normalizedPublished =
    mergeNowMs === undefined ? published : normalizeUsageLimitsAt(published, mergeNowMs);
  if (probed.unavailable?.reason === "probeFailed") return normalizedPublished;
  if (probed.unavailable?.reason === "unsupported") {
    return Date.parse(probed.checkedAt) >= Date.parse(published.checkedAt)
      ? probed
      : normalizedPublished;
  }
  const probedMs = Date.parse(probed.checkedAt);
  // A probe read before the published snapshot cannot win a tie against its windows.
  const probedWindows =
    probedMs < Date.parse(normalizedPublished.checkedAt)
      ? probed.windows.filter((window) => {
          const existing = normalizedPublished.windows.find(({ id }) => id === window.id);
          const existingMs = parseTimeMs(existing?.checkedAt);
          const incomingMs = parseTimeMs(window.checkedAt ?? probed.checkedAt);
          return existingMs === undefined || incomingMs === undefined || incomingMs > existingMs;
        })
      : probed.windows;
  const merged = applyUsageLimitsUpdate({
    previous: normalizedPublished.unavailable ? undefined : normalizedPublished,
    update: { ...probed, windows: probedWindows },
    checkedAt: probed.checkedAt,
  });
  if (!merged) return normalizedPublished;
  // Credits and credential metadata belong to the newest full read. Account and
  // turn updates move the snapshot time without reading them, so they don't count.
  const lastFullReadMs = Math.max(
    -Infinity,
    ...normalizedPublished.windows
      .filter((window) => (window.source ?? "probe") === "probe")
      .map((window) => parseTimeMs(window.checkedAt) ?? -Infinity),
  );
  const metadata = probedMs >= lastFullReadMs ? probed : normalizedPublished;
  const { unavailable: _unavailable, ...metadataWithoutFailure } = metadata;
  return { ...metadataWithoutFailure, checkedAt: merged.checkedAt, windows: merged.windows };
}

function makeUsageLimitsSnapshot(limits: ServerProviderUsageLimits): ServerProviderUsageLimits {
  const nowMs = parseTimeMs(limits.checkedAt);
  return {
    ...limits,
    windows: limits.windows.map((window) => {
      const withCheckedAt = {
        ...window,
        checkedAt: window.checkedAt ?? limits.checkedAt,
      };
      return nowMs === undefined ? withCheckedAt : normalizeUsageWindow(withCheckedAt, nowMs);
    }),
  };
}
