import { RunId, ThreadId } from "@t3tools/contracts";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { describe, expect, it } from "vite-plus/test";

import { presentPendingBackgroundWork } from "./threadExecution.ts";

const childThreadId = ThreadId.make("thread:child");

describe("pending background work kind", () => {
  it("waits on an agent for a delegate_task worker", () => {
    const presentation = presentPendingBackgroundWork([
      {
        taskId: "worker",
        kind: "subagent",
        description: "Mobiel dashboard",
        childThreadId,
        origin: "app_owned",
      },
    ]);
    expect(presentation?.title).toBe("Waiting on agent Mobiel dashboard");
    expect(presentation?.items[0]?.noun).toBe("agent");
  });

  it("waits on a subagent for a provider-native child", () => {
    const presentation = presentPendingBackgroundWork([
      {
        taskId: "native",
        kind: "subagent",
        description: "Mobiel dashboard",
        childThreadId,
        origin: "provider_native",
      },
    ]);
    expect(presentation?.title).toBe("Waiting on subagent Mobiel dashboard");
    expect(presentation?.items[0]?.noun).toBe("subagent");
  });

  it("keeps subagent when the origin is unknown", () => {
    const presentation = presentPendingBackgroundWork([
      { taskId: "native", kind: "subagent", description: "Mobiel dashboard" },
    ]);
    expect(presentation?.title).toBe("Waiting on subagent Mobiel dashboard");
  });

  it("names an unnamed worker with its article", () => {
    const presentation = presentPendingBackgroundWork([
      { taskId: "worker", kind: "subagent", origin: "app_owned" },
    ]);
    expect(presentation?.title).toBe("Waiting on an agent");
    expect(presentation?.items[0]?.label).toBe("agent");
  });

  it("counts agents and subagents apart, agents first", () => {
    const presentation = presentPendingBackgroundWork([
      { taskId: "native", kind: "subagent", description: "Explore", origin: "provider_native" },
      { taskId: "worker-1", kind: "subagent", description: "Port", origin: "app_owned" },
      { taskId: "worker-2", kind: "subagent", description: "Review", origin: "app_owned" },
      { taskId: "command", kind: "command", description: "pnpm test" },
    ]);
    expect(presentation?.title).toBe("Waiting on 2 agents, 1 subagent and 1 command");
    expect(presentation?.items.map((item) => item.taskId)).toEqual([
      "worker-1",
      "worker-2",
      "native",
      "command",
    ]);
  });

  it("carries the subagent origin from the turn item into the pending task", () => {
    const tasks = derivePendingBackgroundWork({
      latestRun: { id: RunId.make("run"), ordinal: 1, status: "completed" },
      providerThreads: [],
      turnItems: [
        {
          id: "worker",
          type: "subagent",
          status: "running",
          title: "Mobiel dashboard",
          childThreadId,
          origin: "app_owned",
        },
      ],
    });
    expect(tasks).toEqual([
      {
        taskId: "worker",
        kind: "subagent",
        description: "Mobiel dashboard",
        childThreadId,
        origin: "app_owned",
      },
    ]);
    expect(presentPendingBackgroundWork(tasks)?.title).toBe("Waiting on agent Mobiel dashboard");
  });
});
