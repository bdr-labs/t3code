import {
  NodeId,
  ProviderDriverKind,
  ThreadId,
  TurnItemId,
  type OrchestrationV2TurnItem,
  ProviderThreadId,
  ProviderTurnId,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  composerLimitDisplay,
  composerLimitsFreshness,
  deriveContextCompaction,
  deriveResponseRate,
  deriveTimeToFirstToken,
  deriveTurnCachePercentage,
  formatCachePercentage,
  formatTimeToFirstToken,
  deriveTurnElapsedMs,
  selectComposerLimitWindows,
  selectComposerStatsTurns,
  selectRecordedCompactions,
} from "./ComposerStats.logic";

const start = DateTime.makeUnsafe("2026-10-03T10:00:00Z");
const end = DateTime.makeUnsafe("2026-10-03T10:00:48Z");
const nowMs = DateTime.toEpochMillis(end);

function turn(ordinal: number, node = "main", thread = "active"): OrchestrationV2ProviderTurn {
  return {
    id: ProviderTurnId.make(`turn-${ordinal}-${node}`),
    providerThreadId: ProviderThreadId.make(thread),
    nodeId: NodeId.make(node),
    runAttemptId: null,
    nativeTurnRef: null,
    ordinal,
    status: "completed",
    startedAt: start,
    completedAt: end,
  };
}

describe("composer stats scope", () => {
  it("excludes child agents and old provider sessions and orders the main turns", () => {
    const latest = turn(2);
    expect(
      selectComposerStatsTurns({
        thread: { activeProviderThreadId: ProviderThreadId.make("active") },
        nodes: [
          { id: NodeId.make("main"), kind: "root_turn", parentNodeId: null },
          { id: NodeId.make("child"), kind: "root_turn", parentNodeId: NodeId.make("main") },
        ],
        providerTurns: [latest, turn(99, "child"), turn(100, "main", "old"), turn(1)],
      }),
    ).toEqual([turn(1), latest]);
  });

  it("keeps a newest turn with missing usage instead of borrowing a previous turn's counts", () => {
    const previous = {
      ...turn(1),
      turnTokenUsage: {
        usageStatus: "complete",
        usageScope: "main_agent",
        inputTokens: 1000,
        outputTokens: 200,
        hasSubagents: false,
      },
    } as const;
    const turns = selectComposerStatsTurns({
      thread: { activeProviderThreadId: ProviderThreadId.make("active") },
      nodes: [{ id: NodeId.make("main"), kind: "root_turn", parentNodeId: null }],
      providerTurns: [previous, turn(2)],
    });
    expect(turns.at(-1)?.turnTokenUsage).toBeUndefined();
  });
});

describe("turn cache share", () => {
  it("uses normalized input including reads and writes, for complete or partial reports", () => {
    for (const usageStatus of ["complete", "partial"] as const) {
      expect(
        deriveTurnCachePercentage({
          usageStatus,
          usageScope: "main_agent",
          inputTokens: 1000,
          cachedInputTokens: 810,
          cacheCreationTokens: 100,
          outputTokens: 25,
          hasSubagents: true,
        }),
      ).toBe(81);
    }
  });

  it("distinguishes a known zero cache rate from unavailable or inconsistent counters", () => {
    const usage = {
      usageStatus: "partial",
      usageScope: "main_agent",
      inputTokens: 1000,
      hasSubagents: false,
    } as const;
    expect(deriveTurnCachePercentage({ ...usage, cachedInputTokens: 0 })).toBe(0);
    expect(deriveTurnCachePercentage(usage)).toBeNull();
    expect(
      deriveTurnCachePercentage({ ...usage, inputTokens: 0, cachedInputTokens: 0 }),
    ).toBeNull();
    expect(deriveTurnCachePercentage({ ...usage, cachedInputTokens: 1001 })).toBeNull();
    expect(
      deriveTurnCachePercentage({ ...usage, usageStatus: "unavailable", cachedInputTokens: 100 }),
    ).toBeNull();
    expect(deriveTurnCachePercentage(undefined)).toBeNull();
  });

  it("shows cache rates to one decimal without rounding up to 100%", () => {
    expect(formatCachePercentage((998 / 1000) * 100)).toBe("99.8%");
    expect(formatCachePercentage((9996 / 10000) * 100)).toBe("99.9%");
    expect(formatCachePercentage(100)).toBe("100%");
    expect(formatCachePercentage((873 / 1000) * 100)).toBe("87.3%");
    expect(formatCachePercentage(0)).toBe("0%");
  });
});

describe("turn wall time", () => {
  it("ticks only running turns and freezes settled turns at their reported end", () => {
    expect(deriveTurnElapsedMs({ ...turn(1), status: "running", completedAt: null }, nowMs)).toBe(
      48_000,
    );
    for (const status of ["completed", "interrupted", "failed", "cancelled"] as const) {
      expect(deriveTurnElapsedMs({ ...turn(1), status }, nowMs + 60_000)).toBe(48_000);
      expect(deriveTurnElapsedMs({ ...turn(1), status, completedAt: null }, nowMs)).toBeNull();
    }
  });

  it("does not turn pending age, missing start times, or reversed timestamps into duration", () => {
    expect(
      deriveTurnElapsedMs({ ...turn(1), status: "pending", completedAt: null }, nowMs),
    ).toBeNull();
    expect(deriveTurnElapsedMs({ ...turn(1), startedAt: null }, nowMs)).toBeNull();
    expect(
      deriveTurnElapsedMs({ ...turn(1), startedAt: end, completedAt: start }, nowMs),
    ).toBeNull();
  });
});

describe("recorded compactions", () => {
  function compaction(
    id: string,
    node = "main",
    thread = "active",
    status: "completed" | "running" = "completed",
  ): Extract<OrchestrationV2TurnItem, { type: "compaction" }> {
    return {
      id: TurnItemId.make(id),
      threadId: ThreadId.make("thread"),
      runId: null,
      nodeId: NodeId.make(node),
      providerThreadId: ProviderThreadId.make(thread),
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status,
      title: null,
      startedAt: start,
      completedAt: end,
      updatedAt: end,
      type: "compaction",
      driver: null,
      beforeTokenCount: 100000,
      afterTokenCount: 20000,
    };
  }
  it("counts completed main-session events once and excludes children, old sessions and pending events", () => {
    const item = compaction("one");
    expect(
      selectRecordedCompactions(
        [
          item,
          item,
          compaction("child", "child"),
          compaction("old", "main", "old"),
          compaction("pending", "main", "active", "running"),
        ],
        [turn(1)],
      ),
    ).toEqual([item]);
  });
  it("includes native tool-node compactions and suppresses ACP's duplicate command completion", () => {
    const main = turn(1);
    const native = {
      ...compaction("native", "tool"),
      providerTurnId: main.id,
      nativeItemRef: {
        driver: ProviderDriverKind.make("grok"),
        nativeId: "acp-compaction:one",
        strength: "strong",
      },
    } as const;
    const synthetic = {
      ...compaction("synthetic"),
      providerTurnId: main.id,
      nativeItemRef: {
        driver: ProviderDriverKind.make("grok"),
        nativeId: "turn:compaction",
        strength: "weak",
      },
    } as const;
    expect(selectRecordedCompactions([synthetic, native], [main])).toEqual([native]);
    expect(selectRecordedCompactions([synthetic], [main])).toEqual([synthetic]);
  });
  it("orders events by report time rather than item ordinals from different turns", () => {
    const older = { ...compaction("older"), ordinal: 99, updatedAt: start };
    const newer = compaction("newer");
    expect(selectRecordedCompactions([newer, older], [turn(1)])).toEqual([older, newer]);
  });
});

describe("observed response rate", () => {
  const measured = {
    ...turn(1),
    nativeTurnRef: {
      driver: ProviderDriverKind.make("claudeAgent"),
      nativeId: "root",
      strength: "strong",
    },
    responseThroughput: { outputTokens: 400, elapsedMs: 4000, responseCount: 2, partial: false },
  } as const;
  it("uses persisted envelopes, including partial coverage, without turn wall time", () => {
    expect(deriveResponseRate(measured)).toBe(100);
    expect(
      deriveResponseRate({
        ...measured,
        responseThroughput: { ...measured.responseThroughput, partial: true },
      }),
    ).toBe(100);
    expect(
      deriveResponseRate({
        ...measured,
        responseThroughput: { ...measured.responseThroughput, outputTokens: 0 },
      }),
    ).toBe(0);
  });
  it("distinguishes Codex estimates from observed Claude and legacy payloads", () => {
    const codex = {
      ...measured,
      nativeTurnRef: { ...measured.nativeTurnRef, driver: ProviderDriverKind.make("codex") },
      responseThroughput: {
        ...measured.responseThroughput,
        basis: "codex_active_windows_estimate",
      },
    } as const;
    expect(deriveResponseRate(codex)).toBe(100);
    expect(
      deriveResponseRate({
        ...codex,
        status: "interrupted",
        responseThroughput: { ...codex.responseThroughput, partial: true },
      }),
    ).toBe(100);
    expect(
      deriveResponseRate({ ...measured, responseThroughput: codex.responseThroughput }),
    ).toBeNull();
    expect(
      deriveResponseRate({
        ...measured,
        responseThroughput: { ...measured.responseThroughput, basis: "claude_observed" },
      }),
    ).toBe(100);
  });
  it("omits historical, unsupported and invalid telemetry", () => {
    expect(deriveResponseRate(null)).toBeNull();
    expect(deriveResponseRate(turn(1))).toBeNull();
    expect(
      deriveResponseRate({
        ...measured,
        nativeTurnRef: { ...measured.nativeTurnRef, driver: ProviderDriverKind.make("codex") },
      }),
    ).toBeNull();
    for (const elapsedMs of [0, -1, NaN, Infinity]) {
      expect(
        deriveResponseRate({
          ...measured,
          responseThroughput: { ...measured.responseThroughput, elapsedMs },
        }),
      ).toBeNull();
    }
  });
});

describe("time to first token", () => {
  it("gives the measured value and null, never 0, without one", () => {
    expect(deriveTimeToFirstToken({ ...turn(1), timeToFirstTokenMs: 1234 })).toBe(1234);
    expect(deriveTimeToFirstToken(null)).toBeNull();
    expect(deriveTimeToFirstToken(turn(1))).toBeNull();
    for (const timeToFirstTokenMs of [0, -1, NaN, Infinity]) {
      expect(deriveTimeToFirstToken({ ...turn(1), timeToFirstTokenMs })).toBeNull();
    }
  });
  it.each([
    [1, "0.1s"],
    [49, "0.1s"],
    [1234, "1.2s"],
    [9949, "9.9s"],
    [9950, "10s"],
    [10_400, "10s"],
    [95_500, "96s"],
  ])("formats %d ms as %s", (ms, text) => {
    expect(formatTimeToFirstToken(ms)).toBe(text);
  });
});

describe("selectComposerLimitWindows", () => {
  const checkedAt = "2026-10-04T16:00:00.000Z";
  const window = (
    id: string,
    kind: "session" | "weekly" | "monthly" | "other",
    windowDurationMins?: number,
  ) => ({
    id,
    kind,
    label: id,
    usedPercent: 12,
    ...(windowDurationMins === undefined ? {} : { windowDurationMins }),
  });

  it("picks the account-wide session then weekly window with short labels", () => {
    const selected = selectComposerLimitWindows({
      checkedAt,
      windows: [
        window("seven_day", "weekly", 10_080),
        window("five_hour", "session", 300),
        window("seven_day_fable", "weekly", 10_080),
      ],
    });
    expect(selected.map(({ window, shortLabel }) => [window.id, shortLabel])).toEqual([
      ["five_hour", "5h"],
      ["seven_day", "Week"],
    ]);
  });

  it("falls back to the kind when the provider omits the duration", () => {
    expect(
      selectComposerLimitWindows({ checkedAt, windows: [window("primary", "session")] }).map(
        ({ shortLabel }) => shortLabel,
      ),
    ).toEqual(["Session"]);
  });

  it("shows nothing for missing, unsupported or empty limits", () => {
    expect(selectComposerLimitWindows(undefined)).toEqual([]);
    expect(selectComposerLimitWindows({ checkedAt, windows: [] })).toEqual([]);
    expect(
      selectComposerLimitWindows({
        checkedAt,
        windows: [window("five_hour", "session", 300)],
        unavailable: { reason: "unsupported" },
      }),
    ).toEqual([]);
  });

  it("keeps the last reported windows when a later probe failed", () => {
    expect(
      selectComposerLimitWindows({
        checkedAt,
        windows: [window("five_hour", "session", 300)],
        unavailable: { reason: "probeFailed" },
      }),
    ).toHaveLength(1);
  });
});

describe("composer limit freshness", () => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();
  it("keeps fresh meters through 3 minutes, dims through 15, then hides percentages", () => {
    for (const [age, status] of [
      [0, "fresh"],
      [180000, "fresh"],
      [180001, "stale"],
      [900000, "stale"],
      [900001, "expired"],
    ] as const) {
      expect(composerLimitsFreshness([ago(age)], now)).toEqual({
        status,
        ageMins: Math.floor(age / 60000),
        checkedAt: ago(age),
      });
    }
  });
  it("uses the newest displayed fetch and treats unknown or invalid times as expired", () => {
    expect(composerLimitsFreshness([ago(20 * 60000), ago(4 * 60000)], now).ageMins).toBe(4);
    for (const checkedAts of [[], [undefined], ["invalid"], [ago(-60000)]]) {
      expect(composerLimitsFreshness(checkedAts, now)).toEqual({
        status: "expired",
        ageMins: null,
        checkedAt: undefined,
      });
    }
  });
});

it("keeps newly fetched data visible before the next render-clock tick", () => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  const checkedAt = "2026-10-04T12:00:25Z";
  expect(composerLimitsFreshness([checkedAt], now)).toEqual({
    status: "fresh",
    ageMins: 0,
    checkedAt,
  });
});

describe("composer limit display", () => {
  const now = Date.parse("2026-10-04T12:00:00Z");
  const window = {
    id: "five_hour",
    kind: "session" as const,
    label: "Session",
    source: "probe" as const,
    usedPercent: 63,
    windowDurationMins: 300,
  };

  it("shows zero and waits for a new reading after the reset", () => {
    expect(
      composerLimitDisplay(
        {
          ...window,
          checkedAt: "2026-10-04T11:59:30Z",
          resetsAt: "2026-10-04T11:59:00Z",
        },
        undefined,
        now,
      ),
    ).toEqual({
      freshness: { status: "fresh", ageMins: 0, checkedAt: "2026-10-04T11:59:30Z" },
      resetPending: true,
      displayPercent: 0,
      percentText: "0%",
      dimmed: true,
    });
  });

  it("shows the reading age inline while a value is stale", () => {
    expect(
      composerLimitDisplay({ ...window, checkedAt: "2026-10-04T11:53:00Z" }, undefined, now)
        .percentText,
    ).toBe("63% · 7m");
  });

  it("hides a percentage once the reading is expired", () => {
    const display = composerLimitDisplay(
      { ...window, checkedAt: "2026-10-04T11:44:00Z" },
      undefined,
      now,
    );
    expect(display.displayPercent).toBeNull();
    expect(display.percentText).toBe("–");
    expect(display.dimmed).toBe(true);
  });
});

describe("context compaction pressure", () => {
  const context = {
    usedTokens: 360_000,
    usedPercentage: 36,
    autoCompactThreshold: null,
    compactsAutomatically: null,
  };

  it("keeps window fullness separate from Claude's configured 400k limit", () => {
    expect(deriveContextCompaction(context, "claudeAgent", "400000")).toMatchObject({
      threshold: 400_000,
      source: "configured",
      remainingTokens: 40_000,
      thresholdPercentage: 90,
      pressurePercentage: 90,
      status: "Claude setting",
    });
    expect(context.usedPercentage).toBe(36);
  });

  it("prefers an actual provider threshold over a newly configured limit", () => {
    expect(
      deriveContextCompaction(
        { ...context, autoCompactThreshold: 500_000 },
        "claudeAgent",
        "400000",
      ),
    ).toMatchObject({ threshold: 500_000, source: "reported", remainingTokens: 140_000 });
  });

  it("does not apply Claude's configuration to Codex or another driver", () => {
    for (const driver of ["codex", "opencode", undefined]) {
      expect(deriveContextCompaction(context, driver, "400000")).toMatchObject({
        threshold: null,
        source: null,
        remainingTokens: null,
        pressurePercentage: 36,
      });
    }
    expect(deriveContextCompaction(context, "codex", "400000").status).toContain(
      "Managed by Codex",
    );
  });

  it("does not invent a default threshold or accept invalid settings", () => {
    for (const value of [
      undefined,
      "",
      "NaN",
      "Infinity",
      "99999",
      "1000001",
      "400000oops",
      400000,
    ]) {
      expect(deriveContextCompaction(context, "claudeAgent", value)).toMatchObject({
        threshold: null,
        source: null,
      });
    }
  });

  it("honors a provider report that automatic compaction is off", () => {
    expect(
      deriveContextCompaction(
        { ...context, compactsAutomatically: false, autoCompactThreshold: 300_000 },
        "claudeAgent",
        "400000",
      ),
    ).toMatchObject({ status: "Reported off", threshold: null, pressurePercentage: 36 });
  });

  it("shows a setting without inventing occupancy", () => {
    expect(deriveContextCompaction(null, "claudeAgent", "400000")).toMatchObject({
      threshold: 400_000,
      source: "configured",
      remainingTokens: null,
      thresholdPercentage: null,
    });
  });

  it("clamps remaining tokens and warns at the smaller window limit", () => {
    expect(
      deriveContextCompaction({ ...context, usedTokens: 420_000 }, "claudeAgent", "400000"),
    ).toMatchObject({ remainingTokens: 0, pressurePercentage: 105 });
    expect(
      deriveContextCompaction(
        { ...context, usedTokens: 180_000, usedPercentage: 90 },
        "claudeAgent",
        "400000",
      ),
    ).toMatchObject({ remainingTokens: 220_000, pressurePercentage: 90 });
  });
});
