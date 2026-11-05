// @effect-diagnostics-next-line nodeBuiltinImport:off -- it.each reads recorded frames synchronously.
import * as NodeFS from "node:fs";

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

describe("Claude time to first token", () => {
  const delta = (kind: "text" | "thinking" | "input", text = "x", at?: number, parent?: string) =>
    frame(
      {
        type: "content_block_delta",
        index: 0,
        delta:
          kind === "text"
            ? { type: "text_delta", text }
            : kind === "thinking"
              ? { type: "thinking_delta", thinking: text }
              : { type: "input_json_delta", partial_json: text },
      },
      at,
      parent ?? null,
    );
  const start = (id: string, at: number, parent?: string) =>
    frame({ type: "message_start", message: { id } }, at, parent ?? null);
  const status = (value: "compacting" | "requesting" | null) =>
    ({ type: "system", subtype: "status", status: value }) as SDKMessage;

  it.each(["text", "thinking", "input"] as const)(
    "takes the first %s delta once, over later deltas and responses",
    (kind) => {
      const tracker = new ClaudeResponseThroughput(1000);
      const epoch = new Set<string>();
      tracker.observe(start("one", 1100), epoch);
      expect(tracker.timeToFirstTokenMs()).toBeUndefined();
      tracker.observe(delta(kind, "x", 2234.4), epoch);
      expect(tracker.timeToFirstTokenMs()).toBe(1234);
      tracker.observe(delta("text", "y", 3000), epoch);
      tracker.observe(frame({ type: "message_delta", usage: { output_tokens: 10 } }, 3000), epoch);
      tracker.observe(frame({ type: "message_stop" }, 3100), epoch);
      tracker.observe(start("two", 9000), epoch);
      tracker.observe(delta("text", "z", 9500), epoch);
      tracker.finalize();
      expect(tracker.timeToFirstTokenMs()).toBe(1234);
      // The figure leaves tok/s as it was: one response from its start to its stop.
      expect(tracker.aggregate()).toEqual({
        basis: "claude_observed",
        outputTokens: 10,
        elapsedMs: 2000,
        responseCount: 1,
        partial: true,
      });
    },
  );
  it("never reports zero, however close the first delta is to the start", () => {
    const tracker = new ClaudeResponseThroughput(1000);
    const epoch = new Set<string>();
    tracker.observe(start("one", 1000), epoch);
    tracker.observe(delta("text", "x", 1000), epoch);
    expect(tracker.timeToFirstTokenMs()).toBe(1);
  });
  it("skips deltas that carry no output", () => {
    const tracker = new ClaudeResponseThroughput(1000);
    const epoch = new Set<string>();
    tracker.observe(start("one", 1100), epoch);
    tracker.observe(delta("input", "", 1200), epoch);
    tracker.observe(delta("thinking", "", 1300), epoch);
    tracker.observe(
      frame(
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "signature_delta", signature: "s" },
        },
        1400,
      ),
      epoch,
    );
    expect(tracker.timeToFirstTokenMs()).toBeUndefined();
    tracker.observe(delta("text", "x", 1500), epoch);
    expect(tracker.timeToFirstTokenMs()).toBe(500);
  });
  it("ignores a subagent's frames", () => {
    const tracker = new ClaudeResponseThroughput(1000);
    const epoch = new Set<string>();
    tracker.observe(start("child", 1100, "tool"), epoch);
    tracker.observe(delta("text", "child", 1200, "tool"), epoch);
    expect(tracker.timeToFirstTokenMs()).toBeUndefined();
    tracker.observe(start("root", 1300), epoch);
    tracker.observe(delta("text", "child", 1400, "tool"), epoch);
    tracker.observe(delta("text", "root", 1500), epoch);
    expect(tracker.timeToFirstTokenMs()).toBe(500);
  });
  it("has no figure without a delta", () => {
    const tracker = new ClaudeResponseThroughput(1000);
    const epoch = new Set<string>();
    response(tracker, epoch, "one", 1100, 2000, 100);
    tracker.observe(snapshot("one"), epoch);
    tracker.finalize();
    expect(tracker.aggregate()?.responseCount).toBe(1);
    expect(tracker.timeToFirstTokenMs()).toBeUndefined();
  });
  it("does not take a resumed turn's replayed message or a frame from before its start", () => {
    const seen = new Set<string>();
    const resumed = new ClaudeResponseThroughput(5000);
    seen.add("history");
    resumed.observe(start("history", 5100), seen);
    resumed.observe(delta("text", "old", 5200), seen);
    expect(resumed.timeToFirstTokenMs()).toBeUndefined();
    resumed.observe(frame({ type: "message_stop" }, 5300), seen);
    resumed.observe(start("reply", 6000), seen);
    resumed.observe(delta("text", "new", 6500), seen);
    expect(resumed.timeToFirstTokenMs()).toBe(1500);

    for (const [startedAt, deltaAt] of [
      [4000, 4500],
      [4000, 5100],
    ] as const) {
      const held = new ClaudeResponseThroughput(5000);
      const epoch = new Set<string>();
      held.observe(start("held", startedAt), epoch);
      held.observe(delta("text", "old", deltaAt), epoch);
      expect(held.timeToFirstTokenMs()).toBeUndefined();
    }
  });
  it("does not take a delta with no response opened in this turn or an unstamped one", () => {
    const tracker = new ClaudeResponseThroughput(1000);
    const epoch = new Set<string>();
    tracker.observe(delta("text", "late", 1100), epoch);
    tracker.observe(start("one", 1200), epoch);
    tracker.observe(delta("text", "x"), epoch);
    expect(tracker.timeToFirstTokenMs()).toBeUndefined();
    tracker.observe(delta("text", "y", 1300), epoch);
    expect(tracker.timeToFirstTokenMs()).toBe(300);
  });
  it("has no figure for a turn with no send to time", () => {
    const tracker = new ClaudeResponseThroughput();
    const epoch = new Set<string>();
    tracker.observe(start("one", 1100), epoch);
    tracker.observe(delta("text", "x", 1200), epoch);
    expect(tracker.timeToFirstTokenMs()).toBeUndefined();
  });
  it("gives a delta during a compaction no figure, and measures a reply after one", () => {
    const during = new ClaudeResponseThroughput(1000);
    const epoch = new Set<string>();
    during.observe(status("compacting"), epoch);
    during.observe(start("summary", 1100), epoch);
    during.observe(delta("text", "summary", 1200), epoch);
    during.observe(status(null), epoch);
    during.observe(frame({ type: "message_stop" }, 1300), epoch);
    during.observe(start("reply", 2000), epoch);
    during.observe(delta("text", "reply", 2100), epoch);
    expect(during.timeToFirstTokenMs()).toBeUndefined();

    const after = new ClaudeResponseThroughput(1000);
    after.observe(status("compacting"), epoch);
    after.observe(status(null), epoch);
    after.observe(
      { type: "system", subtype: "compact_boundary", compact_metadata: {} } as SDKMessage,
      epoch,
    );
    after.observe(status("requesting"), epoch);
    after.observe(start("after", 2000), epoch);
    after.observe(delta("text", "reply", 2100), epoch);
    expect(after.timeToFirstTokenMs()).toBe(1100);

    const server = new ClaudeResponseThroughput(1000);
    server.observe(start("server-side", 1100), new Set());
    server.observe(
      frame(
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "compaction_delta", content: "summary" },
        },
        1200,
      ),
      new Set(),
    );
    expect(server.timeToFirstTokenMs()).toBeUndefined();
  });
  it("gives output arriving while the prompt is still queued no figure", () => {
    const behind = new ClaudeResponseThroughput(1000);
    const epoch = new Set<string>();
    behind.promptQueued(true);
    behind.observe(start("wake", 1100), epoch);
    behind.observe(delta("text", "wake", 1200), epoch);
    behind.promptQueued(false);
    behind.observe(start("own", 5000), epoch);
    behind.observe(delta("text", "own", 5100), epoch);
    expect(behind.timeToFirstTokenMs()).toBeUndefined();

    const started = new ClaudeResponseThroughput(1000);
    started.promptQueued(true);
    started.promptQueued(false);
    const fresh = new Set<string>();
    started.observe(start("own", 1100), fresh);
    started.observe(delta("text", "own", 1200), fresh);
    expect(started.timeToFirstTokenMs()).toBe(200);
  });
  it("does not take a predecessor process's frame or anything after the turn ended", () => {
    const replaced = new ClaudeResponseThroughput(1000);
    const seen = new Set<string>();
    const oldEpoch = {};
    const late = start("old", 1100);
    observeClaudeFrame(late, 1100, oldEpoch);
    replaced.observe(late, seen, {});
    const lateDelta = delta("text", "old", 1200);
    observeClaudeFrame(lateDelta, 1200, oldEpoch);
    replaced.observe(lateDelta, seen, {});
    expect(replaced.timeToFirstTokenMs()).toBeUndefined();

    const ended = new ClaudeResponseThroughput(1000);
    ended.observe(start("one", 1100), seen);
    ended.finalize(true);
    ended.observe(delta("text", "x", 1200), seen);
    expect(ended.timeToFirstTokenMs()).toBeUndefined();
  });
  it.each([
    // Recorded: two empty thinking deltas, a signature and an empty tool delta come first.
    ["tool_call_denied_write", 16],
    ["claude_compact_after_peer_turn", 6],
    ["claude_nested_subagent_model", 7],
  ])("takes the first output in the recorded frames of %s", (fixture, frameIndex) => {
    const transcript = new URL(
      `../testkit/fixtures/${fixture}/claude_transcript.ndjson`,
      import.meta.url,
    );
    const tracker = new ClaudeResponseThroughput(1000);
    const epoch = new Set<string>();
    NodeFS.readFileSync(transcript, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter((entry) => entry.type === "emit_inbound")
      .forEach((entry, index) => {
        const message = entry.frame as SDKMessage;
        observeClaudeFrame(message, 1000 + index);
        tracker.observe(message, epoch);
      });
    expect(tracker.timeToFirstTokenMs()).toBe(frameIndex);
  });
});
