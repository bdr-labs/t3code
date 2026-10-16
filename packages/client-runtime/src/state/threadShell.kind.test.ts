import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { childThreadInputsTitle } from "./threadShell.ts";

const worker = { hasPendingApprovals: false, delegatedByThreadId: ThreadId.make("parent") };
const native = { hasPendingApprovals: false };

describe("childThreadInputsTitle kind", () => {
  it("names a single delegate_task worker an agent and a provider-native child a subagent", () => {
    expect(childThreadInputsTitle([{ ...worker, hasPendingApprovals: true }])).toBe(
      "agent needs approval",
    );
    expect(childThreadInputsTitle([native])).toBe("subagent needs input");
  });

  it("counts several children by kind", () => {
    expect(childThreadInputsTitle([worker, worker])).toBe("2 agents need input");
    expect(childThreadInputsTitle([native, native])).toBe("2 subagents need input");
    expect(childThreadInputsTitle([worker, { ...native, hasPendingApprovals: true }])).toBe(
      "1 agent and 1 subagent need you",
    );
  });
});
