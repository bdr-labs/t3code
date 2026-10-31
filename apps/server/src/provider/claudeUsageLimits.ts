import type { SDKControlGetUsageResponse, SDKRateLimitInfo } from "@anthropic-ai/claude-agent-sdk";
import type {
  ProviderUsageLimitsUpdate,
  ServerProviderUsageLimits,
  ServerProviderUsageWindow,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";

import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";

const SESSION_MINS = 5 * 60;
const WEEK_MINS = 7 * 24 * 60;
type UsageSource = NonNullable<ServerProviderUsageWindow["source"]>;

const WINDOWS: Readonly<
  Record<string, Pick<ServerProviderUsageWindow, "kind" | "label" | "windowDurationMins">>
> = {
  five_hour: { kind: "session", label: "Session", windowDurationMins: SESSION_MINS },
  seven_day: { kind: "weekly", label: "Weekly", windowDurationMins: WEEK_MINS },
};

/** Reuse probed display names for streamed bucket types so mid-turn updates target the same row. */
const OVERAGE_INCLUDED_EVENT_TYPE = "seven_day_overage_included";

// The SDK does not yet type the spend budget returned by `get_usage`.
const SpendMoney = Schema.Struct({
  amount_minor: Schema.Natural,
  currency: Schema.NonEmptyString,
  exponent: Schema.Natural,
});
const decodeSpendBudget = Schema.decodeUnknownOption(
  Schema.Struct({ enabled: Schema.Boolean, used: SpendMoney, limit: SpendMoney }),
);

export interface ClaudeScopedLimitNames {
  readonly overageIncluded: string | undefined;
}

export const makeClaudeScopedLimitNames = Ref.make<ClaudeScopedLimitNames>({
  overageIncluded: undefined,
});

function scopedWindowId(displayName: string): string {
  return `seven_day_${displayName.toLowerCase().replace(/[^a-z0-9]+/g, "_")}`;
}

function scopedWindow(
  displayName: string,
  usedPercent: number,
  resetsAt: string | undefined,
  source: UsageSource,
): ServerProviderUsageWindow {
  return {
    id: scopedWindowId(displayName),
    kind: "weekly",
    label: `Weekly · ${displayName}`,
    source,
    windowDurationMins: WEEK_MINS,
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

function percentFromAmounts(used: number | null | undefined, limit: number | null | undefined) {
  if (
    typeof used !== "number" ||
    typeof limit !== "number" ||
    !Number.isFinite(used) ||
    !Number.isFinite(limit) ||
    used < 0 ||
    limit <= 0
  ) {
    return undefined;
  }
  const percent = (used / limit) * 100;
  return Number.isFinite(percent) ? clampPercent(percent) : undefined;
}

function readSpendPercent(rateLimits: NonNullable<SDKControlGetUsageResponse["rate_limits"]>) {
  const spend = Option.getOrUndefined(
    decodeSpendBudget((rateLimits as { readonly spend?: unknown }).spend),
  );
  // Minor-unit ratios require matching currency and scale; spend.percent is rounded.
  if (
    spend?.enabled &&
    spend.used.currency.trim().length > 0 &&
    spend.used.currency.trim() === spend.limit.currency.trim() &&
    spend.used.exponent === spend.limit.exponent
  ) {
    const percent = percentFromAmounts(spend.used.amount_minor, spend.limit.amount_minor);
    if (percent !== undefined) return percent;
  }

  const extra = rateLimits.extra_usage;
  if (extra?.is_enabled !== true) return undefined;
  const percent = percentFromAmounts(extra.used_credits, extra.monthly_limit) ?? extra.utilization;
  return typeof percent === "number" && Number.isFinite(percent) && percent >= 0
    ? clampPercent(percent)
    : undefined;
}

/**
 * `model_scoped` shipped in the CLI after the SDK typings we pin, so it is
 * read structurally until the `.d.ts` catches up.
 */
interface ModelScopedWindow {
  readonly display_name: string;
  readonly utilization: number | null;
  readonly resets_at: string | null;
}

function readModelScoped(rateLimits: object): ReadonlyArray<ModelScopedWindow> {
  const raw = (rateLimits as { readonly model_scoped?: unknown }).model_scoped;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (entry): entry is ModelScopedWindow =>
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as ModelScopedWindow).display_name === "string",
  );
}

function isoFromEpochSeconds(value: number | undefined): string | undefined {
  if (value === undefined || !Number.isFinite(value) || value <= 0) return undefined;
  const dt = DateTime.make(value * 1000);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function isoFromString(value: string | null | undefined): string | undefined {
  if (!value) return undefined;
  const dt = DateTime.make(value);
  return Option.isSome(dt) ? DateTime.formatIso(dt.value) : undefined;
}

function makeWindow(
  id: keyof typeof WINDOWS & string,
  usedPercent: number,
  resetsAt: string | undefined,
  source: UsageSource,
): ServerProviderUsageWindow {
  const window = WINDOWS[id]!;
  return {
    id,
    ...window,
    source,
    usedPercent: clampPercent(usedPercent),
    ...(resetsAt ? { resetsAt } : {}),
  };
}

interface UnifiedRateLimitWindow {
  readonly utilization?: unknown;
  readonly resetsAt?: unknown;
}

function readUnifiedWindows(info: SDKRateLimitInfo): Readonly<Record<string, unknown>> {
  const unified = (info as SDKRateLimitInfo & { readonly unifiedWindows?: unknown }).unifiedWindows;
  return typeof unified === "object" && unified !== null && !Array.isArray(unified)
    ? (unified as Readonly<Record<string, unknown>>)
    : {};
}

function readEventReading(
  info: SDKRateLimitInfo,
  unifiedWindows: Readonly<Record<string, unknown>>,
  type: string,
): { readonly usedPercent: number; readonly resetsAt: string | undefined } | undefined {
  const unified = unifiedWindows[type];
  if (typeof unified === "object" && unified !== null) {
    const { utilization, resetsAt } = unified as UnifiedRateLimitWindow;
    if (typeof utilization === "number" && Number.isFinite(utilization)) {
      return {
        usedPercent: utilization * 100,
        resetsAt: isoFromEpochSeconds(
          typeof resetsAt === "number" && Number.isFinite(resetsAt) ? resetsAt : undefined,
        ),
      };
    }
  }
  if (info.rateLimitType !== type || typeof info.utilization !== "number") return undefined;
  return {
    usedPercent: info.utilization * 100,
    resetsAt: isoFromEpochSeconds(info.resetsAt),
  };
}

/** Stream utilization is 0-1. Drop unnamed overage buckets until probed to avoid unreconcilable rows. */
export function claudeRateLimitEventToUpdate(
  info: SDKRateLimitInfo,
  names: ClaudeScopedLimitNames,
): ProviderUsageLimitsUpdate | undefined {
  const unifiedWindows = readUnifiedWindows(info);
  const windows: ServerProviderUsageWindow[] = [];
  for (const type of Object.keys(WINDOWS)) {
    const reading = readEventReading(info, unifiedWindows, type);
    if (reading) {
      windows.push(makeWindow(type, reading.usedPercent, reading.resetsAt, "turn"));
    }
  }
  const overage = readEventReading(info, unifiedWindows, OVERAGE_INCLUDED_EVENT_TYPE);
  if (overage && names.overageIncluded) {
    windows.push(
      scopedWindow(names.overageIncluded, overage.usedPercent, overage.resetsAt, "turn"),
    );
  }
  // unifiedWindows lists every rolling window the account has, so one it omits is gone.
  if (Object.keys(unifiedWindows).length > 0) {
    return { windows, replaces: Object.keys(WINDOWS) };
  }
  return windows.length > 0 ? { windows } : undefined;
}

/** get_usage percentages are already 0-100. */
export function claudeUsageResponseToLimits(input: {
  readonly response: Pick<SDKControlGetUsageResponse, "rate_limits_available" | "rate_limits">;
  readonly checkedAt: string;
  readonly source?: UsageSource;
}): { readonly limits: ServerProviderUsageLimits; readonly names: ClaudeScopedLimitNames } {
  const { response, checkedAt } = input;
  const source = input.source ?? "probe";
  if (!response.rate_limits_available || !response.rate_limits) {
    return {
      limits: makeUnavailableUsageLimits({
        checkedAt,
        reason: response.rate_limits_available ? "probeFailed" : "unsupported",
      }),
      names: { overageIncluded: undefined },
    };
  }
  const windows: ServerProviderUsageWindow[] = [];
  for (const id of Object.keys(WINDOWS)) {
    const window = response.rate_limits[id as "five_hour" | "seven_day"];
    if (!window || typeof window.utilization !== "number") continue;
    windows.push(makeWindow(id, window.utilization, isoFromString(window.resets_at), source));
  }
  // The CLI's overage allowlist currently has one model; events refer to its first entry.
  let overageIncluded: string | undefined;
  for (const entry of readModelScoped(response.rate_limits)) {
    if (typeof entry.utilization !== "number") continue;
    windows.push(
      scopedWindow(entry.display_name, entry.utilization, isoFromString(entry.resets_at), source),
    );
    overageIncluded ??= entry.display_name;
  }
  const spendPercent = readSpendPercent(response.rate_limits);
  if (spendPercent !== undefined) {
    windows.push({
      id: "monthly_spend",
      kind: "monthly",
      label: "Monthly spend",
      usedPercent: spendPercent,
    });
  }
  return {
    limits: makeUsageLimits({ checkedAt, windows }),
    names: { overageIncluded },
  };
}

export const recordClaudeUsageResponse = (
  namesRef: Ref.Ref<ClaudeScopedLimitNames>,
  input: Parameters<typeof claudeUsageResponseToLimits>[0],
): Effect.Effect<ServerProviderUsageLimits> => {
  const { limits, names } = claudeUsageResponseToLimits(input);
  return Ref.set(namesRef, names).pipe(Effect.as(limits));
};

const OAuthWindow = Schema.Struct({
  utilization: Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 })),
  resets_at: Schema.NullOr(Schema.String),
});
const decodeOAuthWindow = Schema.decodeUnknownOption(OAuthWindow);

/** The OAuth endpoint, like get_usage, reports percentages rather than fractions. */
export function claudeOAuthUsageToLimits(input: {
  readonly response: unknown;
  readonly checkedAt: string;
  readonly names: ClaudeScopedLimitNames;
}): ServerProviderUsageLimits | undefined {
  if (typeof input.response !== "object" || input.response === null) return undefined;
  const response = input.response as Record<string, unknown>;
  const windows: ServerProviderUsageWindow[] = [];
  for (const id of Object.keys(WINDOWS)) {
    const parsed = decodeOAuthWindow(response[id]);
    if (Option.isSome(parsed)) {
      windows.push(
        makeWindow(id, parsed.value.utilization, isoFromString(parsed.value.resets_at), "account"),
      );
    }
  }
  // Use the same normalized ids and display labels as the SDK's model_scoped rows.
  const names = new Set([
    "Opus",
    "Sonnet",
    ...(input.names.overageIncluded ? [input.names.overageIncluded] : []),
  ]);
  for (const name of names) {
    const raw =
      response[scopedWindowId(name)] ??
      (name === input.names.overageIncluded ? response.seven_day_overage_included : undefined);
    const parsed = decodeOAuthWindow(raw);
    if (Option.isSome(parsed)) {
      windows.push(
        scopedWindow(
          name,
          parsed.value.utilization,
          isoFromString(parsed.value.resets_at),
          "account",
        ),
      );
    }
  }
  for (const entry of readModelScoped(response)) {
    const parsed = decodeOAuthWindow(entry);
    if (
      Option.isSome(parsed) &&
      !windows.some((window) => window.id === scopedWindowId(entry.display_name))
    ) {
      windows.push(
        scopedWindow(
          entry.display_name,
          parsed.value.utilization,
          isoFromString(parsed.value.resets_at),
          "account",
        ),
      );
    }
  }
  return windows.length > 0
    ? makeUsageLimits({
        checkedAt: input.checkedAt,
        windows: windows.map((window) => ({ ...window, checkedAt: input.checkedAt })),
      })
    : undefined;
}
