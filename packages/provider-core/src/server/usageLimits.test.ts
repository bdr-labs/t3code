import { describe, expect, it } from "vite-plus/test";

import { applyUsageLimitsUpdate, resolveUsageLimitsAfterProbe } from "./usageLimits.ts";

const checkedAt = "2026-09-03T12:00:00.000Z";
const session = {
  id: "five_hour",
  kind: "session",
  label: "Session",
  checkedAt,
  usedPercent: 40,
  windowDurationMins: 300,
  resetsAt: "2026-09-03T14:00:00.000Z",
} as const;
const weekly = {
  id: "seven_day",
  kind: "weekly",
  label: "Weekly",
  checkedAt,
  usedPercent: 20,
  windowDurationMins: 10_080,
} as const;
const published = { checkedAt, windows: [session, weekly] };

describe("applyUsageLimitsUpdate", () => {
  it("returns the published object itself when no window or fetch time moved", () => {
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt,
      update: {
        windows: [
          { ...weekly },
          { id: "five_hour", kind: "session", label: "Session", usedPercent: 40 },
        ],
      },
    });
    expect(next).toBe(published);
  });

  it("upserts by id and keeps the reset a percent-only update omits", () => {
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: {
        windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 55 }],
      },
    });
    expect(next).not.toBe(published);
    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55, checkedAt: "2026-09-03T12:00:05.000Z" }, weekly],
    });
  });

  it("leaves an unsupported account and an empty update alone", () => {
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(
      applyUsageLimitsUpdate({ previous: unsupported, checkedAt, update: { windows: [session] } }),
    ).toBe(unsupported);
    expect(
      applyUsageLimitsUpdate({ previous: published, checkedAt, update: { windows: [] } }),
    ).toBe(published);
  });

  it("marks a first sparse update as unavailable", () => {
    expect(
      applyUsageLimitsUpdate({ previous: undefined, checkedAt, update: { windows: [weekly] } }),
    ).toEqual({ checkedAt, windows: [weekly], unavailable: { reason: "probeFailed" } });
  });

  it("preserves reset credits when a streamed window update changes usage", () => {
    const resetCredits = { availableCount: 2, nextExpiresAt: "2026-10-01T00:00:00.000Z" };
    const next = applyUsageLimitsUpdate({
      previous: { ...published, resetCredits },
      checkedAt: "2026-09-03T12:00:05.000Z",
      update: { windows: [{ ...session, checkedAt: "2026-09-03T12:00:05.000Z", usedPercent: 55 }] },
    });

    expect(next).toEqual({
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [{ ...session, usedPercent: 55, checkedAt: "2026-09-03T12:00:05.000Z" }, weekly],
      resetCredits,
    });
  });
});

describe("replaced windows", () => {
  const later = "2026-09-03T12:05:00.000Z";

  it("drops a replaced window the newer reading no longer reports", () => {
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: later,
      update: {
        windows: [{ ...weekly, checkedAt: later, usedPercent: 79 }],
        replaces: ["five_hour", "seven_day"],
      },
    });
    expect(next?.windows.map((window) => [window.id, window.usedPercent])).toEqual([
      ["seven_day", 79],
    ]);
  });

  it("drops it even when the reading reports no window at all", () => {
    const next = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: later,
      update: { windows: [], replaces: ["five_hour"] },
    });
    expect(next?.windows.map((window) => window.id)).toEqual(["seven_day"]);
  });

  it("keeps a window outside replaces and one read after the update", () => {
    const scoped = {
      id: "seven_day_opus",
      kind: "weekly",
      label: "Weekly · Opus",
      checkedAt,
      usedPercent: 5,
    } as const;
    const next = applyUsageLimitsUpdate({
      previous: {
        checkedAt: later,
        windows: [{ ...session, checkedAt: "2026-09-03T12:10:00.000Z" }, weekly, scoped],
      },
      checkedAt: later,
      update: { windows: [{ ...weekly, checkedAt: later }], replaces: ["five_hour", "seven_day"] },
    });
    expect(next?.windows.map((window) => window.id).sort()).toEqual([
      "five_hour",
      "seven_day",
      "seven_day_opus",
    ]);
  });

  it("leaves the snapshot alone when nothing replaced is present", () => {
    const only = { checkedAt, windows: [weekly] };
    expect(
      applyUsageLimitsUpdate({
        previous: only,
        checkedAt: later,
        update: { windows: [], replaces: ["five_hour"] },
      }),
    ).toBe(only);
  });
});

describe("resolveUsageLimitsAfterProbe", () => {
  it("uses read order for windows while taking metadata from the successful probe", () => {
    const live = {
      checkedAt: "2026-09-03T12:00:05.000Z",
      windows: [
        { ...session, usedPercent: 95 },
        { ...weekly, usedPercent: 70 },
      ],
      resetCredits: { availableCount: 2 },
      externalUsage: { label: "Old dashboard", url: "https://example.com/old" },
    };
    const probed = {
      ...published,
      windows: [{ ...session, usedPercent: 0 }],
      resetCredits: { availableCount: 1 },
      externalUsage: { label: "Usage dashboard", url: "https://example.com/usage" },
    };

    expect(resolveUsageLimitsAfterProbe({ published: live, probed })).toEqual({
      ...probed,
      checkedAt: live.checkedAt,
      windows: live.windows,
    });

    const sameTime = { ...probed, checkedAt: live.checkedAt };
    const newer = { ...probed, checkedAt: "2026-09-03T12:00:06.000Z" };
    // Windows merge by id, so the weekly window this probe did not read stays.
    for (const read of [sameTime, newer]) {
      expect(resolveUsageLimitsAfterProbe({ published: live, probed: read })).toEqual({
        ...read,
        windows: [...read.windows, live.windows[1]],
      });
    }
  });

  it("keeps the last good windows through a failed probe but not an unsupported one", () => {
    const failed = { checkedAt, windows: [], unavailable: { reason: "probeFailed" as const } };
    const unsupported = { checkedAt, windows: [], unavailable: { reason: "unsupported" as const } };
    expect(resolveUsageLimitsAfterProbe({ published, probed: failed })).toBe(published);
    expect(resolveUsageLimitsAfterProbe({ published, probed: unsupported })).toBe(unsupported);
    expect(resolveUsageLimitsAfterProbe({ published: undefined, probed: failed })).toBe(failed);
  });

  it("rejects a cached probe whose reset already happened before the account reading", () => {
    const accountCheckedAt = "2026-10-05T21:46:54.000Z";
    const probeCheckedAt = "2026-10-05T21:48:57.000Z";
    const merged = resolveUsageLimitsAfterProbe({
      published: {
        checkedAt: accountCheckedAt,
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            source: "account",
            checkedAt: accountCheckedAt,
            usedPercent: 1,
            resetsAt: "2026-10-06T02:40:00.000Z",
            windowDurationMins: 300,
          },
        ],
      },
      probed: {
        checkedAt: probeCheckedAt,
        windows: [
          {
            id: "five_hour",
            kind: "session",
            label: "Session",
            source: "probe",
            checkedAt: probeCheckedAt,
            usedPercent: 63,
            resetsAt: "2026-10-05T21:40:00.000Z",
            windowDurationMins: 300,
          },
        ],
      },
    });

    expect(merged?.windows).toEqual([
      expect.objectContaining({
        id: "five_hour",
        source: "account",
        usedPercent: 1,
        resetsAt: "2026-10-06T02:40:00.000Z",
      }),
    ]);
  });
});

describe("window fetch times", () => {
  const newer = "2026-09-03T12:01:00.000Z";
  const middle = "2026-09-03T12:00:30.000Z";

  it("rejects a stale probe per window but accepts its newer weekly data", () => {
    const live = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: newer,
      update: {
        windows: [{ id: session.id, kind: session.kind, label: session.label, usedPercent: 60 }],
      },
    });
    const merged = resolveUsageLimitsAfterProbe({
      published: live,
      probed: {
        checkedAt: middle,
        windows: [
          { ...session, checkedAt: middle, usedPercent: 51 },
          { ...weekly, checkedAt: middle, usedPercent: 25 },
        ],
      },
    });
    expect(merged?.checkedAt).toBe(newer);
    expect(merged?.windows).toEqual([
      { ...session, checkedAt: newer, usedPercent: 60 },
      { ...weekly, checkedAt: middle, usedPercent: 25 },
    ]);
  });

  it("rejects old turn events and refreshes timestamps even when numbers stay the same", () => {
    const fresh = applyUsageLimitsUpdate({
      previous: published,
      checkedAt: newer,
      update: {
        windows: [{ id: session.id, kind: session.kind, label: session.label, usedPercent: 40 }],
      },
    });
    expect(fresh?.windows[0]?.checkedAt).toBe(newer);
    expect(fresh?.windows[1]?.checkedAt).toBe(checkedAt);
    expect(
      applyUsageLimitsUpdate({
        previous: fresh,
        checkedAt: middle,
        update: {
          windows: [{ id: session.id, kind: session.kind, label: session.label, usedPercent: 51 }],
        },
      }),
    ).toBe(fresh);
    expect(
      resolveUsageLimitsAfterProbe({
        published: fresh,
        probed: {
          checkedAt: middle,
          windows: [],
          unavailable: { reason: "probeFailed" },
        },
      }),
    ).toBe(fresh);
  });

  it("keeps fresher reset credits when a cached SDK snapshot lands", () => {
    const merged = resolveUsageLimitsAfterProbe({
      published: {
        checkedAt: newer,
        windows: [{ ...session, checkedAt: newer, usedPercent: 60 }],
        resetCredits: { availableCount: 2 },
      },
      probed: { ...published, resetCredits: { availableCount: 1 } },
    });
    expect(merged?.resetCredits?.availableCount).toBe(2);
    expect(merged?.windows[0]?.usedPercent).toBe(60);
  });

  it("never lets a probe replace a recent account or turn reading", () => {
    const newer = "2026-09-03T12:05:00.000Z";
    for (const source of ["account", "turn"] as const) {
      const merged = applyUsageLimitsUpdate({
        previous: {
          checkedAt,
          windows: [{ ...session, source, usedPercent: 8 }],
        },
        checkedAt: newer,
        update: {
          windows: [
            {
              ...session,
              source: "probe",
              checkedAt: newer,
              usedPercent: 63,
            },
          ],
        },
      });
      expect(merged?.windows[0]).toMatchObject({ source, usedPercent: 8 });
    }
  });
});

describe("reset expiry", () => {
  it("zeroes a window after its reset and clears the pending state on a new reading", () => {
    const resetAt = "2026-09-03T12:30:00.000Z";
    const expired = applyUsageLimitsUpdate({
      previous: {
        checkedAt,
        windows: [{ ...session, source: "account", resetsAt: resetAt, usedPercent: 63 }],
      },
      update: { windows: [] },
      checkedAt: "2026-09-03T12:31:00.000Z",
    });
    expect(expired?.windows[0]).toMatchObject({
      usedPercent: 0,
      resetPending: true,
      resetsAt: resetAt,
    });

    const refreshed = applyUsageLimitsUpdate({
      previous: expired,
      update: {
        windows: [
          {
            ...session,
            source: "account",
            checkedAt: "2026-09-03T12:32:00.000Z",
            resetsAt: "2026-09-03T17:30:00.000Z",
            usedPercent: 4,
          },
        ],
      },
      checkedAt: "2026-09-03T12:32:00.000Z",
    });
    expect(refreshed?.windows[0]).toMatchObject({ usedPercent: 4 });
    expect(refreshed?.windows[0]?.resetPending).toBeUndefined();
  });
});

it("records unchanged fetches so delayed events cannot revert newer observations", () => {
  const update = {
    windows: [{ id: session.id, kind: session.kind, label: session.label, usedPercent: 40 }],
  };
  const observed = applyUsageLimitsUpdate({
    previous: published,
    update,
    checkedAt: "2026-09-03T12:00:15.000Z",
  });
  expect(observed?.windows[0]?.checkedAt).toBe("2026-09-03T12:00:15.000Z");
  expect(
    applyUsageLimitsUpdate({
      previous: observed,
      update: { windows: [{ ...update.windows[0]!, usedPercent: 51 }] },
      checkedAt: "2026-09-03T12:00:10.000Z",
    }),
  ).toBe(observed);
});
