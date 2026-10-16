import { describe, expect, it } from "vite-plus/test";
import {
  childAgentCountLabel,
  subagentFallbackTitle,
  subagentGroupSummary,
  subagentKindLabel,
} from "./subagentDisplay.js";

describe("subagentKindLabel", () => {
  it("names a delegate_task worker an agent and a provider-native child a subagent", () => {
    expect(subagentKindLabel("app_owned")).toBe("agent");
    expect(subagentKindLabel("provider_native")).toBe("subagent");
  });

  it("names nothing when the origin is unknown", () => {
    expect(subagentKindLabel(undefined)).toBeNull();
  });
});

describe("subagentFallbackTitle", () => {
  it("titles an untitled child by its kind, a subagent when unknown", () => {
    expect(subagentFallbackTitle("app_owned")).toBe("agent");
    expect(subagentFallbackTitle("provider_native")).toBe("subagent");
    expect(subagentFallbackTitle(undefined)).toBe("subagent");
  });
});

describe("childAgentCountLabel", () => {
  it("counts agents and subagents apart", () => {
    expect(childAgentCountLabel(["app_owned"])).toBe("1 agent");
    expect(childAgentCountLabel(["app_owned", "app_owned"])).toBe("2 agents");
    expect(childAgentCountLabel(["provider_native"])).toBe("1 subagent");
    expect(childAgentCountLabel(["app_owned", "provider_native", undefined])).toBe(
      "1 agent and 2 subagents",
    );
    expect(childAgentCountLabel([])).toBe("0 subagents");
  });
});

describe("subagentGroupSummary kind", () => {
  it("counts the group by origin", () => {
    expect(
      subagentGroupSummary([
        { status: "completed", origin: "app_owned" },
        { status: "completed", origin: "app_owned" },
      ]).label,
    ).toBe("Ran 2 agents");
    expect(
      subagentGroupSummary([
        { status: "running", origin: "app_owned" },
        { status: "completed", origin: "provider_native" },
        { status: "completed", origin: "provider_native" },
      ]).label,
    ).toBe("Kicked off 1 agent and 2 subagents");
    expect(subagentGroupSummary([{ status: "completed" }]).label).toBe("Ran 1 subagent");
  });
});
