import { type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { EnvironmentId, type OrchestrationV2TurnItem } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";

vi.mock("@effect/atom-react", () => ({
  useAtomValue: (_atom: unknown, select?: (value: undefined) => unknown) =>
    select ? select(undefined) : undefined,
}));
vi.mock("../../state/threads", () => ({
  environmentThreadDetails: { threadAtom: () => null },
}));
vi.mock("../../state/entities", () => ({
  useThreadShell: () => undefined,
  useProject: () => undefined,
}));
vi.mock("../../state/environments", () => ({
  useEnvironment: () => null,
}));
vi.mock("../ui/tooltip", () => ({
  Tooltip: ({ children }: { children: ReactNode }) => children,
  TooltipTrigger: ({ render }: { render: ReactNode }) => render,
  TooltipPopup: () => null,
}));

import { V2LifecycleRow } from "./V2LifecycleRow";

const subagentItem = (
  origin: "app_owned" | "provider_native",
  overrides: Record<string, unknown> = {},
) =>
  ({
    type: "subagent",
    id: `item-${origin}`,
    threadId: "parent",
    subagentId: `agent-${origin}`,
    origin,
    driver: "claudeAgent",
    providerInstanceId: "claudeAgent",
    childThreadId: `child-${origin}`,
    title: "Onbeheerde updates",
    status: "running",
    result: null,
    startedAt: null,
    completedAt: null,
    ...overrides,
  }) as unknown as OrchestrationV2TurnItem;

const render = (item: OrchestrationV2TurnItem) =>
  renderToStaticMarkup(
    <V2LifecycleRow
      item={item}
      environmentId={EnvironmentId.make("test")}
      runs={[]}
      onOpenThread={() => {}}
    />,
  ).replace(/<[^>]+>/g, " ");

describe("subagent timeline card", () => {
  it("prefixes the status with agent for a delegate_task worker", () => {
    const html = render(subagentItem("app_owned"));
    expect(html).toMatch(/(^|\s)agent · Running/);
    expect(html).not.toContain("subagent");
  });

  it("prefixes the status with subagent for a provider-native child", () => {
    expect(render(subagentItem("provider_native"))).toContain("subagent · Running");
  });

  it("keeps the kind beside the title when a completed card shows its result", () => {
    const html = render(subagentItem("app_owned", { status: "completed", result: "All done" }));
    expect(html).toMatch(/(^|\s)agent(\s|$)/);
    expect(html).toContain("All done");
    expect(html).not.toContain("Completed");
  });

  it("titles an untitled card by its kind", () => {
    expect(render(subagentItem("app_owned", { title: null }))).toMatch(
      /(^|\s)agent\s+agent · Running/,
    );
    expect(render(subagentItem("provider_native", { title: null }))).toMatch(
      /(^|\s)subagent\s+subagent · Running/,
    );
  });
});
