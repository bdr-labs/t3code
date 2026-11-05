import type { TurnTokenUsage } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { CodexResponseThroughput } from "./CodexResponseThroughput.ts";

const usage: TurnTokenUsage = {
  usageStatus: "complete",
  usageScope: "main_agent",
  hasSubagents: false,
  inputTokens: 100,
  outputTokens: 400,
  reasoningTokens: 100,
};
const origin = 1_800_000_000_000;
const reasoning = { type: "reasoning", id: "reasoning" } as const;
const text = { type: "agentMessage", id: "text", text: "Answer" } as const;
const plan = { type: "plan", id: "plan", text: "Plan" } as const;
const tool = { type: "sleep", id: "tool", durationMs: 100_000 } as const;
const tracker = () => new CodexResponseThroughput(origin, 0);
const expected = (elapsedMs: number, responseCount = 1, partial = false) => ({
  basis: "codex_active_windows_estimate",
  outputTokens: 400,
  elapsedMs,
  responseCount,
  partial,
});

describe("stock Codex response activity estimate", () => {
  it("includes reasoning and unions overlapping reasoning, text and plan intervals", () => {
    const t = tracker();
    t.itemStarted(reasoning, origin);
    t.itemStarted(text, origin + 500);
    t.itemStarted(plan, origin + 1000);
    t.itemCompleted(reasoning, origin + 1500);
    t.itemCompleted(text, origin + 2000);
    t.itemCompleted(plan, origin + 3000);
    expect(t.finalize(usage)).toEqual(expected(3000));
  });

  it("plan snapshots cannot turn the gap between updates into generation time", () => {
    const t = tracker();
    t.unmeasuredActivity();
    t.unmeasuredActivity();
    expect(t.finalize(usage)).toBeUndefined();
    const covered = tracker();
    covered.itemStarted(plan, origin);
    covered.itemCompleted(plan, origin + 1000);
    covered.unmeasuredActivity();
    expect(covered.finalize(usage)).toEqual(expected(1000, 1, true));
  });

  it("excludes long tool, approval and user-input gaps between responses", () => {
    const t = tracker();
    t.itemStarted(reasoning, origin);
    t.itemCompleted(reasoning, origin + 1000);
    t.itemStarted(tool, origin + 1000);
    t.wait(40_000);
    t.wait(80_000);
    t.itemCompleted(tool, origin + 100_000);
    t.itemStarted(text, origin + 200_000);
    t.itemCompleted(text, origin + 203_000);
    expect(t.finalize(usage)).toEqual(expected(4000, 2));
  });

  it("cuts an unclosed response at tool start and never resumes on overlapping tool completions", () => {
    const t = tracker();
    t.itemStarted(text, origin);
    t.activity(text.id, 500);
    t.itemStarted(tool, origin + 1000);
    t.itemStarted({ ...tool, id: "parallel" }, origin + 2000);
    t.itemCompleted(tool, origin + 60_000);
    t.itemCompleted({ ...tool, id: "parallel" }, origin + 100_000);
    expect(t.finalize(usage)).toEqual(expected(1000, 1, true));
  });

  it("can observe model activity while background tools are still running", () => {
    const t = tracker();
    t.itemStarted(tool, origin);
    t.itemStarted(text, origin + 1000);
    t.itemCompleted(text, origin + 3000);
    t.itemCompleted(tool, origin + 100_000);
    expect(t.finalize(usage)).toEqual(expected(2000, 1, true));
  });

  it("background tool output and completion do not truncate observable concurrent generation", () => {
    const t = tracker();
    t.itemStarted(tool, origin);
    t.itemStarted(reasoning, origin + 1000);
    t.activity(reasoning.id, 1500);
    t.toolOutput(tool.id);
    t.itemCompleted(tool, origin + 2000);
    t.activity(reasoning.id, 2500);
    t.itemCompleted(reasoning, origin + 3000);
    expect(t.finalize(usage)).toEqual(expected(2000, 1, true));
  });

  it("uses monotonic receipts when native timestamps are absent", () => {
    const t = tracker();
    t.itemStarted(reasoning, undefined, 1000);
    t.activity(reasoning.id, 1500);
    t.itemCompleted(reasoning, undefined, 2000);
    expect(t.finalize(usage)).toEqual(expected(1000));
  });

  it("recovers missing starts from deltas as partial coverage", () => {
    const t = tracker();
    t.activity(text.id, 1000);
    t.activity(text.id, 2000);
    t.itemCompleted(text, undefined, 3000);
    expect(t.finalize(usage)).toEqual(expected(2000, 1, true));
  });

  it("interruption or a missing completion retains only the last observed activity", () => {
    const t = tracker();
    t.itemStarted(reasoning, undefined, 1000);
    t.activity(reasoning.id, 2000);
    expect(t.finalize({ ...usage, usageStatus: "partial" })).toEqual(expected(1000, 1, true));
  });

  it("does not extend activity to delayed token usage or the turn terminal", () => {
    const t = tracker();
    t.itemStarted(text, origin);
    t.itemCompleted(text, origin + 1000, 100_000);
    t.itemStarted(tool, origin + 1000);
    t.itemCompleted(tool, origin + 500_000);
    expect(t.finalize(usage)).toEqual(expected(1000));
  });

  it("missing tool starts close at the last output observation, not tool output/completion", () => {
    for (const complete of [false, true]) {
      const t = tracker();
      t.itemStarted(text, undefined, 1000);
      t.activity(text.id, 2000);
      if (complete) t.itemCompleted(tool, origin + 100_000);
      else t.toolOutput();
      expect(t.finalize(usage)).toEqual(expected(1000, 1, true));
    }
  });

  it("omits old/no events, tools-only, snapshots-only and unmeasurable single deltas", () => {
    for (const scenario of ["none", "tool", "snapshot", "delta", "zero", "reverse"] as const) {
      const t = tracker();
      if (scenario === "tool") {
        t.itemStarted(tool, origin);
        t.itemCompleted(tool, origin + 1000);
      }
      if (scenario === "snapshot") t.itemCompleted(text, origin + 1000);
      if (scenario === "delta") t.activity(text.id, 1000);
      if (scenario === "zero" || scenario === "reverse") {
        t.itemStarted(text, origin + 1000);
        t.itemCompleted(text, origin + (scenario === "zero" ? 1000 : 500));
      }
      expect(t.finalize(usage)).toBeUndefined();
    }
  });

  it("marks a tools-only response or missing envelope partial while retaining measured windows", () => {
    const t = tracker();
    t.itemStarted(tool, origin);
    t.itemCompleted(tool, origin + 1000);
    t.itemCompleted(reasoning, origin + 2000);
    t.itemStarted(text, origin + 3000);
    t.itemCompleted(text, origin + 4000);
    expect(t.finalize(usage)).toEqual(expected(1000, 1, true));
  });

  it("a fresh tracker after reconnect or a new turn cannot borrow previous intervals", () => {
    const prior = tracker();
    prior.itemStarted(text, origin);
    prior.itemCompleted(text, origin + 1000);
    expect(prior.finalize(usage)).toEqual(expected(1000));
    prior.activity("late", 10_000);
    expect(prior.finalize(usage)).toBeUndefined();
    const resumed = tracker();
    resumed.itemCompleted(text, origin + 20_000);
    expect(resumed.finalize(usage)).toBeUndefined();
    const suffix = tracker();
    suffix.activity(text.id, 30_000);
    suffix.itemCompleted(text, undefined, 31_000);
    expect(suffix.finalize(usage)).toEqual(expected(1000, 1, true));
  });

  it("ignores duplicate completed items and asynchronous child relay messages", () => {
    const t = tracker();
    const child = { ...text, id: "relay", delivery: "async" } as const;
    t.itemStarted(child, origin);
    t.itemCompleted(child, origin + 100_000);
    t.itemStarted(text, origin);
    t.itemCompleted(text, origin + 1000);
    t.itemStarted(text, origin + 100_000);
    t.itemCompleted(text, origin + 200_000);
    expect(t.finalize(usage)).toEqual(expected(1000));
  });

  it("omits a measured interval without valid provider turn usage", () => {
    for (const outputTokens of [undefined, -1, NaN, Infinity, 1.5]) {
      const t = tracker();
      t.itemStarted(text, origin);
      t.itemCompleted(text, origin + 1000);
      expect(t.finalize({ ...usage, usageStatus: "partial", outputTokens })).toBeUndefined();
    }
  });
});

describe("Codex time to first token", () => {
  it("runs from turn/started to the first delta, once, on receipts", () => {
    const t = tracker();
    t.turnStarted(1000);
    expect(t.timeToFirstTokenMs()).toBeUndefined();
    t.firstDelta(reasoning.id, 2234.4);
    t.firstDelta(text.id, 9000);
    t.turnStarted(8000);
    t.firstDelta(text.id, 9500);
    expect(t.timeToFirstTokenMs()).toBe(1234);
    t.finalize(usage);
    expect(t.timeToFirstTokenMs()).toBe(1234);
  });

  it("never reports zero and never takes a delta from before the start", () => {
    const close = tracker();
    close.turnStarted(1000);
    close.firstDelta(text.id, 1000);
    expect(close.timeToFirstTokenMs()).toBe(1);

    // Whatever came first decides: a start after it cannot turn a later delta into a small figure.
    const reversed = tracker();
    reversed.firstDelta(text.id, 1000);
    reversed.turnStarted(2000);
    reversed.firstDelta(text.id, 2100);
    expect(reversed.timeToFirstTokenMs()).toBeUndefined();

    const backwards = tracker();
    backwards.turnStarted(2000);
    backwards.firstDelta(text.id, 1000);
    expect(backwards.timeToFirstTokenMs()).toBeUndefined();
  });

  it("has no figure without a start or a delta, and leaves the estimate as it was", () => {
    const noStart = tracker();
    noStart.firstDelta(text.id, 1000);
    expect(noStart.timeToFirstTokenMs()).toBeUndefined();

    const noDelta = tracker();
    noDelta.turnStarted(1000);
    noDelta.itemStarted(text, origin);
    noDelta.itemCompleted(text, origin + 1000);
    expect(noDelta.finalize(usage)).toEqual(expected(1000));
    expect(noDelta.timeToFirstTokenMs()).toBeUndefined();
  });

  it("does not take a child's relayed message", () => {
    const t = tracker();
    t.turnStarted(1000);
    t.itemStarted({ ...text, id: "relay", delivery: "async" }, origin);
    t.firstDelta("relay", 1100);
    expect(t.timeToFirstTokenMs()).toBeUndefined();
    t.firstDelta(text.id, 1500);
    expect(t.timeToFirstTokenMs()).toBe(500);
  });

  it("gives a delta during a compaction no figure, and measures a reply after one", () => {
    const compaction = { type: "contextCompaction", id: "compaction" } as const;
    const during = tracker();
    during.turnStarted(1000);
    during.itemStarted(compaction, origin);
    during.firstDelta(text.id, 1100);
    during.itemCompleted(compaction, origin + 1000);
    during.firstDelta(text.id, 2100);
    expect(during.timeToFirstTokenMs()).toBeUndefined();

    const after = tracker();
    after.turnStarted(1000);
    after.itemStarted(compaction, origin);
    after.itemCompleted(compaction, origin + 1000);
    after.firstDelta(text.id, 2100);
    expect(after.timeToFirstTokenMs()).toBe(1100);
  });

  it("does not take a delta after the turn ended", () => {
    const t = tracker();
    t.turnStarted(1000);
    t.finalize(usage);
    t.firstDelta(text.id, 1100);
    expect(t.timeToFirstTokenMs()).toBeUndefined();
  });
});
