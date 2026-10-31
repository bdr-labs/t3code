import { describe, expect, it } from "vite-plus/test";

import {
  claudeOAuthUsageToLimits,
  claudeRateLimitEventToUpdate,
  claudeUsageResponseToLimits,
} from "./claudeUsageLimits.ts";

const checkedAt = "2026-07-18T10:00:00.000Z";
const noNames = { overageIncluded: undefined } as const;

describe("claudeUsageResponseToLimits", () => {
  it("maps the session, weekly, and model-scoped weekly windows", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: 54, resets_at: "2026-07-18T14:39:00Z" },
            seven_day: { utilization: 18.4, resets_at: "2026-07-24T08:59:00+00:00" },
            seven_day_opus: { utilization: 3, resets_at: null },
            ...({
              model_scoped: [
                { display_name: "Fable", utilization: 73, resets_at: "2026-07-24T08:59:00Z" },
                { display_name: "Ghost", utilization: null, resets_at: null },
              ],
            } as object),
            extra_usage: {
              is_enabled: false,
              monthly_limit: null,
              used_credits: null,
              utilization: null,
            },
          },
        },
      }),
    ).toEqual({
      names: { overageIncluded: "Fable" },
      limits: {
        checkedAt,
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            source: "probe",
            usedPercent: 54,
            windowDurationMins: 300,
            resetsAt: "2026-07-18T14:39:00.000Z",
          },
          {
            id: "seven_day",
            kind: "weekly",
            label: "Weekly",
            source: "probe",
            usedPercent: 18.4,
            windowDurationMins: 10080,
            resetsAt: "2026-07-24T08:59:00.000Z",
          },
          {
            id: "seven_day_fable",
            kind: "weekly",
            label: "Weekly · Fable",
            source: "probe",
            usedPercent: 73,
            windowDurationMins: 10080,
            resetsAt: "2026-07-24T08:59:00.000Z",
          },
        ],
      },
    });
  });

  it("names the overage-included bucket only from a scoped entry that drew a row", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            ...({
              model_scoped: [
                { display_name: "Ghost", utilization: null, resets_at: null },
                { display_name: "Fable", utilization: 5, resets_at: null },
              ],
            } as object),
          },
        },
      }).names,
    ).toEqual({ overageIncluded: "Fable" });
  });

  it("skips a window the endpoint reports without a utilization", () => {
    expect(
      claudeUsageResponseToLimits({
        checkedAt,
        response: {
          rate_limits_available: true,
          rate_limits: {
            five_hour: { utilization: null, resets_at: null },
            seven_day: { utilization: 250, resets_at: null },
          },
        },
      }).limits.windows,
    ).toEqual([
      {
        id: "seven_day",
        kind: "weekly",
        label: "Weekly",
        source: "probe",
        usedPercent: 100,
        windowDurationMins: 10080,
      },
    ]);
  });

  const enterpriseResponse = {
    rate_limits_available: true,
    rate_limits: {
      five_hour: null,
      seven_day: null,
      spend: {
        enabled: true,
        used: { amount_minor: 4_631, currency: "USD", exponent: 2 },
        limit: { amount_minor: 50_000, currency: "USD", exponent: 2 },
        percent: 9,
      },
      extra_usage: {
        is_enabled: true,
        used_credits: 4_631,
        monthly_limit: 50_000,
        utilization: 9.261999999999999,
        currency: "USD",
        decimal_places: 2,
      },
    },
  };
  const monthlyWindow = {
    id: "monthly_spend",
    kind: "monthly",
    label: "Monthly spend",
    usedPercent: expect.closeTo(9.262, 10),
  };

  it("maps the captured Enterprise budget precisely, preferring spend beside rolling windows", () => {
    expect(claudeUsageResponseToLimits({ checkedAt, response: enterpriseResponse }).limits).toEqual(
      {
        checkedAt,
        windows: [monthlyWindow],
      },
    );
    const response = {
      ...enterpriseResponse,
      rate_limits: {
        ...enterpriseResponse.rate_limits,
        five_hour: { utilization: 12, resets_at: null },
        extra_usage: {
          ...enterpriseResponse.rate_limits.extra_usage,
          used_credits: 30_000,
          utilization: 60,
        },
      },
    };
    expect(claudeUsageResponseToLimits({ checkedAt, response }).limits.windows).toEqual([
      {
        id: "five_hour",
        kind: "session",
        label: "Session",
        source: "probe",
        usedPercent: 12,
        windowDurationMins: 300,
      },
      monthlyWindow,
    ]);
  });

  it("falls back to enabled extra usage amounts or utilization when spend is unusable", () => {
    const response = {
      ...enterpriseResponse,
      rate_limits: {
        ...enterpriseResponse.rate_limits,
        spend: {
          ...enterpriseResponse.rate_limits.spend,
          enabled: false,
          used: { amount_minor: 30_000, currency: "USD", exponent: 2 },
        },
        extra_usage: { ...enterpriseResponse.rate_limits.extra_usage, utilization: 9 },
      },
    };
    expect(claudeUsageResponseToLimits({ checkedAt, response }).limits.windows).toEqual([
      monthlyWindow,
    ]);
    const utilizationOnly = {
      ...response,
      rate_limits: {
        ...response.rate_limits,
        spend: { enabled: true, used: null, limit: null, percent: 9 },
        extra_usage: {
          ...enterpriseResponse.rate_limits.extra_usage,
          used_credits: null,
          monthly_limit: null,
        },
      },
    };
    expect(
      claudeUsageResponseToLimits({ checkedAt, response: utilizationOnly }).limits.windows,
    ).toEqual([monthlyWindow]);
  });

  it("omits disabled budgets and refuses invalid money without an enabled fallback", () => {
    const rateLimits = enterpriseResponse.rate_limits;
    const response = {
      ...enterpriseResponse,
      rate_limits: {
        ...rateLimits,
        spend: { ...rateLimits.spend, enabled: false },
        extra_usage: { ...rateLimits.extra_usage, is_enabled: false },
      },
    };
    expect(claudeUsageResponseToLimits({ checkedAt, response }).limits.windows).toEqual([]);
    response.rate_limits.spend = {
      ...rateLimits.spend,
      limit: { ...rateLimits.spend.limit, currency: "EUR" },
    };
    expect(claudeUsageResponseToLimits({ checkedAt, response }).limits.windows).toEqual([]);
    response.rate_limits.spend = {
      ...rateLimits.spend,
      limit: { ...rateLimits.spend.limit, amount_minor: 0 },
    };
    expect(claudeUsageResponseToLimits({ checkedAt, response }).limits.windows).toEqual([]);
  });
});

describe("claudeRateLimitEventToUpdate", () => {
  it("scales the 0–1 utilization and epoch-second reset onto the probe's window id", () => {
    expect(
      claudeRateLimitEventToUpdate(
        {
          status: "allowed_warning",
          rateLimitType: "seven_day",
          utilization: 0.85,
          resetsAt: 1_784_000_000,
        },
        noNames,
      ),
    ).toEqual({
      windows: [
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          source: "turn",
          usedPercent: 85,
          windowDurationMins: 10080,
          resetsAt: "2026-07-14T03:33:20.000Z",
        },
      ],
    });
  });

  it("lands the streamed overage-included bucket on the row the probe named", () => {
    const event = {
      status: "allowed",
      rateLimitType: "seven_day_overage_included" as never,
      utilization: 0.4,
    } as const;
    expect(claudeRateLimitEventToUpdate(event, noNames)).toBeUndefined();
    expect(claudeRateLimitEventToUpdate(event, { overageIncluded: "Fable" })).toEqual({
      windows: [
        {
          id: "seven_day_fable",
          kind: "weekly",
          label: "Weekly · Fable",
          source: "turn",
          usedPercent: 40,
          windowDurationMins: 10080,
        },
      ],
    });
  });

  it("reads every recognized window from unifiedWindows without a top-level utilization", () => {
    const update = claudeRateLimitEventToUpdate(
      {
        status: "allowed",
        rateLimitType: "five_hour",
        resetsAt: 1_784_000_000,
        unifiedWindows: {
          five_hour: { utilization: 0.02, resetsAt: 1_784_000_000 },
          seven_day: { utilization: 0.11, resetsAt: 1_784_600_000 },
          seven_day_overage_included: { utilization: 0.4, resetsAt: 1_784_500_000 },
        },
      } as never,
      { overageIncluded: "Fable" },
    );

    expect(update).toEqual({
      windows: [
        {
          id: "five_hour",
          kind: "session",
          label: "Session",
          source: "turn",
          usedPercent: 2,
          windowDurationMins: 300,
          resetsAt: "2026-07-14T03:33:20.000Z",
        },
        {
          id: "seven_day",
          kind: "weekly",
          label: "Weekly",
          source: "turn",
          usedPercent: 11,
          windowDurationMins: 10080,
          resetsAt: "2026-07-21T02:13:20.000Z",
        },
        {
          id: "seven_day_fable",
          kind: "weekly",
          label: "Weekly · Fable",
          source: "turn",
          usedPercent: 40,
          windowDurationMins: 10080,
          resetsAt: "2026-07-19T22:26:40.000Z",
        },
      ],
      replaces: ["five_hour", "seven_day"],
    });
  });

  it("replaces the rolling windows when unifiedWindows no longer lists the 5h window", () => {
    const update = claudeRateLimitEventToUpdate(
      {
        status: "allowed",
        rateLimitType: "seven_day",
        resetsAt: 1_784_600_000,
        unifiedWindows: { seven_day: { utilization: 0.79, resetsAt: 1_784_600_000 } },
      } as never,
      noNames,
    );

    expect(update?.windows.map((window) => window.id)).toEqual(["seven_day"]);
    expect(update?.replaces).toEqual(["five_hour", "seven_day"]);
  });

  it("keeps a legacy single-window event partial", () => {
    const update = claudeRateLimitEventToUpdate(
      {
        status: "allowed",
        rateLimitType: "seven_day",
        utilization: 0.5,
        resetsAt: 1_784_600_000,
      } as never,
      noNames,
    );

    expect(update?.replaces).toBeUndefined();
  });
});

describe("claudeOAuthUsageToLimits", () => {
  it("maps OAuth percentages and model windows onto the SDK identities", () => {
    const limits = claudeOAuthUsageToLimits({
      checkedAt,
      names: { overageIncluded: "Fable" },
      response: {
        five_hour: { utilization: 60, resets_at: "2026-07-18T14:39:00Z" },
        seven_day: { utilization: 0.5, resets_at: null },
        seven_day_opus: { utilization: 7, resets_at: null },
        seven_day_sonnet: null,
        seven_day_overage_included: { utilization: 42, resets_at: null },
        cedar_ember: { eligible: false },
      },
    });
    expect(
      limits?.windows.map(
        ({ id, label, kind, source, usedPercent, windowDurationMins, checkedAt }) => ({
          id,
          label,
          kind,
          source,
          usedPercent,
          windowDurationMins,
          checkedAt,
        }),
      ),
    ).toEqual([
      {
        id: "five_hour",
        label: "Session",
        kind: "session",
        source: "account",
        usedPercent: 60,
        windowDurationMins: 300,
        checkedAt,
      },
      {
        id: "seven_day",
        label: "Weekly",
        kind: "weekly",
        source: "account",
        usedPercent: 0.5,
        windowDurationMins: 10080,
        checkedAt,
      },
      {
        id: "seven_day_fable",
        label: "Weekly · Fable",
        kind: "weekly",
        source: "account",
        usedPercent: 42,
        windowDurationMins: 10080,
        checkedAt,
      },
      {
        id: "seven_day_opus",
        label: "Weekly · Opus",
        kind: "weekly",
        source: "account",
        usedPercent: 7,
        windowDurationMins: 10080,
        checkedAt,
      },
    ]);
    expect(limits?.windows[0]?.resetsAt).toBe("2026-07-18T14:39:00.000Z");
  });

  it("ignores null, malformed, and out-of-range numbers instead of reporting zero", () => {
    for (const utilization of [null, "60", NaN, Infinity, -1, 101]) {
      expect(
        claudeOAuthUsageToLimits({
          checkedAt,
          names: noNames,
          response: { five_hour: { utilization, resets_at: null } },
        }),
      ).toBeUndefined();
    }
    expect(claudeOAuthUsageToLimits({ checkedAt, names: noNames, response: null })).toBeUndefined();
  });

  it("uses the SDK's model_scoped display names and skips unsupported fields", () => {
    expect(
      claudeOAuthUsageToLimits({
        checkedAt,
        names: noNames,
        response: {
          model_scoped: [{ display_name: "Fable", utilization: 10, resets_at: null }],
          seven_day_oauth_apps: { utilization: 80, resets_at: null },
        },
      })?.windows,
    ).toEqual([
      {
        id: "seven_day_fable",
        kind: "weekly",
        label: "Weekly · Fable",
        source: "account",
        usedPercent: 10,
        windowDurationMins: 10080,
        checkedAt,
      },
    ]);
  });
});
