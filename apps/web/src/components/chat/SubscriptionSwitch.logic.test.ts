import {
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  recommendSubscriptionSwitch,
  windowPace,
  windowsForModel,
} from "./SubscriptionSwitch.logic";

const nowMs = Date.parse("2026-10-11T12:00:00Z");
const iso = (offsetMs: number) => new Date(nowMs + offsetMs).toISOString();
const HOUR = 60 * 60_000;

function session(usedPercent: number, resetInHours: number): ServerProviderUsageWindow {
  return {
    id: "five_hour",
    kind: "session",
    label: "Session",
    usedPercent,
    resetsAt: iso(resetInHours * HOUR),
    windowDurationMins: 300,
    checkedAt: iso(-60_000),
  };
}

function weekly(
  usedPercent: number,
  resetInHours: number,
  id = "seven_day",
  label = "Weekly",
): ServerProviderUsageWindow {
  return {
    id,
    kind: "weekly",
    label,
    usedPercent,
    resetsAt: iso(resetInHours * HOUR),
    windowDurationMins: 7 * 24 * 60,
    checkedAt: iso(-60_000),
  };
}

function provider(
  instanceId: string,
  windows: ReadonlyArray<ServerProviderUsageWindow>,
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make(instanceId),
    driver: "claudeAgent",
    displayName: instanceId,
    enabled: true,
    installed: true,
    version: "1.0.0",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: iso(0),
    models: [
      {
        slug: "claude-opus-5-5",
        name: "Claude Opus 5.5",
        shortName: "Opus 5.5",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "claude-fable-5-1",
        name: "Claude Fable 5.1",
        shortName: "Fable 5.1",
        isCustom: false,
        capabilities: null,
      },
    ],
    slashCommands: [],
    skills: [],
    usageLimits: { checkedAt: iso(-60_000), windows: [...windows] },
    ...overrides,
  } as ServerProvider;
}

const recommend = (current: string, model: string, providers: ReadonlyArray<ServerProvider>) =>
  recommendSubscriptionSwitch({
    instanceId: ProviderInstanceId.make(current),
    model,
    providers,
    nowMs,
  });

describe("windowPace", () => {
  it("projects usage to the reset at the pace so far", () => {
    // 60% used with 2 of 5 hours left: 3 hours elapsed, on pace for 100%.
    expect(windowPace(session(60, 2), nowMs).projectedPercent).toBeCloseTo(100);
  });

  it("does not project from the first slice of a window", () => {
    expect(windowPace(session(8, 4.9), nowMs).projectedPercent).toBeNull();
  });

  it("treats a passed reset as empty", () => {
    expect(windowPace(session(95, -0.1), nowMs)).toMatchObject({
      usedPercent: 0,
      projectedPercent: null,
    });
  });
});

describe("windowsForModel", () => {
  it("keeps account-wide windows and only the model's own scoped weekly", () => {
    const limits = {
      checkedAt: iso(0),
      windows: [
        session(10, 2),
        weekly(10, 50),
        weekly(90, 50, "seven_day_fable", "Weekly · Fable"),
      ],
    };
    expect(windowsForModel(limits, "claude-opus-5-5").map((w) => w.id)).toEqual([
      "five_hour",
      "seven_day",
    ]);
    expect(windowsForModel(limits, "claude-fable-5-1").map((w) => w.id)).toEqual([
      "five_hour",
      "seven_day",
      "seven_day_fable",
    ]);
  });
});

describe("recommendSubscriptionSwitch", () => {
  it("suggests the same model on a subscription with headroom when the current one is running out", () => {
    const suggestion = recommend("claude-work", "claude-opus-5-5", [
      provider("claude-work", [session(70, 2), weekly(40, 100)]),
      provider("claude-personal", [session(10, 3), weekly(20, 100)]),
    ]);
    expect(suggestion).toMatchObject({
      kind: "pressure",
      instanceId: "claude-personal",
      model: "claude-opus-5-5",
      modelName: "Opus 5.5",
    });
    expect(suggestion?.reason).toContain("Session is on pace for 117%");
  });

  it("picks the subscription with the most headroom", () => {
    const suggestion = recommend("a", "claude-opus-5-5", [
      provider("a", [session(95, 1)]),
      provider("b", [session(60, 1)]),
      provider("c", [session(20, 1)]),
    ]);
    expect(suggestion?.instanceId).toBe("c");
  });

  it("only counts the model's own scoped weekly", () => {
    const providers = [
      provider("a", [
        session(10, 2),
        weekly(30, 100),
        weekly(95, 100, "seven_day_fable", "Weekly · Fable"),
      ]),
      provider("b", [session(10, 2), weekly(30, 100)]),
    ];
    expect(recommend("a", "claude-opus-5-5", providers)).toBeNull();
    expect(recommend("a", "claude-fable-5-1", providers)?.instanceId).toBe("b");
  });

  it("never suggests a subscription that lacks the model, is signed out, or is also running out", () => {
    const hot = [session(95, 1)];
    expect(
      recommend("a", "claude-opus-5-5", [
        provider("a", hot),
        provider("no-model", [session(5, 1)], { models: [] }),
        provider("signed-out", [session(5, 1)], { auth: { status: "unauthenticated" } }),
        provider("disabled", [session(5, 1)], { enabled: false }),
        provider("also-hot", [session(92, 1)]),
        provider("unknown", [], { usageLimits: undefined }),
      ]),
    ).toBeNull();
  });

  it("does nothing when the current limits are unknown or stale", () => {
    const stale = { ...session(99, 1), checkedAt: iso(-60 * 60_000) };
    expect(
      recommend("a", "claude-opus-5-5", [
        provider("a", [stale], { usageLimits: { checkedAt: iso(-60 * 60_000), windows: [stale] } }),
        provider("b", [session(5, 1)]),
      ]),
    ).toBeNull();
  });

  it("suggests using another subscription whose weekly allowance is about to reset unused", () => {
    const suggestion = recommend("a", "claude-opus-5-5", [
      provider("a", [session(20, 3), weekly(15, 120)]),
      provider("b", [session(5, 3), weekly(35, 10)]),
    ]);
    expect(suggestion).toMatchObject({ kind: "expiring", instanceId: "b" });
    expect(suggestion?.reason).toContain("65% of b's weekly allowance is unused");
  });

  it("does not call an allowance expiring when the current one resets first or it is mostly used", () => {
    expect(
      recommend("a", "claude-opus-5-5", [
        provider("a", [session(20, 3), weekly(30, 5)]),
        provider("b", [session(5, 3), weekly(35, 10)]),
      ]),
    ).toBeNull();
    expect(
      recommend("a", "claude-opus-5-5", [
        provider("a", [session(20, 3), weekly(15, 120)]),
        provider("b", [session(5, 3), weekly(80, 10)]),
      ]),
    ).toBeNull();
  });

  it("stays quiet when the current subscription is fine and nothing is expiring", () => {
    expect(
      recommend("a", "claude-opus-5-5", [
        provider("a", [session(20, 3), weekly(15, 120)]),
        provider("b", [session(5, 3), weekly(10, 100)]),
      ]),
    ).toBeNull();
  });
});
