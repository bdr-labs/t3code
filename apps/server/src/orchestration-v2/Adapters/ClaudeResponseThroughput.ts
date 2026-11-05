import type { SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import type { OrchestrationV2ProviderTurn } from "@t3tools/contracts";

// Keep SDK payloads unchanged. Object identity survives logging, echo gates and wake buffers.
const observedAt = new WeakMap<SDKMessage, { at: number; epoch?: object }>();
export function observeClaudeFrame(
  message: SDKMessage,
  at = performance.now(),
  epoch?: object,
): void {
  const observation = observedAt.get(message);
  if (observation === undefined) {
    observedAt.set(message, { at, ...(epoch === undefined ? {} : { epoch }) });
  } else if (observation.epoch === undefined && epoch !== undefined) {
    observation.epoch = epoch;
  }
}

type ResponseThroughput = NonNullable<OrchestrationV2ProviderTurn["responseThroughput"]>;

/** Only message_stop finalizes cumulative message_delta usage. Assistant snapshots are nonfinal. */
export class ClaudeResponseThroughput {
  private active:
    | {
        id: string;
        startedAt: number;
        lastAt: number;
        tokens?: number;
        hasFinalUsage: boolean;
        invalid: boolean;
      }
    | undefined;
  private epoch: object | undefined;
  private readonly completed = new Set<string>();
  private readonly snapshots = new Set<string>();
  private outputTokens = 0;
  private elapsedMs = 0;
  private partial = false;
  private finalized = false;
  private readonly turnStartedAt: number | undefined;
  private firstDeltaSeen = false;
  private firstTokenMs: number | undefined;
  private compacting = false;
  private queued = false;

  /** A turn with no send to time, a wake or a compaction, passes no start and gets no figure. */
  constructor(turnStartedAt?: number) {
    this.turnStartedAt = turnStartedAt;
  }

  observe(
    message: SDKMessage,
    seenMessageIds: Set<string>,
    epoch: object = seenMessageIds,
  ): boolean {
    if (this.finalized) return false;
    if (message.type === "system") {
      if (message.subtype === "status") this.compacting = message.status === "compacting";
      else if (message.subtype === "compact_boundary") this.compacting = false;
      return false;
    }
    if (
      (message.type !== "stream_event" && message.type !== "assistant") ||
      message.parent_tool_use_id !== null
    )
      return false;
    const observation = observedAt.get(message);
    if (
      (this.epoch !== undefined && this.epoch !== epoch) ||
      (observation?.epoch !== undefined && observation.epoch !== epoch)
    ) {
      // A process replacement cannot complete an envelope from its predecessor.
      this.partial = true;
      this.active = undefined;
      return false;
    }
    this.epoch = epoch;
    if (message.type === "assistant") {
      this.snapshots.add(message.message.id);
      return false;
    }
    const event = message.event;
    const at = observation?.at;
    if (event.type === "message_start") {
      if (this.active !== undefined) this.partial = true;
      const id = event.message.id;
      const duplicate = seenMessageIds.has(id);
      seenMessageIds.add(id);
      const tokens = event.message.usage?.output_tokens;
      this.active = {
        id,
        startedAt: at ?? NaN,
        lastAt: at ?? NaN,
        ...(tokens === undefined ? {} : { tokens }),
        hasFinalUsage: false,
        invalid:
          duplicate ||
          !id ||
          at === undefined ||
          !Number.isFinite(at) ||
          (tokens !== undefined && (!Number.isSafeInteger(tokens) || tokens < 0)),
      };
    } else if (event.type === "message_delta") {
      if (this.active === undefined) {
        this.partial = true;
      } else {
        const tokens = event.usage?.output_tokens;
        if (
          !Number.isSafeInteger(tokens) ||
          tokens < 0 ||
          (this.active.tokens !== undefined && tokens < this.active.tokens) ||
          at === undefined ||
          !Number.isFinite(at) ||
          at < this.active.lastAt
        )
          this.active.invalid = true;
        else {
          this.active.tokens = tokens;
          this.active.hasFinalUsage = true;
          this.active.lastAt = at;
        }
      }
    } else if (event.type === "message_stop") {
      const response = this.active;
      this.active = undefined;
      const duration = at === undefined || response === undefined ? NaN : at - response.startedAt;
      if (
        response === undefined ||
        response.invalid ||
        response.tokens === undefined ||
        !response.hasFinalUsage ||
        at === undefined ||
        !Number.isFinite(duration) ||
        duration <= 0 ||
        at < response.lastAt ||
        !Number.isSafeInteger(this.outputTokens + response.tokens) ||
        !Number.isFinite(this.elapsedMs + duration)
      ) {
        this.partial = true;
        return false;
      }
      this.completed.add(response.id);
      this.outputTokens += response.tokens;
      this.elapsedMs += duration;
      return true;
    } else if (event.type === "content_block_delta") {
      const delta = event.delta;
      // Signatures and citations are not output, and tool blocks open with an empty delta.
      if (
        (delta.type === "text_delta" && delta.text.length > 0) ||
        (delta.type === "thinking_delta" && delta.thinking.length > 0) ||
        (delta.type === "input_json_delta" && delta.partial_json.length > 0)
      )
        this.observeFirstDelta(at);
    }
    return false;
  }

  /** The first output of a response opened in this turn decides, once; replays are never it. */
  private observeFirstDelta(at: number | undefined): void {
    const start = this.turnStartedAt;
    if (
      this.firstDeltaSeen ||
      start === undefined ||
      this.active === undefined ||
      this.active.invalid ||
      this.active.startedAt < start ||
      at === undefined ||
      !Number.isFinite(at) ||
      at < start
    )
      return;
    this.firstDeltaSeen = true;
    if (!this.compacting && !this.queued) this.firstTokenMs = Math.max(1, Math.round(at - start));
  }

  /** Root output while the CLI still holds this prompt queued is another turn's, so no figure. */
  promptQueued(queued: boolean): void {
    this.queued = queued;
  }

  timeToFirstTokenMs(): number | undefined {
    return this.firstTokenMs;
  }

  finalize(partial = false): void {
    this.finalized = true;
    this.partial ||= partial;
    if (this.active !== undefined) this.partial = true;
    this.active = undefined;
  }

  aggregate(): ResponseThroughput | undefined {
    if (this.completed.size === 0) return undefined;
    return {
      basis: "claude_observed",
      outputTokens: this.outputTokens,
      elapsedMs: this.elapsedMs,
      responseCount: this.completed.size,
      partial:
        this.partial ||
        this.active !== undefined ||
        [...this.snapshots].some((id) => !this.completed.has(id)),
    };
  }
}
