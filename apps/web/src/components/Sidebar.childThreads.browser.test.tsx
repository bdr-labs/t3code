import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { act, render } from "../../test/render";
import { attachSidebarTree } from "../lib/sidebarTree";
import { useEnvironmentScope } from "../state/session";
import { useSidebarChildThreads } from "./Sidebar.childThreads";
import { NestedThreadRow } from "./sidebar/SidebarThreadRow";
import { TooltipProvider } from "./ui/tooltip";

vi.mock("../state/session", { spy: true });

const thread = (
  id: string,
  overrides: {
    readonly openedBy?: string;
    readonly settled?: boolean;
    readonly input?: boolean;
    readonly title?: string;
  } = {},
) =>
  ({
    environmentId: "env",
    id,
    projectId: "project",
    title: overrides.title ?? id,
    archivedAt: null,
    settledOverride: overrides.settled ? "settled" : null,
    settledAt: overrides.settled ? "2026-10-18T00:00:00.000Z" : null,
    snoozedAt: null,
    openedByThreadId: overrides.openedBy,
    hasPendingApprovals: false,
    hasPendingUserInput: overrides.input === true,
    pendingSubagentRequest: null,
    runtime: null,
    // What a real row reads.
    providerInstanceId: "claude",
    modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    latestRun: null,
    latestUserMessageAt: "2026-10-01T09:00:00.000Z",
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    providerInstanceHistory: [],
    goal: null,
    itemCount: 4,
    visibleItemCount: 4,
    createdAt: "2026-10-01T09:00:00.000Z",
    updatedAt: "2026-10-01T09:00:00.000Z",
    unsettledAt: null,
    snoozedUntil: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    pullRequests: [],
  }) as unknown as EnvironmentThreadShell;

const active = [
  thread("head"),
  thread("quiet", { openedBy: "head" }),
  thread("asks", { openedBy: "head", input: true }),
  thread("done", { openedBy: "head", settled: true, title: "Rev #1" }),
  thread("lone"),
  thread("old", { openedBy: "lone", settled: true, title: "W: e2e" }),
];

type RowProps = {
  readonly thread: EnvironmentThreadShell;
  readonly variant: "card" | "slim";
  readonly nested?: boolean;
  readonly sortableId?: string;
};

function Row(props: RowProps) {
  return (
    <li
      data-testid="row"
      data-variant={props.variant}
      data-nested={props.nested === true}
      data-sortable={props.sortableId !== undefined}
    >
      {props.thread.title}
    </li>
  );
}

function Harness(props: { readonly threads?: readonly EnvironmentThreadShell[] }) {
  const threads = props.threads ?? active;
  const childThreads = useSidebarChildThreads({
    threads,
    serverConfigs: new Map<EnvironmentId, EnvironmentServerConfig>(),
    snoozeNow: "2026-10-18T00:00:00.000Z",
    routeThreadKey: null,
    pinnedThreads: [],
    activeThreads: threads,
    visibleWorkingThreads: [],
    visibleSnoozedThreads: [],
    settledThreads: [],
    settledVisibleCount: 10,
    settledPageSize: 25,
    settledShelfExpanded: false,
  });
  return (
    <ul className="w-72 bg-sidebar p-2 text-sidebar-foreground">
      {childThreads.headsOf(threads).flatMap((head) => [
        <Row key={head.id} thread={head} variant="card" sortableId={head.id} />,
        ...childThreads.renderChildren(`env:${head.id}`, "active", {
          dragging: false,
          renderRow: (child) => (
            <Row key={child.id} thread={child} variant="card" sortableId={child.id} />
          ),
          Row,
        }),
      ])}
    </ul>
  );
}

// The theme for one test: `using _theme = theme(...)`.
function theme(name: "light" | "dark"): Disposable {
  document.documentElement.classList.toggle("dark", name === "dark");
  return { [Symbol.dispose]: () => void document.documentElement.classList.remove("dark") };
}

const rows = (container: HTMLElement) =>
  [...container.querySelectorAll<HTMLElement>("[data-testid=row]")].map((row) => ({
    title: row.textContent,
    variant: row.dataset.variant,
    nested: row.dataset.nested,
    sortable: row.dataset.sortable,
  }));

const chips = (disclosure: HTMLElement) =>
  [...disclosure.querySelectorAll<HTMLElement>("[data-testid=sidebar-child-thread-chip]")].map(
    (chip) => `${chip.dataset.kind}:${chip.textContent}`,
  );

it.each(["light", "dark"] as const)(
  "renders a family's chips, nested rows and settled row (%s)",
  async (name) => {
    using _theme = theme(name);
    localStorage.clear();
    await using screen = await render(<Harness />);
    const { container } = screen;

    const families = container.querySelectorAll<HTMLElement>("[data-testid=sidebar-child-threads]");
    expect(families).toHaveLength(2);
    const disclosure = families[0]!.querySelector<HTMLButtonElement>(
      "[data-testid=sidebar-child-threads-disclosure]",
    )!;
    expect(disclosure.getAttribute("aria-expanded")).toBe("true");
    // A chip per kind, needs-you first; expanded, the settled row counts the settled child.
    expect(chips(disclosure)).toEqual(["needs-you:1", "done:1"]);
    expect(disclosure.getAttribute("aria-label")).toBe(
      "Hide 3 child threads of head, 1 needs you, 1 done, 1 settled",
    );
    // Children render as slim, nested rows without the sortable props, needs-you first.
    expect(rows(container)).toEqual([
      { title: "head", variant: "card", nested: "false", sortable: "true" },
      { title: "asks", variant: "slim", nested: "true", sortable: "false" },
      { title: "quiet", variant: "slim", nested: "true", sortable: "false" },
      { title: "lone", variant: "card", nested: "false", sortable: "true" },
    ]);
    const settledRow = families[0]!.querySelector<HTMLButtonElement>(
      "[data-testid=sidebar-child-threads-settled]",
    )!;
    expect(settledRow.textContent).toBe("+1 settled");
    expect(
      [...settledRow.querySelectorAll<HTMLElement>("[data-testid=sidebar-child-thread-role]")].map(
        (icon) => icon.dataset.role,
      ),
    ).toEqual(["review"]);
    expect(families[0]!.className).toContain("after:bottom-4");

    await act(() => settledRow.click());
    expect(settledRow.textContent).toBe("Show less");
    expect(settledRow.getAttribute("aria-expanded")).toBe("true");
    expect(rows(container).map((row) => row.title)).toEqual([
      "head",
      "asks",
      "quiet",
      "Rev #1",
      "lone",
    ]);
    await act(() => settledRow.click());
    expect(settledRow.textContent).toBe("+1 settled");
    expect(rows(container).map((row) => row.title)).toEqual(["head", "asks", "quiet", "lone"]);

    // A family of settled children is just its settled row.
    expect(families[1]!.querySelector("[data-testid=sidebar-child-threads-disclosure]")).toBe(null);
    expect(
      families[1]!.querySelector("[data-testid=sidebar-child-threads-settled]")!.textContent,
    ).toBe("+1 settled");

    // Collapsed, the family keeps only the child that needs the user, and the settled chip.
    await act(() => disclosure.click());
    expect(disclosure.getAttribute("aria-expanded")).toBe("false");
    expect(chips(disclosure)).toEqual(["needs-you:1", "done:1", "settled:1"]);
    expect(families[0]!.querySelector("[data-testid=sidebar-child-threads-settled]")).toBe(null);
    expect(rows(container).map((row) => row.title)).toEqual(["head", "asks", "lone"]);
    expect(localStorage.getItem("t3code:sidebar:collapsed-child-threads")).toContain("env:head");
  },
);

it("keeps every nested row, however deep, slim and out of the sortable list", async () => {
  localStorage.clear();
  await using screen = await render(
    <Harness
      threads={[
        thread("root"),
        thread("child", { openedBy: "root" }),
        thread("grandchild", { openedBy: "child" }),
      ]}
    />,
  );
  expect(rows(screen.container)).toEqual([
    { title: "root", variant: "card", nested: "false", sortable: "true" },
    { title: "child", variant: "slim", nested: "true", sortable: "false" },
    { title: "grandchild", variant: "slim", nested: "true", sortable: "false" },
  ]);
  // Only a top-level head gets the chip row.
  expect(
    screen.container.querySelectorAll("[data-testid=sidebar-child-threads-disclosure]"),
  ).toHaveLength(1);
});

const noop = () => {};

function TreeHarness(props: {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly variant?: "card" | "folder";
  readonly onThreadClick?: (event: { readonly ctrlKey: boolean }, ref: unknown) => void;
  readonly onThreadActivate?: (ref: { readonly threadId: string }) => void;
}) {
  const childThreads = useSidebarChildThreads({
    threads: props.threads,
    serverConfigs: new Map<EnvironmentId, EnvironmentServerConfig>(),
    snoozeNow: "2026-10-18T00:00:00.000Z",
    routeThreadKey: null,
    pinnedThreads: [],
    activeThreads: props.threads,
    visibleWorkingThreads: [],
    visibleSnoozedThreads: [],
    settledThreads: [],
    settledVisibleCount: 10,
    settledPageSize: 25,
    settledShelfExpanded: false,
  });
  const renderRow = (rowThread: EnvironmentThreadShell) => {
    const rowProps = {
      thread: rowThread,
      variant: props.variant ?? "card",
      fold: childThreads.rowFoldOf(`env:${rowThread.id}`),
      variantAction: "settle",
      settlementSupported: true,
      snoozeSupported: true,
      pinningSupported: true,
      isPinned: false,
      dropVerb: null,
      dragOverPinned: false,
      sweepAction: null,
      snoozeWakeLabelText: null,
      wokeAt: null,
      isActive: false,
      isRouteThread: false,
      openPullRequestsInRightPanel: false,
      jumpLabel: null,
      currentEnvironmentId: "env",
      environmentLabel: null,
      environmentMachine: "local",
      scratchMachineLabel: null,
      project: null,
      projectDisplayName: "project",
      providerEntryByInstanceId: new Map(),
      timestampFormat: "locale",
      onThreadClick: props.onThreadClick ?? noop,
      onThreadActivate: props.onThreadActivate ?? noop,
      onStartRename: noop,
      onRenameTitleChange: noop,
      onCommitRename: noop,
      onCancelRename: noop,
      isRenaming: false,
      renamingTitle: "",
      onContextMenu: noop,
      onSettle: noop,
      onActionSweepStart: noop,
      onUnsettle: noop,
      onSnooze: noop,
      onUnsnooze: noop,
      onUnpin: noop,
      onAcknowledgeWoke: noop,
    } as unknown as Parameters<typeof NestedThreadRow>[0];
    return <NestedThreadRow key={rowThread.id} {...rowProps} />;
  };
  return (
    <TooltipProvider delay={150} closeDelay={0}>
      <ul
        ref={attachSidebarTree}
        data-testid="tree"
        className="flex w-72 max-w-full flex-col gap-px bg-sidebar p-2 text-sidebar-foreground"
      >
        {childThreads.headsOf(props.threads).flatMap((head) => [
          renderRow(head),
          ...childThreads.renderChildren(`env:${head.id}`, "active", {
            dragging: false,
            renderRow,
            Row: NestedThreadRow,
          }),
        ])}
      </ul>
    </TooltipProvider>
  );
}

// The last child has children too: its own list draws below its parent's guide line.
const TREE = [
  thread("root"),
  thread("child", { openedBy: "root" }),
  thread("grandchild", { openedBy: "child" }),
  thread("sibling", { openedBy: "root" }),
  thread("nephew", { openedBy: "sibling" }),
  thread("lone"),
];

const treeRow = (id: string) =>
  document.querySelector<HTMLElement>(`[data-sidebar-row="env:${id}"]`);
const treeOrder = () =>
  [...document.querySelectorAll<HTMLElement>("[data-sidebar-row]")].map((row) =>
    row.dataset.sidebarRow?.replace("env:", ""),
  );
const focused = () => document.activeElement?.getAttribute("data-sidebar-row")?.replace("env:", "");
const arrowOf = (id: string) =>
  treeRow(id)!.querySelector<HTMLElement>("[data-testid=sidebar-row-fold-arrow]");
const pressed = async (key: string) => {
  await userEvent.keyboard(`{${key}}`);
  return focused();
};

it("walks a three-level tree: arrows move, Left and Right fold and enter, Enter opens", async () => {
  localStorage.clear();
  vi.mocked(useEnvironmentScope).mockReturnValue(true);
  const onThreadActivate = vi.fn();
  await using _screen = await render(
    <TreeHarness threads={TREE} onThreadActivate={onThreadActivate} />,
  );

  expect(treeOrder()).toEqual(["root", "child", "grandchild", "sibling", "nephew", "lone"]);
  expect(treeRow("child")!.dataset.sidebarParent).toBe("env:root");
  expect(treeRow("grandchild")!.dataset.sidebarParent).toBe("env:child");
  expect(treeRow("nephew")!.dataset.sidebarParent).toBe("env:sibling");
  expect(treeRow("root")!.dataset.sidebarParent).toBeUndefined();
  expect(treeRow("root")!.getAttribute("aria-expanded")).toBe("true");
  expect(treeRow("child")!.getAttribute("aria-expanded")).toBe("true");
  expect(treeRow("grandchild")!.hasAttribute("aria-expanded")).toBe(false);

  treeRow("root")!.focus();
  expect(await pressed("ArrowDown")).toBe("child");
  expect(await pressed("ArrowDown")).toBe("grandchild");
  expect(await pressed("ArrowDown")).toBe("sibling");
  expect(await pressed("ArrowUp")).toBe("grandchild");
  expect(await pressed("End")).toBe("lone");
  expect(await pressed("Home")).toBe("root");

  // Right enters an open row; Left goes to the parent from a row with nothing to close.
  expect(await pressed("ArrowRight")).toBe("child");
  expect(await pressed("ArrowRight")).toBe("grandchild");
  expect(await pressed("ArrowRight")).toBe("grandchild");
  expect(await pressed("ArrowLeft")).toBe("child");

  // Left closes an open row where it stands, then goes up; Right opens it where it stands.
  expect(await pressed("ArrowLeft")).toBe("child");
  expect(treeRow("child")!.getAttribute("aria-expanded")).toBe("false");
  expect(treeRow("grandchild")).toBe(null);
  expect(localStorage.getItem("t3code:sidebar:collapsed-child-threads")).toContain("env:child");
  expect(await pressed("ArrowRight")).toBe("child");
  expect(treeRow("child")!.getAttribute("aria-expanded")).toBe("true");
  expect(treeRow("grandchild")).not.toBe(null);
  expect(await pressed("ArrowLeft")).toBe("child");
  expect(await pressed("ArrowLeft")).toBe("root");

  // None of that opened a thread; Enter does.
  expect(onThreadActivate).not.toHaveBeenCalled();
  await userEvent.keyboard("{Enter}");
  expect(onThreadActivate).toHaveBeenCalledOnce();
  expect(onThreadActivate.mock.calls[0]![0]!.threadId).toBe("root");
});

it("folds by the arrow, opens by the row, and keeps focus and multi-select", async () => {
  localStorage.clear();
  vi.mocked(useEnvironmentScope).mockReturnValue(true);
  const onThreadClick = vi.fn();
  await using _screen = await render(<TreeHarness threads={TREE} onThreadClick={onThreadClick} />);

  // Focus on a row that goes away moves to its parent, not to the body.
  treeRow("grandchild")!.focus();
  expect(arrowOf("child")!.getAttribute("aria-label")).toBe("Hide 1 child thread of child, 1 done");
  await userEvent.click(arrowOf("child")!);
  expect(treeRow("child")!.getAttribute("aria-expanded")).toBe("false");
  expect(arrowOf("child")!.getAttribute("aria-label")).toBe("Show 1 child thread of child, 1 done");
  expect(treeRow("grandchild")).toBe(null);
  await vi.waitFor(() => expect(focused()).toBe("child"));
  expect(onThreadClick).not.toHaveBeenCalled();

  // A person's click on the row opens the thread and leaves its fold alone.
  await userEvent.click(treeRow("child")!);
  expect(onThreadClick).toHaveBeenCalledOnce();
  expect(treeRow("child")!.getAttribute("aria-expanded")).toBe("false");

  // A modified click still reaches the selection handler.
  await userEvent.click(treeRow("sibling")!, { modifiers: ["Control"] });
  expect(onThreadClick).toHaveBeenCalledTimes(2);
  expect(onThreadClick.mock.calls[1]![0]!.ctrlKey).toBe(true);
  expect(treeRow("sibling")!.getAttribute("aria-expanded")).toBe("true");

  await userEvent.click(arrowOf("child")!);
  expect(treeOrder()).toEqual(["root", "child", "grandchild", "sibling", "nephew", "lone"]);
  expect(onThreadClick).toHaveBeenCalledTimes(2);
});

it("folds a family of only settled children with its settled row", async () => {
  localStorage.clear();
  vi.mocked(useEnvironmentScope).mockReturnValue(true);
  await using screen = await render(
    <TreeHarness threads={[thread("root"), thread("old", { openedBy: "root", settled: true })]} />,
  );
  const settledRow = screen.container.querySelector("[data-testid=sidebar-child-threads-settled]")!;
  expect(settledRow.textContent).toBe("+1 settled");
  expect(treeRow("root")!.getAttribute("aria-expanded")).toBe("false");
  treeRow("root")!.focus();
  expect(await pressed("ArrowRight")).toBe("root");
  expect(settledRow.textContent).toBe("Show less");
  expect(treeRow("root")!.getAttribute("aria-expanded")).toBe("true");
  expect(await pressed("ArrowRight")).toBe("old");
  expect(await pressed("ArrowLeft")).toBe("root");
  expect(await pressed("ArrowLeft")).toBe("root");
  expect(settledRow.textContent).toBe("+1 settled");
  expect(treeRow("old")).toBe(null);
});

it.each(["card", "folder"] as const)(
  "renders a thread with no opener and no children as before (%s)",
  async (variant) => {
    localStorage.clear();
    vi.mocked(useEnvironmentScope).mockReturnValue(true);
    await using _screen = await render(
      <TreeHarness threads={[thread("lone")]} variant={variant} />,
    );
    const lone = treeRow("lone")!;
    expect(lone.hasAttribute("aria-expanded")).toBe(false);
    expect(lone.dataset.sidebarParent).toBeUndefined();
    expect(arrowOf("lone")).toBe(null);
    expect(document.querySelector("[data-testid=sidebar-child-threads]")).toBe(null);
  },
);

it("draws an arrow on a top-level row in either sidebar style without moving its columns", async () => {
  localStorage.clear();
  vi.mocked(useEnvironmentScope).mockReturnValue(true);
  for (const variant of ["card", "folder"] as const) {
    await using _screen = await render(
      <TreeHarness
        threads={[thread("plain"), thread("head"), thread("kid", { openedBy: "head" })]}
        variant={variant}
      />,
    );
    const titleLeft = (id: string) =>
      treeRow(id)!.querySelector("[data-slot=sidebar-row-title]")!.getBoundingClientRect().left;
    expect(titleLeft("head")).toBe(titleLeft("plain"));
    expect(arrowOf("head")).not.toBe(null);
    expect(treeRow("head")!.getAttribute("aria-expanded")).toBe("true");
    const arrow = arrowOf("head")!.getBoundingClientRect();
    expect(arrow.left).toBeGreaterThanOrEqual(treeRow("head")!.getBoundingClientRect().left);
  }
});

it("caps the indent and keeps a deep title in view at phone width", async () => {
  localStorage.clear();
  vi.mocked(useEnvironmentScope).mockReturnValue(true);
  await page.viewport(320, 800);
  await using _screen = await render(
    <TreeHarness
      threads={Array.from({ length: 8 }, (_, depth) =>
        thread(`d${depth}`, depth === 0 ? {} : { openedBy: `d${depth - 1}` }),
      )}
    />,
  );
  const startOf = (depth: number) => getComputedStyle(treeRow(`d${depth}`)!).paddingInlineStart;
  expect([1, 2, 3, 4].map(startOf)).toEqual(["24px", "36px", "48px", "60px"]);
  expect([5, 6, 7].map(startOf)).toEqual(["60px", "60px", "60px"]);
  const deepest = treeRow("d7")!;
  const title = deepest.querySelector("[data-slot=sidebar-row-title]")!.getBoundingClientRect();
  expect(title.right).toBeLessThanOrEqual(deepest.getBoundingClientRect().right);
  expect(title.width).toBeGreaterThan(40);
  // A guide line per depth, flat past the cap like the rows.
  const guideOf = (depth: number) =>
    getComputedStyle(
      treeRow(`d${depth}`)!.closest("[data-testid=sidebar-child-threads]")!,
      "::after",
    ).insetInlineStart;
  expect([1, 2, 3, 4, 5].map(guideOf)).toEqual(["8px", "20px", "32px", "44px", "44px"]);
});

it("prunes a nested row's fold once its thread is gone", async () => {
  localStorage.clear();
  vi.mocked(useEnvironmentScope).mockReturnValue(true);
  await using screen = await render(<TreeHarness threads={TREE} />);
  await userEvent.click(arrowOf("child")!);
  expect(localStorage.getItem("t3code:sidebar:collapsed-child-threads")).toContain("env:child");
  await screen.rerender(
    <TreeHarness threads={TREE.filter(({ id }) => id !== "child" && id !== "grandchild")} />,
  );
  await vi.waitFor(() =>
    expect(localStorage.getItem("t3code:sidebar:collapsed-child-threads")).not.toContain(
      "env:child",
    ),
  );
});
