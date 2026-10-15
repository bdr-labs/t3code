import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import type { EnvironmentId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import "~/index.css";

import { act, render } from "../../test/render";
import { useSidebarChildThreads } from "./Sidebar.childThreads";

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

function Harness() {
  const childThreads = useSidebarChildThreads({
    threads: active,
    serverConfigs: new Map<EnvironmentId, EnvironmentServerConfig>(),
    snoozeNow: "2026-10-18T00:00:00.000Z",
    routeThreadKey: null,
    pinnedThreads: [],
    activeThreads: active,
    visibleWorkingThreads: [],
    visibleSnoozedThreads: [],
    settledThreads: [],
    settledVisibleCount: 10,
    settledPageSize: 25,
    settledShelfExpanded: false,
  });
  return (
    <ul className="w-72 bg-sidebar p-2 text-sidebar-foreground">
      {childThreads.headsOf(active).flatMap((head) => [
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
