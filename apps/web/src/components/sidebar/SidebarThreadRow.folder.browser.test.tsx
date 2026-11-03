import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { useEnvironmentScope } from "../../state/session";
import { TooltipProvider } from "../ui/tooltip";
import { SidebarProjectFolderHeader } from "./SidebarProjectFolderHeader";
import { NestedThreadRow } from "./SidebarThreadRow";

vi.mock("../../state/session", { spy: true });

// Fixed past dates: the rows age them against the real clock, so ages are only
// asserted by unit.

function shell(
  id: string,
  title: string,
  runtime: "running" | "idle" | null,
  updatedAt = "2026-10-01T09:00:00.000Z",
): EnvironmentThreadShell {
  return {
    environmentId: "env",
    id,
    projectId: "project",
    title,
    providerInstanceId: "claude",
    modelSelection: { instanceId: "claude", model: "claude-opus-5-5" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "main",
    worktreePath: null,
    latestRun: null,
    runtime: runtime === null ? null : { status: runtime },
    latestUserMessageAt: updatedAt,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    pendingSubagentRequest: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    providerInstanceHistory: [],
    goal: null,
    itemCount: 4,
    visibleItemCount: 4,
    createdAt: updatedAt,
    updatedAt: updatedAt,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    unsettledAt: null,
    snoozedUntil: null,
    snoozedAt: null,
    pinnedAt: null,
    pinOrderKey: null,
    activeOrderKey: null,
    pullRequests: [],
  } as unknown as EnvironmentThreadShell;
}

const THREADS = [
  shell("a", "Werkbon werkdatum tonen op planbord en in de app", "idle"),
  shell("b", "Uren toevoegen aan werkbon via MCP, ook voor monteurs", null),
  shell("c", "Subthreads overzichtelijker maken in de zijbalk", "running"),
  // The widest age label.
  shell("d", "Printfouten: lege labels, dubbele prints", null, "2025-01-01T09:00:00.000Z"),
];

const noop = () => {};

function rowProps(thread: EnvironmentThreadShell, variant: "folder" | "folder-multiline") {
  return {
    thread,
    variant,
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
    projectDisplayName: "timvdhoorn/LMManagement",
    providerEntryByInstanceId: new Map(),
    timestampFormat: "locale",
    onThreadClick: noop,
    onThreadActivate: noop,
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
}

const GROUP = {
  projectKey: "env:project",
  displayName: "timvdhoorn/LMManagement",
  environmentId: "env",
  workspaceRoot: "/projects/lmm",
  projectIcon: { kind: "monogram", text: "LM", color: "blue" },
} as unknown as Parameters<typeof SidebarProjectFolderHeader>[0]["group"];

async function renderFolder(variant: "folder" | "folder-multiline", width: number) {
  vi.mocked(useEnvironmentScope).mockReturnValue(true);
  await page.viewport(width, 800);
  return render(
    <TooltipProvider delay={150} closeDelay={0}>
      <div data-testid="sidebar" className="w-72 max-w-full bg-sidebar p-2 text-sidebar-foreground">
        <ul className="flex flex-col gap-px">
          <SidebarProjectFolderHeader
            group={GROUP}
            collapsed={false}
            hiddenThreads={[]}
            onToggle={noop}
            onNewThread={noop}
            onContextMenu={noop}
          />
          {THREADS.map((thread) => (
            <NestedThreadRow key={thread.id} {...rowProps(thread, variant)} />
          ))}
        </ul>
      </div>
    </TooltipProvider>,
  );
}

const rect = (element: Element) => element.getBoundingClientRect();
const GUTTER = '[data-slot="sidebar-row-gutter"]';
const TITLE = '[data-slot="sidebar-row-title"]';
const rows = () => [...document.querySelectorAll('[data-testid="sidebar-row-folder"]')];
const centerX = (box: DOMRect) => box.left + box.width / 2;

describe("boring sidebar rows", () => {
  it.each([
    { variant: "folder", width: 390 },
    { variant: "folder", width: 1280 },
    { variant: "folder-multiline", width: 390 },
    { variant: "folder-multiline", width: 1280 },
  ] as const)(
    "$variant at $width px: status sits in a gutter indented past the project icon",
    async ({ variant, width }) => {
      await using screen = await renderFolder(variant, width);
      const favicon = document.querySelector(
        '[data-testid="sidebar-project-folder"] button',
      )!.firstElementChild!;
      const [waiting, aged, working, old] = rows();

      // The status word left the row; the aria-label still carries it.
      expect(working!.textContent).not.toContain("Working");
      expect(working!.getAttribute("aria-label")).toContain("Working");
      expect(waiting!.textContent).not.toContain("Waiting");
      // Without a status the gutter shows the age.
      expect(aged!.querySelector(GUTTER)!.textContent).toMatch(/^\d+d$/);
      // The widest age still fits the gutter.
      const oldGutter = old!.querySelector(GUTTER)!;
      expect(oldGutter.textContent).toMatch(/^\d{3,}d$/);
      expect(oldGutter.scrollWidth).toBeLessThanOrEqual(oldGutter.clientWidth);
      for (const row of [waiting!, aged!, working!, old!]) {
        const title = row.querySelector(TITLE);
        const gutter = row.querySelector(GUTTER);
        // The gutter sits one indent step (12px) right of the project icon.
        expect(Math.abs(centerX(rect(gutter!)) - centerX(rect(favicon)) - 12)).toBeLessThanOrEqual(1);
        // The title starts right after the gutter and runs to the row's edge.
        expect(rect(title!).left - rect(gutter!).right).toBeLessThanOrEqual(4);
        expect(rect(title!).left - rect(favicon).right).toBeGreaterThanOrEqual(18);
        expect(rect(title!).left - rect(favicon).right).toBeLessThanOrEqual(26);
        expect(rect(row).right - rect(title!).right).toBeLessThanOrEqual(16);
        if (variant === "folder-multiline") {
          const meta = row.lastElementChild!.firstElementChild!;
          expect(Math.abs(rect(meta).left - rect(title!).left)).toBeLessThanOrEqual(1);
        }
      }

      await expect.element(screen.getByTestId("sidebar")).toBeVisible();
      await page.screenshot({
        path: `__screenshots__/boring-${variant}-${width}.png`,
        element: screen.getByTestId("sidebar"),
      });
    },
  );

  it("shows snooze next to settle on hover and keyboard focus", async () => {
    await using screen = await renderFolder("folder", 1280);
    const row = rows()[1]!;
    const snooze = screen.getByRole("button", { name: "Snooze thread" }).nth(1);
    const settle = screen.getByRole("button", { name: "Settle thread" }).nth(1);
    expect(screen.getByRole("button", { name: "Snooze thread" }).all()).toHaveLength(4);
    expect(getComputedStyle(snooze.element()).opacity).toBe("1");
    const actions = snooze.element().parentElement!;
    expect(getComputedStyle(actions).opacity).toBe("0");

    const title = row.querySelector(TITLE)!;
    const titleBefore = rect(title);
    await userEvent.hover(row);
    await expect.poll(() => getComputedStyle(actions).opacity).toBe("1");
    // The actions overlay the title's faded end; the title keeps its width.
    expect(rect(title).width).toBe(titleBefore.width);
    expect(getComputedStyle(title).maskImage).toContain("linear-gradient");
    // The title is fully clear under the actions.
    const clearFrom = rect(title).left + rect(title).width * 0.8;
    expect(clearFrom).toBeLessThanOrEqual(rect(snooze.element()).left);
    expect(rect(snooze.element()).right).toBeLessThanOrEqual(rect(settle.element()).left + 1);
    await page.screenshot({
      path: "__screenshots__/boring-folder-hover.png",
      element: screen.getByTestId("sidebar"),
    });
    await userEvent.unhover(row);

    (row as HTMLElement).focus();
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(snooze.element());
    await expect.poll(() => getComputedStyle(actions).opacity).toBe("1");
    await userEvent.keyboard("{Tab}");
    expect(document.activeElement).toBe(settle.element());

    await userEvent.keyboard("{Shift>}{Tab}{/Shift}");
    await userEvent.keyboard("{Enter}");
    await expect.element(page.getByRole("menuitem", { name: "Custom…" })).toBeVisible();
    // With the menu open the actions stay up without hover or focus.
    expect(row.matches(":hover")).toBe(false);
    expect(actions.contains(document.activeElement)).toBe(false);
    expect(getComputedStyle(actions).opacity).toBe("1");
    await userEvent.keyboard("{Escape}");
  });
});
