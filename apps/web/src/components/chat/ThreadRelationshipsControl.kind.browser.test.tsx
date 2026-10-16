import { cloneElement, type ReactElement, type ReactNode } from "react";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { expect, it, vi } from "vite-plus/test";
import "~/index.css";
import { act, render } from "../../../test/render";
const state = vi.hoisted(() => ({
  projection: null as unknown,
  showTooltips: false,
  toast: vi.fn(),
  interrupt: vi.fn(async () => ({ _tag: "Failure" })),
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => vi.fn()) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useThreadProjection: (() => ({ projection: state.projection })) as never,
  useThreadRelationshipShells: (() => []) as never,
  useProjects: (() => []) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentProviders: (() => new Map()) as never,
}));
vi.mock(import("../../lib/archivedThreadsState"), async (original) => ({
  ...(await original()),
  useArchivedThreadSnapshots: (() => ({ snapshots: [] })) as never,
}));
vi.mock(import("../../state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => state.interrupt) as never,
}));
vi.mock(import("../ui/toast"), async (original) => {
  const actual = await original();
  return { ...actual, toastManager: { ...actual.toastManager, add: state.toast } as never };
});
vi.mock(import("../ui/tooltip"), async () => {
  const { cloneElement } = await import("react");
  return {
    Tooltip: (({ children }: { children: ReactNode }) => children) as never,
    TooltipTrigger: (({ render, children }: { render: ReactElement; children: ReactNode }) =>
      cloneElement(render, {}, children)) as never,
    TooltipPopup: (({ children }: { children: ReactNode }) =>
      state.showTooltips ? <span>{children}</span> : null) as never,
  };
});
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";
import { relationshipLabel } from "./ThreadRelationshipsControl.logic";
const agent = (input: { id: string; title: string; origin: "app_owned" | "provider_native" }) => ({
  id: input.id,
  origin: input.origin,
  driver: "claudeAgent",
  providerInstanceId: "claudeAgent",
  childThreadId: `${input.id}-thread`,
  title: input.title,
  prompt: "Work",
  model: null,
  status: "running",
  result: null,
  startedAt: DateTime.makeUnsafe("2026-10-16T12:00:00Z"),
  completedAt: null,
  updatedAt: DateTime.makeUnsafe("2026-10-16T12:00:00Z"),
});
// Joins the rendered text nodes with spaces, as a reader moving through the rows hears them.
function text(container: HTMLElement) {
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const parts: string[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    parts.push(node.textContent ?? "");
  }
  return parts.join(" ").replace(/\s+/g, " ").trim();
}
const byLabel = (container: HTMLElement, label: string) =>
  [...container.querySelectorAll("button")].filter(
    (button) => button.getAttribute("aria-label") === label,
  );
it("names a delegate_task worker an agent and a provider-native child a subagent", async () => {
  state.projection = {
    thread: { id: "parent", lineage: { relationshipToParent: null }, activeProviderThreadId: null },
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [
      agent({ id: "worker", title: "Port the patches", origin: "app_owned" }),
      agent({ id: "native", title: "Explore the sidebar", origin: "provider_native" }),
    ],
  };
  const panel = (
    <ThreadRelationshipsPanel
      environmentId={EnvironmentId.make("test")}
      threadId={ThreadId.make("parent")}
      showLineage
      showSideChats
    />
  );
  state.showTooltips = false;
  await using screen = await render(panel);
  const { container } = screen;
  expect(text(container)).toContain("Port the patches agent");
  expect(text(container)).toContain("Explore the sidebar subagent");
  state.showTooltips = true;
  await screen.rerender(cloneElement(panel));
  expect(text(container)).toMatch(/running · agent/);
  expect(text(container)).toMatch(/running · subagent/);
});
it("labels the relationship by the child's kind, lowercase", () => {
  const current = ThreadId.make("parent");
  const child = { sourceThreadId: current, targetThreadId: ThreadId.make("child") };
  const edge = { ...child, kind: "subagent" as const, status: null };
  const lineage = {
    parentThreadId: current,
    relationshipToParent: "subagent" as const,
    rootThreadId: current,
  };
  expect(relationshipLabel(edge, current, { origin: "app_owned" })).toBe("agent");
  expect(relationshipLabel(edge, current, { origin: "provider_native" })).toBe("subagent");
  expect(relationshipLabel(edge, current, { thread: { lineage, creationSource: "mcp" } })).toBe(
    "agent",
  );
  expect(
    relationshipLabel(edge, current, { thread: { lineage, creationSource: "provider" } }),
  ).toBe("subagent");
  expect(relationshipLabel(edge, current)).toBe("subagent");
  expect(relationshipLabel(edge, ThreadId.make("child"))).toBe("parent agent");
});
it("stops a delegate_task worker as an agent and a provider-native child as a subagent", async () => {
  state.projection = {
    thread: { id: "parent", lineage: { relationshipToParent: null }, activeProviderThreadId: null },
    runs: [],
    providerThreads: [],
    providerSessions: [],
    contextTransfers: [],
    subagents: [
      agent({ id: "worker", title: "Port the patches", origin: "app_owned" }),
      {
        ...agent({ id: "native", title: "Explore the sidebar", origin: "provider_native" }),
        threadId: "parent",
        runId: "run-1",
        nativeStatus: "running",
        nativeTaskRef: { strength: "strong", nativeId: "task-1" },
      },
    ],
  };
  state.showTooltips = true;
  await using screen = await render(
    <ThreadRelationshipsPanel
      environmentId={EnvironmentId.make("test")}
      threadId={ThreadId.make("parent")}
      showLineage
      showSideChats
    />,
  );
  const { container } = screen;
  const [stop] = byLabel(container, "Stop agent Port the patches");
  expect(stop).toBeDefined();
  expect(byLabel(container, "Stop subagent Explore the sidebar")).not.toHaveLength(0);
  expect(text(container)).toMatch(/Explore the sidebar.*Stop subagent Port the patches.*Stop agent$/);
  await act(async () => stop!.click());
  expect(state.toast).toHaveBeenCalledWith({ type: "error", title: "Could not stop agent" });
});
