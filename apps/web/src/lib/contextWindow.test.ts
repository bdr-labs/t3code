import { describe, expect, it } from "vite-plus/test";
import { OrchestrationV2ProviderTurnTokenUsage } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { formatContextWindowCompactionMessage } from "../components/chat/ContextWindowMeter.logic";
import * as DateTime from "effect/DateTime";
import {
  ContextTransferId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import { makeThreadProjectionFixture } from "../test-fixtures";
import {
  deriveLatestContextWindowSnapshot,
  latestProviderTurnTokenUsage,
  shouldOfferResumeCompaction,
} from "@t3tools/client-runtime/state/context-window";

const decodeTokenUsage = Schema.decodeSync(OrchestrationV2ProviderTurnTokenUsage);

describe("V2 context window presentation", () => {
  it("uses retained compaction token data when available", () => {
    const entries = [
      {
        item: {
          id: "compaction-1" as never,
          threadId: "thread-1" as never,
          runId: null,
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 1,
          status: "completed",
          title: null,
          startedAt: DateTime.makeUnsafe("2026-06-19T23:59:00.000Z"),
          completedAt: DateTime.makeUnsafe("2026-06-20T00:00:00.000Z"),
          updatedAt: DateTime.makeUnsafe("2026-06-20T00:00:00.000Z"),
          type: "compaction",
          driver: null,
          beforeTokenCount: 10_000,
          afterTokenCount: 2_000,
        },
      },
    ] as const;
    const snapshot = deriveLatestContextWindowSnapshot(entries);
    expect(snapshot?.updatedAt).toBe("2026-06-20T00:00:00.000Z");
    for (const status of ["running", "failed"] as const) {
      expect(
        deriveLatestContextWindowSnapshot(
          entries.map((entry) => ({ item: { ...entry.item, status } })),
        ),
      ).toBeNull();
    }
    expect(snapshot?.usedTokens).toBe(2_000);
    expect(snapshot?.totalProcessedTokens).toBeNull();
    expect(snapshot?.compactsAutomatically).toBeNull();
  });
});

describe("live provider-turn usage (#8144)", () => {
  it("prefers the provider's live report over compaction items", () => {
    const usage = decodeTokenUsage({
      usedTokens: 42_000,
      maxTokens: 200_000,
      inputTokens: 40_000,
      outputTokens: 2_000,
      autoCompactThreshold: 150_000,
      updatedAt: "2026-08-27T00:00:00.000Z",
    });
    const snapshot = deriveLatestContextWindowSnapshot([], usage);
    expect(snapshot).not.toBeNull();
    expect(snapshot?.usedTokens).toBe(42_000);
    expect(snapshot?.maxTokens).toBe(200_000);
    expect(snapshot?.remainingTokens).toBe(158_000);
    expect(snapshot?.usedPercentage).toBe(21);
    expect(snapshot?.autoCompactThreshold).toBe(150_000);
    expect(
      formatContextWindowCompactionMessage("Claude Sonnet 4.6", snapshot?.autoCompactThreshold),
    ).toBe("Compacts automatically at about 150,000 tokens.");
  });
});

describe("latestProviderTurnTokenUsage", () => {
  it("picks the newest report, not the last turn in snapshot order", () => {
    const usage = (usedTokens: number, updatedAt: string) => ({
      tokenUsage: { usedTokens, updatedAt },
    });
    const latest = latestProviderTurnTokenUsage([
      usage(300_000, "2026-06-20T12:00:00.000Z"),
      {},
      usage(90_000, "2026-06-20T09:00:00.000Z"),
    ]);
    expect(latest?.usedTokens).toBe(300_000);
  });

  const sourceUsage = {
    usedTokens: 513_000,
    maxTokens: 1_000_000,
    promptCacheTtlMs: 5 * 60_000,
    updatedAt: "2026-10-19T12:00:00.000Z",
  };
  function forkProjection() {
    const projection = makeThreadProjectionFixture();
    const sourceThreadId = ThreadId.make("parent");
    const runId = RunId.make("fork-point");
    return {
      thread: {
        ...projection.thread,
        forkedFrom: { type: "run" as const, threadId: sourceThreadId, runId },
      },
      contextTransfers: [
        {
          id: ContextTransferId.make("fork-transfer"),
          type: "fork" as const,
          sourceThreadId,
          targetThreadId: projection.thread.id,
          sourcePoint: { threadId: sourceThreadId, runId },
          basePoint: null,
          sourceProviderInstanceId: projection.thread.modelSelection.instanceId,
          sourceTokenUsage: sourceUsage,
          targetProviderInstanceId: null,
          targetRunId: null,
          status: "pending" as const,
          resolution: null,
          createdBy: "user" as const,
          error: null,
          createdAt: projection.updatedAt,
          updatedAt: projection.updatedAt,
          consumedAt: null,
        },
      ],
    };
  }

  it("keeps fork-point context and its cache expiry before the fork reports usage", () => {
    const usage = latestProviderTurnTokenUsage([], forkProjection());
    expect(usage).toEqual(sourceUsage);
    const snapshot = deriveLatestContextWindowSnapshot([], usage);
    expect(snapshot?.usedTokens).toBe(513_000);
    expect(
      shouldOfferResumeCompaction({
        provider: "claudeAgent",
        usedTokens: snapshot?.usedTokens,
        updatedAt: snapshot?.updatedAt,
        promptCacheTtlMs: usage?.promptCacheTtlMs,
        now: "2026-10-19T12:06:00.000Z",
      }),
    ).toBe(true);
  });

  it("replaces inherited usage with the fork's own report", () => {
    const tokenUsage = { usedTokens: 42_000, updatedAt: "2026-10-19T12:10:00.000Z" };
    expect(latestProviderTurnTokenUsage([{ tokenUsage }], forkProjection())).toEqual(tokenUsage);
  });

  it.each([0, 42_000])(
    "prefers target provider-thread usage of %d tokens over inherited usage",
    (usedTokens) => {
      const providerThread = {
        contextUsage: {
          usedTokens,
          maxTokens: 200_000,
          cost: { amount: 0.42, currency: "USD" },
        },
        updatedAt: DateTime.makeUnsafe("2026-10-19T12:10:00.000Z"),
      };
      const usage = latestProviderTurnTokenUsage([], forkProjection(), providerThread);
      const snapshot = deriveLatestContextWindowSnapshot([], usage, providerThread);

      expect(snapshot).toMatchObject({
        usedTokens,
        maxTokens: 200_000,
        cost: { amount: 0.42, currency: "USD" },
        updatedAt: "2026-10-19T12:10:00.000Z",
      });
    },
  );

  it("keeps the fallback after a native fork is consumed", () => {
    const projection = forkProjection();
    const transfer = projection.contextTransfers[0]!;
    expect(
      latestProviderTurnTokenUsage([], {
        ...projection,
        contextTransfers: [
          {
            ...transfer,
            status: "consumed",
            resolution: {
              strategy: "native_fork",
              providerThreadRef: {
                driver: ProviderDriverKind.make("claudeAgent"),
                nativeId: "fork",
                strength: "strong",
              },
            },
          },
        ],
      }),
    ).toEqual(sourceUsage);
  });

  it("does not reuse usage for portable handoffs, different providers, or missing history", () => {
    const projection = forkProjection();
    const transfer = projection.contextTransfers[0]!;
    for (const contextTransfers of [
      [],
      [{ ...transfer, sourceTokenUsage: undefined }],
      [{ ...transfer, status: "resolved_portable" as const }],
      [{ ...transfer, sourceProviderInstanceId: ProviderInstanceId.make("other") }],
      [{ ...transfer, sourcePoint: { ...transfer.sourcePoint, runId: RunId.make("later") } }],
    ]) {
      expect(latestProviderTurnTokenUsage([], { ...projection, contextTransfers })).toBeNull();
    }
  });
});

describe("compaction policy metadata", () => {
  it("preserves reported policy alongside newer turn occupancy", () => {
    const snapshot = deriveLatestContextWindowSnapshot(
      [],
      {
        usedTokens: 360_000,
        maxTokens: 1_000_000,
        updatedAt: "2026-10-10T12:00:00.000Z",
      },
      {
        contextUsage: {
          usedTokens: 300_000,
          autoCompactThreshold: 400_000,
          compactsAutomatically: true,
        },
        updatedAt: DateTime.makeUnsafe("2026-10-10T11:00:00.000Z"),
      },
    );
    expect(snapshot).toMatchObject({
      usedTokens: 360_000,
      usedPercentage: 36,
      autoCompactThreshold: 400_000,
      compactsAutomatically: true,
    });
  });

  it("does not assume automatic compaction from a usage report", () => {
    expect(
      deriveLatestContextWindowSnapshot([], {
        usedTokens: 42_000,
        updatedAt: "2026-10-10T12:00:00.000Z",
      }),
    ).toMatchObject({ compactsAutomatically: null, autoCompactThreshold: null });
  });
});
