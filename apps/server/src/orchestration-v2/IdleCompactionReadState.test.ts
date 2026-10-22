import { describe, expect, it } from "@effect/vitest";
import { MessageId, RunId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  idleCompactionMessageId,
  idleCompactionVisitedAt,
  isIdleCompactionRun,
} from "./IdleCompaction.ts";

const NOW_MS = Date.parse("2026-10-22T12:00:00.000Z");
const at = (offsetMs: number) => DateTime.makeUnsafe(NOW_MS + offsetMs);
const threadId = ThreadId.make("idle-thread");
const userRunId = RunId.make("run-user");
const compactionRunId = RunId.make("run-compaction");

const userRun = {
  id: userRunId,
  ordinal: 1,
  status: "completed" as const,
  completedAt: at(0),
  userMessageId: MessageId.make("message-user"),
};
const compactionRun = {
  id: compactionRunId,
  ordinal: 2,
  status: "completed" as const,
  completedAt: at(60 * 60_000),
  userMessageId: idleCompactionMessageId(threadId, userRunId),
};

describe("idle compaction read state", () => {
  it("recognises only the runs an idle compaction started", () => {
    expect(isIdleCompactionRun(compactionRun)).toBe(true);
    expect(isIdleCompactionRun(userRun)).toBe(false);
  });

  it("keeps a thread read after its compaction when it was read before", () => {
    expect(
      idleCompactionVisitedAt(
        { thread: { lastVisitedAt: at(1_000) }, runs: [userRun, compactionRun] },
        compactionRunId,
      ),
    ).toEqual(compactionRun.completedAt);
  });

  it("leaves a thread that was still unread, or never opened, as it was", () => {
    expect(
      idleCompactionVisitedAt(
        { thread: { lastVisitedAt: at(-1_000) }, runs: [userRun, compactionRun] },
        compactionRunId,
      ),
    ).toBeNull();
    expect(
      idleCompactionVisitedAt(
        { thread: { lastVisitedAt: null }, runs: [userRun, compactionRun] },
        compactionRunId,
      ),
    ).toBeNull();
  });

  it("does not touch the read mark for a person's own run or a failed compaction", () => {
    expect(
      idleCompactionVisitedAt(
        { thread: { lastVisitedAt: at(1_000) }, runs: [userRun, compactionRun] },
        userRunId,
      ),
    ).toBeNull();
    expect(
      idleCompactionVisitedAt(
        {
          thread: { lastVisitedAt: at(1_000) },
          runs: [userRun, { ...compactionRun, status: "failed" as const }],
        },
        compactionRunId,
      ),
    ).toBeNull();
  });
});
