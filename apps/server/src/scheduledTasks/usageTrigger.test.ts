import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import {
  ProviderInstanceId,
  type ScheduledTaskSchedule,
  type ScheduledTaskUsageSchedule,
  type ScheduledTaskUsageState,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
} from "@t3tools/contracts";
import {
  applyUsageLimitsUpdate,
  makeUnavailableUsageLimits,
  makeUsageLimits,
  resolveUsageLimitsAfterProbe,
} from "@t3tools/provider-core/server/usageLimits";

import {
  evaluateUsageTrigger,
  usageLimitsForTrigger,
  usageScheduleProblem,
  usageScheduleToSave,
  usageTriggerDueAtMs,
  usageWindowProblem,
} from "./usageTrigger.ts";

const NOW = "2026-09-09T12:00:00.000Z";
const NOW_MS = Date.parse(NOW);
const isoAt = (ms: number) => DateTime.formatIso(DateTime.makeUnsafe(ms));
const at = (offsetMs: number) => isoAt(NOW_MS + offsetMs);
const SECOND = 1_000;
const HOUR = 3_600_000;

const weekly = (over: Partial<ServerProviderUsageWindow> = {}): ServerProviderUsageWindow => ({
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  usedPercent: 50,
  resetsAt: at(HOUR),
  ...over,
});
const limitsOf = (...windows: ServerProviderUsageWindow[]): ServerProviderUsageLimits => ({
  checkedAt: NOW,
  windows,
});
const line = (
  on: "above" | "below",
  usedPercent: number,
  armed?: boolean,
): ScheduledTaskUsageSchedule => ({
  type: "usage",
  window: "weekly",
  on,
  usedPercent,
  ...(armed === undefined ? {} : { state: { armed } }),
});
const renews = (state?: ScheduledTaskUsageState): ScheduledTaskUsageSchedule => ({
  type: "usage",
  window: "weekly",
  on: "reset",
  ...(state === undefined ? {} : { state }),
});

const aboveState = (armed: boolean) => ({ armed, resetsAt: at(HOUR) });

describe("a usage line", () => {
  it.each([
    ["no state, short of the line: armed", line("above", 80), 50, false, aboveState(true)],
    ["no state, created past the line: no fire", line("above", 80), 85, false, aboveState(false)],
    ["armed, reaches the line: fires", line("above", 80, true), 80, true, aboveState(false)],
    ["armed, short of the line: waits", line("above", 80, true), 79, false, aboveState(true)],
    [
      "not armed, the fired prompt's own usage: no second fire",
      line("above", 80, false),
      95,
      false,
      aboveState(false),
    ],
    [
      "not armed, back under inside the margin: stays spent",
      line("above", 80, false),
      79,
      false,
      aboveState(false),
    ],
    [
      "not armed, 5 points back under: rearms",
      line("above", 80, false),
      75,
      false,
      aboveState(true),
    ],
    ["no state, already below: no fire", line("below", 20), 5, false, { armed: false }],
    ["armed, falls under: fires", line("below", 20, true), 19, true, { armed: false }],
    ["armed, on the line is not below", line("below", 20, true), 20, false, { armed: true }],
    [
      "not armed, back over inside the margin: stays spent",
      line("below", 20, false),
      20,
      false,
      { armed: false },
    ],
    ["not armed, 5 points back over: rearms", line("below", 20, false), 25, false, { armed: true }],
  ])("%s", (_name, schedule, usedPercent, fire, state) => {
    expect(
      evaluateUsageTrigger({
        schedule,
        limits: limitsOf(weekly({ usedPercent })),
        nowMs: NOW_MS,
      }),
    ).toEqual({ fire, state });
  });

  it.each<[string, ScheduledTaskUsageSchedule, ReadonlyArray<number>, number]>([
    ["`above 80` over 81, 79, 81: once", line("above", 80, true), [81, 79, 81], 1],
    ["`above 80` over 81, 76, 81: once", line("above", 80, true), [81, 76, 81], 1],
    ["`above 80` over 81, 75, 81: twice", line("above", 80, true), [81, 75, 81], 2],
    ["`below 20` over 19, 21, 19: once", line("below", 20, true), [19, 21, 19], 1],
    ["`below 20` over 19, 24, 19: once", line("below", 20, true), [19, 24, 19], 1],
    ["`below 20` over 19, 25, 19: twice", line("below", 20, true), [19, 25, 19], 2],
    ["made at 78, the first crossing has no margin", line("above", 80), [78, 80], 1],
    ["made at 21, the first crossing has no margin", line("below", 20), [21, 19], 1],
    ["made at 81, 79 does not arm it", line("above", 80), [81, 79, 80], 0],
    ["made at 81, it needs 75 and then 80", line("above", 80), [81, 75, 80], 1],
    ["made at 19, 24 does not arm it", line("below", 20), [19, 24, 19], 0],
    ["made at 19, it needs 25 and then under", line("below", 20), [19, 25, 19], 1],
    ["`above 3` does not rearm at 1", line("above", 3, true), [3, 1, 3], 1],
    ["`above 3` rearms at 0", line("above", 3, true), [3, 0, 3], 2],
    ["`below 97` does not rearm at 99", line("below", 97, true), [96, 99, 96], 1],
    ["`below 97` rearms at 100", line("below", 97, true), [96, 100, 96], 2],
  ])("%s", (_name, schedule, readings, fires) => {
    let current = schedule;
    let fired = 0;
    for (const usedPercent of readings) {
      const result = evaluateUsageTrigger({
        schedule: current,
        limits: limitsOf(weekly({ usedPercent })),
        nowMs: NOW_MS,
      });
      if (result.fire) fired += 1;
      current = { ...schedule, state: result.state! };
    }
    expect(fired).toBe(fires);
  });

  it.each<
    [
      string,
      ScheduledTaskUsageSchedule,
      Partial<ServerProviderUsageWindow>,
      boolean,
      ScheduledTaskUsageState,
    ]
  >([
    [
      "a fired `above` whose reset has passed, still over the line in the new period: fires again",
      { ...line("above", 80), state: { armed: false, resetsAt: at(-HOUR) } },
      { usedPercent: 85 },
      true,
      aboveState(false),
    ],
    [
      "under the line in the new period: rearms, and waits",
      { ...line("above", 80), state: { armed: false, resetsAt: at(-HOUR) } },
      { usedPercent: 5 },
      false,
      aboveState(true),
    ],
    [
      "back under the line by less than the margin in the new period: rearms all the same",
      { ...line("above", 80), state: { armed: false, resetsAt: at(-HOUR) } },
      { usedPercent: 79 },
      false,
      aboveState(true),
    ],
    [
      "its reset still ahead, moved later: no new period",
      { ...line("above", 80), state: { armed: false, resetsAt: at(30 * 60 * SECOND) } },
      { usedPercent: 85 },
      false,
      aboveState(false),
    ],
    [
      "jitter on a reset just passed: no new period",
      { ...line("above", 80), state: { armed: false, resetsAt: at(-SECOND) } },
      { usedPercent: 85, resetsAt: at(30 * SECOND) },
      false,
      { armed: false, resetsAt: at(30 * SECOND) },
    ],
    [
      "`below` is not started over by a reset: an idle window would fire every period",
      line("below", 20, false),
      { usedPercent: 5 },
      false,
      { armed: false },
    ],
    [
      "`below` has no new period, so inside the margin it stays spent across a reset",
      line("below", 20, false),
      { usedPercent: 22, resetsAt: at(6 * HOUR) },
      false,
      { armed: false },
    ],
  ])("%s", (_name, schedule, reading, fire, state) => {
    expect(
      evaluateUsageTrigger({ schedule, limits: limitsOf(weekly(reading)), nowMs: NOW_MS }),
    ).toEqual({ fire, state });
  });

  it.each([
    ["below", line("below", 20, true)],
    ["above", line("above", 20, true)],
    ["no state yet", line("below", 20)],
    ["`above` not armed, where 0 would rearm", line("above", 20, false)],
  ])("%s: the placeholder 0 of a passed reset fires nothing", (_name, schedule) => {
    // What the registry really publishes once the reset has passed.
    const limits = makeUsageLimits({
      checkedAt: NOW,
      windows: [weekly({ usedPercent: 90, resetsAt: at(-SECOND) })],
    });
    expect(limits.windows[0]).toMatchObject({ usedPercent: 0, resetPending: true });
    expect(evaluateUsageTrigger({ schedule, limits, nowMs: NOW_MS })).toEqual({
      fire: false,
      state: schedule.state,
    });
  });

  it.each([
    ["below", line("below", 20, true), 5],
    ["above", line("above", 20, true), 90],
    ["`above` not armed, where 5 would rearm", line("above", 20, false), 5],
    ["`below` not armed, where 90 would rearm", line("below", 20, false), 90],
  ])(
    "%s: a percent from before a reset that has passed fires nothing",
    (_name, schedule, usedPercent) => {
      expect(
        evaluateUsageTrigger({
          schedule,
          limits: limitsOf(weekly({ usedPercent, resetsAt: at(-SECOND) })),
          nowMs: NOW_MS,
        }),
      ).toEqual({ fire: false, state: schedule.state });
    },
  );
});

describe("no reading means nothing happens", () => {
  it.each([
    ["armed line", line("above", 80, true)],
    ["recorded reset", renews({ resetsAt: at(-HOUR), usedPercent: 80 })],
    ["no state", renews()],
  ])("%s", (_name, schedule) => {
    const unchanged = { fire: false, state: schedule.state };
    const evaluate = (limits: ServerProviderUsageLimits | undefined) =>
      evaluateUsageTrigger({ schedule, limits, nowMs: NOW_MS });

    expect(evaluate(undefined)).toEqual(unchanged);
    expect(
      evaluate({
        ...limitsOf(weekly({ usedPercent: 99 })),
        unavailable: { reason: "probeFailed" },
      }),
    ).toEqual(unchanged);
    expect(
      evaluate(limitsOf({ ...weekly({ usedPercent: 99 }), id: "five_hour", kind: "session" })),
    ).toEqual(unchanged);
  });

  it("a failed probe keeps the last reading, as the registry publishes it, so nothing crosses", () => {
    const published = makeUsageLimits({ checkedAt: NOW, windows: [weekly({ usedPercent: 50 })] });
    const limits = resolveUsageLimitsAfterProbe({
      published,
      probed: makeUnavailableUsageLimits({
        checkedAt: at(5 * SECOND),
        reason: "probeFailed",
      }),
    });
    expect(limits?.windows[0]?.usedPercent).toBe(50);
    expect(
      evaluateUsageTrigger({ schedule: line("above", 80, true), limits, nowMs: NOW_MS }),
    ).toEqual({ fire: false, state: aboveState(true) });
  });

  const provider = (over: Partial<ServerProvider> = {}) =>
    ({
      enabled: true,
      installed: true,
      auth: { status: "authenticated" },
      usageLimits: limitsOf(weekly()),
      ...over,
    }) as ServerProvider;

  it.each([
    ["a removed instance", undefined],
    [
      "a signed-out provider, which keeps its last windows",
      provider({ auth: { status: "unauthenticated" } }),
    ],
    ["a disabled provider", provider({ enabled: false })],
    ["an uninstalled provider", provider({ installed: false })],
  ])("%s has no limits to read", (_name, candidate) => {
    expect(usageLimitsForTrigger(candidate)).toBeUndefined();
  });

  it("a usable provider gives its limits", () => {
    const usable = provider();
    expect(usageLimitsForTrigger(usable)).toBe(usable.usageLimits);
    expect(usageLimitsForTrigger(provider({ auth: { status: "unknown" } }))).toEqual(
      usable.usageLimits,
    );
  });
});

describe("naming a window", () => {
  const model = weekly({ id: "seven_day_opus", label: "Weekly · Opus", usedPercent: 99 });
  const account = weekly({ usedPercent: 10 });

  it("a kind means that kind's first in the sorted order, not a model's", () => {
    expect(
      evaluateUsageTrigger({
        schedule: line("above", 80, true),
        limits: limitsOf(model, account),
        nowMs: NOW_MS,
      }).fire,
    ).toBe(false);
  });

  it("an id means that window", () => {
    expect(
      evaluateUsageTrigger({
        schedule: { ...line("above", 80, true), window: "seven_day_opus" },
        limits: limitsOf(account, model),
        nowMs: NOW_MS,
      }).fire,
    ).toBe(true);
  });
});

describe("a usage reset", () => {
  const T = at(HOUR);
  const T_MS = NOW_MS + HOUR;
  const NEXT = at(6 * HOUR);
  const recorded = (over: ScheduledTaskUsageState = {}) => ({
    resetsAt: T,
    usedPercent: 80,
    ...over,
  });

  it.each<
    [
      string,
      ScheduledTaskUsageState | undefined,
      Partial<ServerProviderUsageWindow>,
      number,
      boolean,
      ScheduledTaskUsageState | undefined,
    ]
  >([
    ["no state: records", undefined, {}, NOW_MS, false, { resetsAt: T, usedPercent: 50 }],
    [
      "no state and no reset time: records",
      undefined,
      { resetsAt: undefined },
      NOW_MS,
      false,
      { resetsAt: null, usedPercent: 50 },
    ],
    [
      "no state, the reset already passed: it was not this task's to see",
      undefined,
      { resetsAt: at(-HOUR) },
      NOW_MS,
      false,
      { resetsAt: at(-HOUR), usedPercent: 50, firedFor: at(-HOUR) },
    ],
    [
      "under a minute old: holds",
      recorded(),
      { resetsAt: T, usedPercent: 80 },
      T_MS + 59 * SECOND,
      false,
      recorded(),
    ],
    [
      "a minute old: fires",
      recorded(),
      { resetsAt: T, usedPercent: 80 },
      T_MS + 60 * SECOND,
      true,
      recorded({ firedFor: T }),
    ],
    [
      "a minute old at 1%: fires, a renewal has no margin",
      recorded({ usedPercent: 1 }),
      { resetsAt: T, usedPercent: 1 },
      T_MS + 60 * SECOND,
      true,
      recorded({ usedPercent: 1, firedFor: T }),
    ],
    [
      "already fired, same reading: nothing",
      recorded({ firedFor: T }),
      { resetsAt: T, usedPercent: 80 },
      T_MS + HOUR,
      false,
      recorded({ firedFor: T }),
    ],
    [
      "already fired, the new period's first reading: no second fire",
      recorded({ firedFor: T }),
      { resetsAt: NEXT, usedPercent: 2 },
      T_MS + 70 * SECOND,
      false,
      { resetsAt: NEXT, usedPercent: 2, firedFor: T },
    ],
    [
      "already fired, jitter around the old reset: no second fire",
      recorded({ firedFor: T }),
      { resetsAt: isoAt(T_MS + 3 * SECOND), usedPercent: 0 },
      T_MS + 70 * SECOND,
      false,
      {
        resetsAt: isoAt(T_MS + 3 * SECOND),
        usedPercent: 0,
        firedFor: T,
      },
    ],
    [
      "jitter ahead of the reset: records",
      recorded(),
      { resetsAt: isoAt(T_MS + 5 * SECOND), usedPercent: 80 },
      NOW_MS,
      false,
      { resetsAt: isoAt(T_MS + 5 * SECOND), usedPercent: 80 },
    ],
    [
      "jitter while usage ages out: no reset",
      recorded(),
      { resetsAt: isoAt(T_MS + 5 * SECOND), usedPercent: 70 },
      NOW_MS,
      false,
      { resetsAt: isoAt(T_MS + 5 * SECOND), usedPercent: 70 },
    ],
    [
      "a later reset with usage level: no reset",
      recorded(),
      { resetsAt: NEXT, usedPercent: 80 },
      NOW_MS,
      false,
      { resetsAt: NEXT, usedPercent: 80 },
    ],
    [
      "a later reset with usage rising: no reset",
      recorded(),
      { resetsAt: NEXT, usedPercent: 85 },
      NOW_MS,
      false,
      { resetsAt: NEXT, usedPercent: 85 },
    ],
    [
      "a later reset, usage down by under five: no reset",
      recorded(),
      { resetsAt: NEXT, usedPercent: 75.5 },
      NOW_MS,
      false,
      { resetsAt: NEXT, usedPercent: 75.5 },
    ],
    [
      "a later reset, usage down by five: an early reset credit",
      recorded(),
      { resetsAt: NEXT, usedPercent: 75 },
      NOW_MS,
      true,
      { resetsAt: NEXT, usedPercent: 75, firedFor: T },
    ],
    [
      "a reset kept by the merge, usage now 0: an early reset credit, and that reset is spent",
      recorded(),
      { resetsAt: T, usedPercent: 0 },
      NOW_MS,
      true,
      { resetsAt: T, usedPercent: 0, firedFor: T },
    ],
    [
      "no reset time, usage down by five: an early reset credit, and that reset is spent",
      recorded(),
      { resetsAt: undefined, usedPercent: 75 },
      NOW_MS,
      true,
      { resetsAt: null, usedPercent: 75, firedFor: T },
    ],
    [
      "no reset time, usage down by under five: no reset",
      recorded({ usedPercent: 3 }),
      { resetsAt: undefined, usedPercent: 0 },
      NOW_MS,
      false,
      { resetsAt: null, usedPercent: 0 },
    ],
    [
      "usage now 0, but down by under five: no reset",
      recorded({ usedPercent: 3 }),
      { resetsAt: T, usedPercent: 0 },
      NOW_MS,
      false,
      recorded({ usedPercent: 0 }),
    ],
    [
      "usage now 0 on a reset older than the recorded one: a stale reading, no reset",
      recorded(),
      { resetsAt: at(-HOUR), usedPercent: 0 },
      NOW_MS,
      false,
      recorded(),
    ],
    [
      "a window idle at 0 when its reset passes: nothing renewed, and that reset is spent",
      recorded({ usedPercent: 0 }),
      { resetsAt: T, usedPercent: 0 },
      T_MS + 60 * SECOND,
      false,
      recorded({ usedPercent: 0, firedFor: T }),
    ],
    [
      "a quiet window renews inside the hold: it still waits for the fire",
      recorded({ usedPercent: 1 }),
      { resetsAt: NEXT, usedPercent: 0 },
      T_MS + 10 * SECOND,
      false,
      recorded({ usedPercent: 1 }),
    ],
    [
      "a quiet window, a minute after: fires, once",
      recorded({ usedPercent: 1 }),
      { resetsAt: NEXT, usedPercent: 0 },
      T_MS + 60 * SECOND,
      true,
      { resetsAt: NEXT, usedPercent: 0, firedFor: T },
    ],
    [
      "days late, after downtime: fires once for what it recorded",
      recorded(),
      { resetsAt: NEXT, usedPercent: 3 },
      T_MS + 72 * HOUR,
      true,
      { resetsAt: NEXT, usedPercent: 3, firedFor: T },
    ],
    [
      "no reset time, ever: never fires",
      { resetsAt: null, usedPercent: 40 },
      { resetsAt: undefined, usedPercent: 2 },
      T_MS + 72 * HOUR,
      false,
      { resetsAt: null, usedPercent: 2 },
    ],
  ])("%s", (_name, state, reading, nowMs, fire, next) => {
    expect(
      evaluateUsageTrigger({
        schedule: renews(state),
        limits: limitsOf(weekly(reading)),
        nowMs,
      }),
    ).toEqual({ fire, state: next });
  });

  it("an unchanged reading is the same state, so the sweep writes nothing", () => {
    const state = recorded();
    expect(
      evaluateUsageTrigger({
        schedule: renews(state),
        limits: limitsOf(weekly({ resetsAt: T, usedPercent: 80 })),
        nowMs: NOW_MS,
      }).state,
    ).toBe(state);
  });

  it("the same for a line, so a steady reading writes nothing", () => {
    const state = aboveState(true);
    expect(
      evaluateUsageTrigger({
        schedule: { ...line("above", 80), state },
        limits: limitsOf(weekly({ usedPercent: 50 })),
        nowMs: NOW_MS,
      }).state,
    ).toBe(state);
  });

  it("the sweep comes back a minute after a reset that has yet to fire, and for nothing else", () => {
    expect(usageTriggerDueAtMs(renews(recorded()), NOW_MS)).toBe(T_MS + 60 * SECOND);
    expect(usageTriggerDueAtMs(renews(recorded({ firedFor: T })), NOW_MS)).toBe(Infinity);
    expect(usageTriggerDueAtMs(renews({ resetsAt: null, usedPercent: 0 }), NOW_MS)).toBe(Infinity);
    expect(usageTriggerDueAtMs(renews(), NOW_MS)).toBe(Infinity);
    expect(usageTriggerDueAtMs(line("above", 80, true), NOW_MS)).toBe(Infinity);
    // Past its minute and still unfired means no reading: the next one invalidates the hint.
    expect(usageTriggerDueAtMs(renews(recorded()), T_MS + 61 * SECOND)).toBe(Infinity);
  });

  describe("while a renewal is owed", () => {
    const OWED = at(-HOUR);

    it.each<
      [
        string,
        ScheduledTaskUsageState,
        Partial<ServerProviderUsageWindow>,
        number,
        boolean,
        ScheduledTaskUsageState,
      ]
    >([
      [
        "a later renewal fires again with its own firedFor, and stays the one owed fire",
        recorded({ firedFor: at(-2 * HOUR), owedSince: OWED }),
        { resetsAt: T, usedPercent: 80 },
        T_MS + 60 * SECOND,
        true,
        recorded({ firedFor: T, owedSince: OWED }),
      ],
      [
        "the new period's first reading is recorded, still owed",
        recorded({ firedFor: T, owedSince: OWED }),
        { resetsAt: NEXT, usedPercent: 2 },
        T_MS + 70 * SECOND,
        false,
        { resetsAt: NEXT, usedPercent: 2, firedFor: T, owedSince: OWED },
      ],
      [
        "an early reset credit, still owed",
        recorded({ owedSince: OWED }),
        { resetsAt: NEXT, usedPercent: 75 },
        NOW_MS,
        true,
        { resetsAt: NEXT, usedPercent: 75, firedFor: T, owedSince: OWED },
      ],
    ])("%s", (_name, state, reading, nowMs, fire, next) => {
      expect(
        evaluateUsageTrigger({
          schedule: renews(state),
          limits: limitsOf(weekly(reading)),
          nowMs,
        }),
      ).toEqual({ fire, state: next });
    });

    it("an unchanged reading or none at all is the same state, so a re-check writes nothing", () => {
      const state = recorded({ firedFor: T, owedSince: OWED });
      for (const limits of [limitsOf(weekly({ resetsAt: T, usedPercent: 80 })), undefined]) {
        expect(
          evaluateUsageTrigger({ schedule: renews(state), limits, nowMs: T_MS + HOUR }).state,
        ).toBe(state);
      }
    });

    it("the sweep looks again within a minute, or at a reset due sooner", () => {
      expect(usageTriggerDueAtMs(renews(recorded({ firedFor: T, owedSince: OWED })), NOW_MS)).toBe(
        NOW_MS + 60 * SECOND,
      );
      const unfired = renews(recorded({ firedFor: at(-2 * HOUR), owedSince: OWED }));
      expect(usageTriggerDueAtMs(unfired, T_MS + 30 * SECOND)).toBe(T_MS + 60 * SECOND);
    });
  });
});

describe("through the registry's real merge", () => {
  const T = at(HOUR);
  const T_MS = NOW_MS + HOUR;
  const LATER = T_MS + 10 * 60 * SECOND;
  const NEXT = at(6 * HOUR);
  const usedBeforeTheReset = (usedPercent: number) =>
    makeUsageLimits({ checkedAt: NOW, windows: [weekly({ usedPercent, resetsAt: T })] });
  // How Claude reads an idle window: no usage and no reset time.
  const idleReading = (checkedAtMs: number) => {
    const { resetsAt: _resetsAt, ...idle } = weekly({ usedPercent: 0 });
    return makeUsageLimits({ checkedAt: isoAt(checkedAtMs), windows: [idle] });
  };
  const failedProbe = (checkedAtMs: number) =>
    makeUnavailableUsageLimits({ checkedAt: isoAt(checkedAtMs), reason: "probeFailed" });

  describe("`below` on a window that went idle", () => {
    const armed = line("below", 20, true);

    it("fires once, on the first real reading after the reset", () => {
      const limits = resolveUsageLimitsAfterProbe({
        published: usedBeforeTheReset(85),
        probed: idleReading(LATER),
      });
      // The merge keeps the old reset, so this stays pending though the reading is fresh.
      expect(limits?.windows[0]).toMatchObject({
        usedPercent: 0,
        resetPending: true,
        resetsAt: T,
        checkedAt: isoAt(LATER),
      });
      const fired = evaluateUsageTrigger({ schedule: armed, limits, nowMs: LATER });
      expect(fired).toEqual({ fire: true, state: { armed: false } });

      const again = resolveUsageLimitsAfterProbe({
        published: limits,
        probed: idleReading(LATER + HOUR),
      });
      expect(
        evaluateUsageTrigger({
          schedule: { ...armed, state: fired.state! },
          limits: again,
          nowMs: LATER + HOUR,
        }),
      ).toEqual({ fire: false, state: { armed: false } });
    });

    it("fires nothing on a failed probe, whose windows are the placeholder", () => {
      const limits = resolveUsageLimitsAfterProbe({
        published: usedBeforeTheReset(85),
        probed: failedProbe(LATER),
      });
      expect(limits?.windows[0]).toMatchObject({ usedPercent: 0, resetPending: true });
      expect(evaluateUsageTrigger({ schedule: armed, limits, nowMs: LATER })).toEqual({
        fire: false,
        state: { armed: true },
      });
    });

    it("fires nothing on the old reading once the reset has passed", () => {
      expect(
        evaluateUsageTrigger({ schedule: armed, limits: usedBeforeTheReset(5), nowMs: LATER }),
      ).toEqual({ fire: false, state: { armed: true } });
    });

    it("rearms `above` on the same reading, so the next rise can fire", () => {
      const limits = resolveUsageLimitsAfterProbe({
        published: usedBeforeTheReset(85),
        probed: idleReading(LATER),
      });
      expect(
        evaluateUsageTrigger({ schedule: line("above", 80, false), limits, nowMs: LATER }),
      ).toEqual({ fire: false, state: { armed: true, resetsAt: T } });
    });
  });

  it("`above` fires again when the new period's first reading is still over the line", () => {
    const published = usedBeforeTheReset(90);
    const fired = evaluateUsageTrigger({
      schedule: line("above", 80, true),
      limits: published,
      nowMs: NOW_MS,
    });
    expect(fired).toEqual({ fire: true, state: { armed: false, resetsAt: T } });
    const spent = { ...line("above", 80), state: fired.state! };

    // A failed probe after the reset is only the placeholder.
    const placeholder = resolveUsageLimitsAfterProbe({ published, probed: failedProbe(LATER) });
    expect(evaluateUsageTrigger({ schedule: spent, limits: placeholder, nowMs: LATER })).toEqual({
      fire: false,
      state: fired.state,
    });

    const limits = resolveUsageLimitsAfterProbe({
      published,
      probed: makeUsageLimits({
        checkedAt: isoAt(LATER),
        windows: [weekly({ usedPercent: 85, resetsAt: NEXT })],
      }),
    });
    const again = evaluateUsageTrigger({ schedule: spent, limits, nowMs: LATER });
    expect(again).toEqual({ fire: true, state: { armed: false, resetsAt: NEXT } });
    expect(
      evaluateUsageTrigger({
        schedule: { ...line("above", 80), state: again.state! },
        limits,
        nowMs: LATER + HOUR,
      }),
    ).toEqual({ fire: false, state: again.state });
  });

  it("a stale probe keeps the recorded reset, which fires by the clock with no good reading", () => {
    const seen = renews({ resetsAt: T, usedPercent: 60 });
    const stale = resolveUsageLimitsAfterProbe({
      published: undefined,
      probed: makeUsageLimits({
        checkedAt: NOW,
        windows: [weekly({ usedPercent: 60, resetsAt: at(-HOUR) })],
      }),
    });
    const after = evaluateUsageTrigger({ schedule: seen, limits: stale, nowMs: NOW_MS });
    expect(after.fire).toBe(false);
    expect(after.state).toEqual(seen.state);
    expect(
      evaluateUsageTrigger({ schedule: seen, limits: stale, nowMs: T_MS + 60 * SECOND }).fire,
    ).toBe(true);
  });

  it("a stale probe after a restart is no reset, and the real renewal still fires once", () => {
    const seen = renews({ resetsAt: T, usedPercent: 60 });
    // No published limits after a restart, and the probe names a reset already past.
    const stale = resolveUsageLimitsAfterProbe({
      published: undefined,
      probed: makeUsageLimits({
        checkedAt: NOW,
        windows: [weekly({ usedPercent: 60, resetsAt: at(-HOUR) })],
      }),
    });
    expect(stale?.windows[0]).toMatchObject({
      usedPercent: 0,
      resetPending: true,
      resetsAt: at(-HOUR),
    });
    const after = evaluateUsageTrigger({ schedule: seen, limits: stale, nowMs: NOW_MS });
    expect(after.fire).toBe(false);

    const real = limitsOf(weekly({ usedPercent: 60, resetsAt: T }));
    const read = evaluateUsageTrigger({
      schedule: renews(after.state),
      limits: real,
      nowMs: NOW_MS + 60 * SECOND,
    });
    expect(read.fire).toBe(false);
    const renewed = evaluateUsageTrigger({
      schedule: renews(read.state),
      limits: real,
      nowMs: T_MS + 60 * SECOND,
    });
    expect(renewed.fire).toBe(true);
    expect(
      evaluateUsageTrigger({
        schedule: renews(renewed.state),
        limits: real,
        nowMs: T_MS + HOUR,
      }).fire,
    ).toBe(false);
  });

  describe("`reset` on an early reset that reads `0, null`", () => {
    const seen = renews({ resetsAt: T, usedPercent: 80 });

    it("fires once with the old reset kept, then only for the period after it", () => {
      const limits = resolveUsageLimitsAfterProbe({
        published: usedBeforeTheReset(80),
        probed: idleReading(NOW_MS + 60 * SECOND),
      });
      expect(limits?.windows[0]).toMatchObject({ usedPercent: 0, resetsAt: T });
      const credited = evaluateUsageTrigger({
        schedule: seen,
        limits,
        nowMs: NOW_MS + 60 * SECOND,
      });
      expect(credited).toEqual({
        fire: true,
        state: { resetsAt: T, usedPercent: 0, firedFor: T },
      });

      const after = renews(credited.state);
      expect(usageTriggerDueAtMs(after, NOW_MS + 60 * SECOND)).toBe(Infinity);
      expect(evaluateUsageTrigger({ schedule: after, limits, nowMs: T_MS + HOUR })).toEqual({
        fire: false,
        state: credited.state,
      });

      // Work restarts: a rise is no reset, and the new period's own reset fires as usual.
      const working = evaluateUsageTrigger({
        schedule: after,
        limits: limitsOf(weekly({ usedPercent: 30, resetsAt: NEXT })),
        nowMs: NOW_MS + 120 * SECOND,
      });
      expect(working).toEqual({
        fire: false,
        state: { resetsAt: NEXT, usedPercent: 30, firedFor: T },
      });
      expect(
        evaluateUsageTrigger({
          schedule: renews(working.state),
          limits: limitsOf(weekly({ usedPercent: 30, resetsAt: NEXT })),
          nowMs: NOW_MS + 6 * HOUR + 60 * SECOND,
        }).fire,
      ).toBe(true);
    });

    it("fires once after a restart, when the null reading has no old reset to keep", () => {
      const limits = resolveUsageLimitsAfterProbe({
        published: undefined,
        probed: idleReading(NOW_MS + 60 * SECOND),
      });
      expect(limits?.windows[0]?.resetsAt).toBeUndefined();
      const credited = evaluateUsageTrigger({
        schedule: seen,
        limits,
        nowMs: NOW_MS + 60 * SECOND,
      });
      expect(credited).toEqual({
        fire: true,
        state: { resetsAt: null, usedPercent: 0, firedFor: T },
      });
      expect(
        evaluateUsageTrigger({ schedule: renews(credited.state), limits, nowMs: T_MS + HOUR }),
      ).toEqual({ fire: false, state: credited.state });
    });
  });

  it("a state recorded at 0 with readings stopped sends nothing when its reset passes", () => {
    const limits = usedBeforeTheReset(0);
    const recorded = evaluateUsageTrigger({ schedule: renews(), limits, nowMs: NOW_MS });
    expect(recorded.state).toEqual({ resetsAt: T, usedPercent: 0 });
    expect(
      evaluateUsageTrigger({
        schedule: renews(recorded.state),
        limits,
        nowMs: T_MS + 60 * SECOND,
      }),
    ).toEqual({ fire: false, state: { resetsAt: T, usedPercent: 0, firedFor: T } });
  });
});

describe("naming a window that is not there", () => {
  const five_hour = { ...weekly(), id: "five_hour", kind: "session" as const, label: "Session" };
  const limits = limitsOf(weekly(), five_hour);

  it("lists the instance's ids and kinds", () => {
    const problem = usageWindowProblem({ window: "weekyl" }, "codex", limits);
    expect(problem).toContain("weekyl");
    expect(problem).toContain("codex");
    for (const name of ["seven_day", "weekly", "five_hour", "session"]) {
      expect(problem).toContain(name);
    }
  });

  it.each([
    ["an id", "seven_day"],
    ["a kind", "weekly"],
  ])("accepts %s it reports", (_name, window) => {
    expect(usageWindowProblem({ window }, "codex", limits)).toBeNull();
  });

  it("accepts anything on an instance with no readings yet", () => {
    expect(usageWindowProblem({ window: "weekly" }, "codex", undefined)).toBeNull();
    expect(usageWindowProblem({ window: "weekly" }, "codex", limitsOf())).toBeNull();
  });

  it("refuses an instance that reports no usage at all, with the reason", () => {
    const unsupported = makeUnavailableUsageLimits({ checkedAt: NOW, reason: "unsupported" });
    expect(usageWindowProblem({ window: "weekly" }, "opencode", unsupported)).toMatch(
      /reports no usage windows/,
    );
  });

  it("skips the check on any other unavailable, which the evaluator reads as no reading", () => {
    // A failed probe plus one turn event: `probeFailed`, and only the window that event named.
    const partial = applyUsageLimitsUpdate({
      previous: undefined,
      update: { windows: [five_hour] },
      checkedAt: NOW,
    });
    expect(partial?.unavailable?.reason).toBe("probeFailed");
    expect(partial?.windows.map((window) => window.id)).toEqual(["five_hour"]);
    expect(usageWindowProblem({ window: "weekly" }, "codex", partial)).toBeNull();
  });
});

describe("saving a usage trigger", () => {
  const codex = ProviderInstanceId.make("codex");
  const claude = ProviderInstanceId.make("claude");
  const state = { armed: false };
  const stored = (over: Partial<ScheduledTaskUsageSchedule> = {}): ScheduledTaskUsageSchedule => ({
    ...line("above", 80),
    state,
    ...over,
  });
  const save = (
    schedule: ScheduledTaskUsageSchedule,
    existing: {
      readonly enabled?: boolean;
      readonly schedule: ScheduledTaskSchedule;
      readonly instanceId?: ProviderInstanceId;
    } | null = { schedule: stored() },
    over: { readonly enabled?: boolean; readonly instanceId?: ProviderInstanceId } = {},
  ) =>
    usageScheduleToSave({
      schedule,
      enabled: over.enabled ?? true,
      modelInstanceId: over.instanceId ?? codex,
      existing:
        existing === null
          ? null
          : {
              enabled: existing.enabled ?? true,
              schedule: existing.schedule,
              modelSelection: { instanceId: existing.instanceId ?? codex },
            },
    });

  it("an edit that keeps the trigger keeps the state", () => {
    expect(save(line("above", 80))).toEqual({ ...line("above", 80), state });
    expect(
      save(line("above", 80), { enabled: false, schedule: stored() }, { enabled: false }),
    ).toEqual({ ...line("above", 80), state });
  });

  it.each([
    ["window", { ...line("above", 80), window: "session" }],
    ["on", line("below", 80)],
    ["usedPercent", line("above", 70)],
    ["instanceId", { ...line("above", 80), instanceId: claude }],
  ])("a changed %s clears it", (_field, schedule) => {
    expect(save(schedule)).toEqual(schedule);
  });

  it("re-enabling through an edit clears it, so a crossing while paused does not fire", () => {
    expect(save(line("above", 80), { enabled: false, schedule: stored() })).toEqual(
      line("above", 80),
    );
  });

  it("a default instance that moves with the task's model clears it", () => {
    expect(save(line("above", 80), { schedule: stored() }, { instanceId: claude })).toEqual(
      line("above", 80),
    );
    // Named the same instance either way, the state still describes that instance's window.
    const named = { ...line("above", 80), instanceId: claude };
    expect(
      save(named, { schedule: { ...stored(), instanceId: claude } }, { instanceId: codex }),
    ).toEqual({ ...named, state });
  });

  it("a new task or one that was another kind has none", () => {
    expect(save(line("above", 80), null)).toEqual(line("above", 80));
    expect(save(line("above", 80), { schedule: { type: "interval", everyMs: 60_000 } })).toEqual(
      line("above", 80),
    );
  });

  it("a state that came with the save is dropped, whatever it says", () => {
    const smuggled = { ...line("above", 80), state: { armed: true } };
    expect(save(smuggled, null)).toEqual(line("above", 80));
    expect(save(smuggled)).toEqual({ ...line("above", 80), state });
    expect(save({ ...smuggled, on: "below" })).toEqual(line("below", 80));
  });

  it("stores the fields in one order, so a kept trigger compares equal as text", () => {
    const shuffled = {
      usedPercent: 80,
      on: "above",
      window: "weekly",
      instanceId: codex,
      type: "usage",
    } as const;
    expect(JSON.stringify(save(shuffled, null))).toBe(
      JSON.stringify({
        type: "usage",
        instanceId: codex,
        window: "weekly",
        on: "above",
        usedPercent: 80,
      }),
    );
  });

  it("says what is wrong with a percent", () => {
    expect(usageScheduleProblem(line("above", 80))).toBeNull();
    expect(usageScheduleProblem(renews())).toBeNull();
    expect(usageScheduleProblem({ on: "above" })).toMatch(/usedPercent/);
    expect(usageScheduleProblem({ on: "below" })).toMatch(/usedPercent/);
    expect(usageScheduleProblem({ ...renews(), usedPercent: 50 })).toMatch(/usedPercent/);
  });
});
