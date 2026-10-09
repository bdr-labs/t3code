import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { describe, expect, it } from "vite-plus/test";
import { ClaudeResponseThroughput, observeClaudeFrame } from "./ClaudeResponseThroughput.ts";

function frame(event: unknown, at?: number, parent: string | null = null): SDKMessage {
  const message = { type: "stream_event", event, parent_tool_use_id: parent } as SDKMessage;
  if (at !== undefined) observeClaudeFrame(message, at);
  return message;
}
function snapshot(id: string): SDKMessage {
  return {
    type: "assistant",
    parent_tool_use_id: null,
    message: { id, usage: { output_tokens: 9999 } },
  } as SDKMessage;
}
function response(
  tracker: ClaudeResponseThroughput,
  epoch: Set<string>,
  id: string,
  start: number,
  end: number,
  tokens: number,
  parent: string | null = null,
) {
  tracker.observe(frame({ type: "message_start", message: { id } }, start, parent), epoch);
  tracker.observe(
    frame({ type: "message_delta", usage: { output_tokens: tokens } }, end, parent),
    epoch,
  );
  tracker.observe(frame({ type: "message_stop" }, end, parent), epoch);
}

describe("Claude observed response throughput", () => {
  it("weights responses by envelopes and excludes a long local tool wait", () => {
    const tracker = new ClaudeResponseThroughput();
    const epoch = new Set<string>();
    response(tracker, epoch, "one", 0, 1000, 100);
    response(tracker, epoch, "two", 600000, 603000, 300);
    tracker.finalize();
    expect(tracker.aggregate()).toEqual({
      basis: "claude_observed",
      outputTokens: 400,
      elapsedMs: 4000,
      responseCount: 2,
      partial: false,
    });
  });
  it("replaces cumulative usage, ignores repeated nonfinal snapshots and excludes children", () => {
    const tracker = new ClaudeResponseThroughput();
    const epoch = new Set<string>();
    tracker.observe(
      frame({ type: "message_start", message: { id: "one", usage: { output_tokens: 10 } } }, 0),
      epoch,
    );
    for (const tokens of [10, 50, 50, 100]) {
      tracker.observe(
        frame({ type: "message_delta", usage: { output_tokens: tokens } }, 900),
        epoch,
      );
      tracker.observe(snapshot("one"), epoch);
    }
    response(tracker, epoch, "child", 0, 100, 10000, "tool");
    expect(tracker.aggregate()).toBeUndefined();
    tracker.observe(frame({ type: "message_stop" }, 1000), epoch);
    expect(tracker.aggregate()).toEqual({
      basis: "claude_observed",
      outputTokens: 100,
      elapsedMs: 1000,
      responseCount: 1,
      partial: false,
    });
  });
  it("retains first-observation timestamps through held-frame replay", () => {
    const tracker = new ClaudeResponseThroughput();
    const epoch = new Set<string>();
    const frames = [
      frame({ type: "message_start", message: { id: "held" } }, 10),
      frame({ type: "message_delta", usage: { output_tokens: 100 } }, 1010),
      frame({ type: "message_stop" }, 1010),
    ];
    for (const message of frames) {
      observeClaudeFrame(message, 100000);
      tracker.observe(message, epoch);
    }
    expect(tracker.aggregate()?.elapsedMs).toBe(1000);
  });
  it("does not count a replayed message in this turn or a later turn of the same query", () => {
    const tracker = new ClaudeResponseThroughput();
    const epoch = new Set<string>();
    response(tracker, epoch, "one", 0, 1000, 100);
    response(tracker, epoch, "one", 2000, 3000, 100);
    expect(tracker.aggregate()).toEqual({
      basis: "claude_observed",
      outputTokens: 100,
      elapsedMs: 1000,
      responseCount: 1,
      partial: true,
    });
    const next = new ClaudeResponseThroughput();
    response(next, epoch, "one", 5000, 6000, 100);
    expect(next.aggregate()).toBeUndefined();
  });
  it.each([NaN, Infinity, -1, 1.5, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid output %s",
    (tokens) => {
      const tracker = new ClaudeResponseThroughput();
      response(tracker, new Set(), "bad", 0, 1000, tokens);
      expect(tracker.aggregate()).toBeUndefined();
    },
  );
  it("rejects decreasing cumulative usage and a missing final delta", () => {
    for (const deltas of [[], [100, 50]]) {
      const tracker = new ClaudeResponseThroughput();
      const epoch = new Set<string>();
      tracker.observe(
        frame({ type: "message_start", message: { id: "bad", usage: { output_tokens: 100 } } }, 0),
        epoch,
      );
      for (const tokens of deltas)
        tracker.observe(
          frame({ type: "message_delta", usage: { output_tokens: tokens } }, 500),
          epoch,
        );
      tracker.observe(frame({ type: "message_stop" }, 1000), epoch);
      expect(tracker.aggregate()).toBeUndefined();
    }
  });
  it("omits zero/negative durations, missing starts, unstamped streams and snapshot-only history", () => {
    for (const end of [0, -1]) {
      const tracker = new ClaudeResponseThroughput();
      response(tracker, new Set(), "bad", 0, end, 100);
      expect(tracker.aggregate()).toBeUndefined();
    }
    const tracker = new ClaudeResponseThroughput();
    const epoch = new Set<string>();
    tracker.observe(snapshot("history"), epoch);
    tracker.observe(frame({ type: "message_delta", usage: { output_tokens: 100 } }, 1000), epoch);
    tracker.observe(frame({ type: "message_stop" }, 1000), epoch);
    tracker.observe(frame({ type: "message_start", message: { id: "unstamped" } }), epoch);
    tracker.observe(frame({ type: "message_delta", usage: { output_tokens: 100 } }), epoch);
    tracker.observe(frame({ type: "message_stop" }), epoch);
    tracker.finalize();
    expect(tracker.aggregate()).toBeUndefined();
  });
  it("retains valid samples with partial coverage for interruption, unknown snapshots or query replacement", () => {
    for (const missing of [
      "interrupted",
      "snapshot",
      "epoch",
      "invalid",
      "missing-start",
      "missing-usage",
    ] as const) {
      const tracker = new ClaudeResponseThroughput();
      const epoch = new Set<string>();
      response(tracker, epoch, "good", 0, 1000, 100);
      if (missing === "snapshot") tracker.observe(snapshot("unobserved"), epoch);
      else if (missing === "invalid") response(tracker, epoch, "invalid", 2000, 3000, -1);
      else if (missing === "missing-start")
        tracker.observe(frame({ type: "message_stop" }, 3000), epoch);
      else if (missing === "missing-usage") {
        tracker.observe(frame({ type: "message_start", message: { id: "no-usage" } }, 2000), epoch);
        tracker.observe(frame({ type: "message_stop" }, 3000), epoch);
      } else {
        tracker.observe(
          frame({ type: "message_start", message: { id: "interrupted" } }, 2000),
          epoch,
        );
        tracker.observe(
          frame({ type: "message_delta", usage: { output_tokens: 200 } }, 2500),
          epoch,
        );
        if (missing === "epoch") tracker.observe(frame({ type: "message_stop" }, 3000), new Set());
      }
      tracker.finalize();
      expect(tracker.aggregate()).toEqual({
        basis: "claude_observed",
        outputTokens: 100,
        elapsedMs: 1000,
        responseCount: 1,
        partial: true,
      });
      response(tracker, epoch, "late", 4000, 5000, 100);
      expect(tracker.aggregate()?.responseCount).toBe(1);
    }
  });
});

it("rejects decreasing start usage and old-epoch held frames across reconnects", () => {
  const tracker = new ClaudeResponseThroughput();
  const seen = new Set<string>();
  const oldEpoch = {};
  const nextEpoch = {};
  const start = frame(
    { type: "message_start", message: { id: "old", usage: { output_tokens: 100 } } },
    0,
  );
  observeClaudeFrame(start, 5000, oldEpoch);
  tracker.observe(start, seen, oldEpoch);
  tracker.observe(
    frame({ type: "message_delta", usage: { output_tokens: 50 } }, 500),
    seen,
    oldEpoch,
  );
  tracker.observe(frame({ type: "message_stop" }, 1000), seen, oldEpoch);
  expect(tracker.aggregate()).toBeUndefined();
  const reconnect = new ClaudeResponseThroughput();
  observeClaudeFrame(start, 10000, nextEpoch);
  reconnect.observe(start, seen, nextEpoch);
  reconnect.observe(
    frame({ type: "message_delta", usage: { output_tokens: 100 } }, 11000),
    seen,
    nextEpoch,
  );
  reconnect.observe(frame({ type: "message_stop" }, 12000), seen, nextEpoch);
  expect(reconnect.aggregate()).toBeUndefined();
});
it("marks a turn interrupted during a tool wait as partial without losing completed responses", () => {
  const tracker = new ClaudeResponseThroughput();
  response(tracker, new Set(), "good", 0, 1000, 100);
  tracker.finalize(true);
  expect(tracker.aggregate()).toEqual({
    basis: "claude_observed",
    outputTokens: 100,
    elapsedMs: 1000,
    responseCount: 1,
    partial: true,
  });
});
