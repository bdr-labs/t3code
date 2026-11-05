import type { OrchestrationV2ProviderTurn, TurnTokenUsage } from "@t3tools/contracts";
import type * as CodexSchema from "effect-codex-app-server/schema";

type Item = CodexSchema.V2ItemStartedNotification["item"];
type ResponseThroughput = NonNullable<OrchestrationV2ProviderTurn["responseThroughput"]>;

/** Stock Codex has item boundaries, not model-response boundaries. Never time token usage. */
export class CodexResponseThroughput {
  private readonly active = new Map<string, { start: number; last: number }>();
  private readonly completed = new Set<string>();
  private readonly runningTools = new Set<string>();
  private readonly unixOrigin: number;
  private readonly monotonicOrigin: number;
  private readonly intervals: Array<{ start: number; end: number }> = [];
  private partial = false;
  private finalized = false;
  private outputSinceWait = false;
  private readonly relayItems = new Set<string>();
  private readonly compactions = new Set<string>();
  private turnStartedAt: number | undefined;
  private firstDeltaSeen = false;
  private firstTokenMs: number | undefined;

  constructor(unixOrigin: number, monotonicOrigin = performance.now()) {
    this.unixOrigin = unixOrigin;
    this.monotonicOrigin = monotonicOrigin;
  }

  private at(nativeMs: number | undefined, receipt: number): number {
    // A fixed mapping keeps wall-clock changes from moving receipt timestamps.
    if (nativeMs !== undefined && Number.isFinite(nativeMs) && nativeMs > 0)
      return nativeMs - this.unixOrigin + this.monotonicOrigin;
    return receipt;
  }

  private record(start: number, end: number): void {
    if (Number.isFinite(start) && Number.isFinite(end) && end > start)
      this.intervals.push({ start, end });
    else this.partial = true;
  }

  activity(itemId: string, receipt = performance.now()): void {
    if (this.finalized || this.completed.has(itemId)) return;
    if (!Number.isFinite(receipt)) {
      this.partial = true;
      return;
    }
    const active = this.active.get(itemId);
    if (active === undefined) {
      // A delta can recover a missing start, but only its observed suffix is timed.
      this.partial = true;
      this.active.set(itemId, { start: receipt, last: receipt });
    } else active.last = Math.max(active.last, receipt);
    this.outputSinceWait = true;
  }

  /** Native turn times are whole seconds, so both ends of the figure are monotonic receipts. */
  turnStarted(receipt = performance.now()): void {
    if (this.turnStartedAt === undefined && Number.isFinite(receipt)) this.turnStartedAt = receipt;
  }

  /** The first non-empty reasoning or message delta decides, once. */
  firstDelta(itemId: string, receipt = performance.now()): void {
    if (this.finalized || this.firstDeltaSeen || this.relayItems.has(itemId)) return;
    this.firstDeltaSeen = true;
    const start = this.turnStartedAt;
    if (start !== undefined && this.compactions.size === 0 && receipt >= start)
      this.firstTokenMs = Math.max(1, Math.round(receipt - start));
  }

  timeToFirstTokenMs(): number | undefined {
    return this.firstTokenMs;
  }

  /** Plan snapshots have no output envelope; their spacing may include tool work. */
  unmeasuredActivity(): void {
    if (!this.finalized) this.partial = true;
  }

  itemStarted(item: Item, nativeMs?: number, receipt = performance.now()): void {
    if (this.finalized) return;
    if (item.type === "agentMessage" && item.delivery === "async") {
      this.relayItems.add(item.id);
      return;
    }
    if (item.type === "contextCompaction") this.compactions.add(item.id);
    if (item.type === "reasoning" || item.type === "agentMessage" || item.type === "plan") {
      if (this.completed.has(item.id) || this.active.has(item.id)) return;
      const at = this.at(nativeMs, receipt);
      this.active.set(item.id, { start: at, last: at });
      this.outputSinceWait = true;
    } else if (
      item.type !== "userMessage" &&
      item.type !== "hookPrompt" &&
      item.type !== "subAgentActivity"
    ) {
      // Tool execution, sleep, compaction and provider work cannot open a response window.
      this.runningTools.add(item.id);
      if (!this.outputSinceWait) this.partial = true;
      this.wait(this.at(nativeMs, receipt));
    }
  }

  itemCompleted(item: Item, nativeMs?: number, receipt = performance.now()): void {
    if (this.finalized || this.completed.has(item.id)) return;
    if (item.type === "agentMessage" && item.delivery === "async") return;
    this.compactions.delete(item.id);
    if (item.type !== "reasoning" && item.type !== "agentMessage" && item.type !== "plan") {
      if (
        item.type !== "userMessage" &&
        item.type !== "hookPrompt" &&
        item.type !== "subAgentActivity" &&
        !this.runningTools.delete(item.id)
      )
        this.toolOutput();
      return;
    }
    const active = this.active.get(item.id);
    this.active.delete(item.id);
    this.completed.add(item.id);
    if (active === undefined) this.partial = true;
    else this.record(active.start, this.at(nativeMs, receipt));
  }

  /** A wait closes windows; returning from it does not imply new model activity. */
  wait(at = performance.now()): void {
    if (this.finalized) return;
    for (const active of this.active.values()) this.record(active.start, at);
    if (this.active.size > 0) this.partial = true;
    this.active.clear();
    this.outputSinceWait = false;
  }

  /** Without a tool start, its output/completion cannot identify when generation stopped. */
  toolOutput(itemId?: string): void {
    if (this.finalized || (itemId !== undefined && this.runningTools.has(itemId))) return;
    for (const active of this.active.values()) this.record(active.start, active.last);
    if (this.active.size > 0) this.partial = true;
    this.active.clear();
    this.outputSinceWait = false;
  }

  finalize(usage: TurnTokenUsage): ResponseThroughput | undefined {
    if (this.finalized) return undefined;
    this.finalized = true;
    // Missing completion/interruption: retain only the observed suffix, never the terminal wait.
    for (const active of this.active.values()) this.record(active.start, active.last);
    this.partial ||= this.active.size > 0;
    this.active.clear();
    this.runningTools.clear();
    if (
      usage.usageStatus === "unavailable" ||
      usage.outputTokens === undefined ||
      !Number.isSafeInteger(usage.outputTokens) ||
      usage.outputTokens < 0
    )
      return undefined;

    // Union output intervals, including reasoning/text that overlap. Tool durations are not summed
    // or subtracted from whole-turn wall time; only observable response activity is timed.
    const windows: Array<{ start: number; end: number }> = [];
    for (const interval of this.intervals.toSorted((a, b) => a.start - b.start)) {
      const previous = windows.at(-1);
      if (previous !== undefined && interval.start <= previous.end)
        previous.end = Math.max(previous.end, interval.end);
      else windows.push({ ...interval });
    }
    const elapsedMs = windows.reduce((sum, window) => sum + window.end - window.start, 0);
    if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return undefined;
    return {
      basis: "codex_active_windows_estimate",
      outputTokens: usage.outputTokens,
      elapsedMs,
      responseCount: windows.length,
      partial: this.partial || usage.usageStatus === "partial",
    };
  }
}
