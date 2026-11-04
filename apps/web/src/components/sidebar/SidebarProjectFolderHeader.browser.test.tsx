import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { SidebarProjectFolderHeader } from "./SidebarProjectFolderHeader";

const LONG_NAME = "Northwind-warehouse-label-printing-integration";

const GROUP = {
  projectKey: "env:project",
  displayName: LONG_NAME,
  environmentId: "env",
  workspaceRoot: "/projects/northwind",
  projectIcon: { kind: "monogram", text: "NW", color: "purple" },
} as unknown as Parameters<typeof SidebarProjectFolderHeader>[0]["group"];

const HIDDEN = [
  {
    environmentId: "env",
    id: "a",
    runtime: { status: "running" },
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    lastVisitedAt: null,
    updatedAt: "2026-10-01T09:00:00.000Z",
  },
] as unknown as EnvironmentThreadShell[];

const noop = () => {};

async function renderHeader(width: number, collapsed: boolean) {
  await page.viewport(width, 800);
  return render(
    <TooltipProvider delay={150} closeDelay={0}>
      <div data-testid="sidebar" className="w-72 max-w-full bg-sidebar p-2 text-sidebar-foreground">
        <ul className="flex flex-col gap-px">
          <SidebarProjectFolderHeader
            group={GROUP}
            collapsed={collapsed}
            hiddenThreads={collapsed ? HIDDEN : []}
            onToggle={noop}
            onNewThread={noop}
            onContextMenu={noop}
          />
        </ul>
      </div>
    </TooltipProvider>,
  );
}

const folder = () => document.querySelector<HTMLElement>('[data-testid="sidebar-project-folder"]')!;
const nameOf = () => folder().querySelector<HTMLElement>('[data-slot="sidebar-folder-name"]')!;
const newThread = () => folder().querySelector<HTMLElement>("[data-sidebar-action-for]")!;

/** Where the name stops being visible: its box end, or where its right mask turns clear. */
function visibleNameEnd() {
  const name = nameOf();
  const box = name.getBoundingClientRect();
  const style = getComputedStyle(name);
  if (style.maskImage === "none") return box.right;
  const clearFrom = Number.parseFloat(style.getPropertyValue("--tw-mask-right-to-position"));
  expect(clearFrom).toBeGreaterThan(0);
  return box.left + (box.width * clearFrom) / 100;
}

function expectNameEndsBeforeAction() {
  // The name truncates: it is long enough to reach the action.
  expect(nameOf().scrollWidth).toBeGreaterThan(nameOf().clientWidth);
  // macOS fonts render wider than Linux; keep a few pixels of margin.
  expect(visibleNameEnd()).toBeLessThanOrEqual(newThread().getBoundingClientRect().left - 2);
}

describe("boring sidebar project folder header", () => {
  it.each([
    { width: 390, collapsed: false },
    { width: 1280, collapsed: false },
    { width: 390, collapsed: true },
    { width: 1280, collapsed: true },
  ] as const)(
    "at $width px (collapsed: $collapsed) a long name ends before the new-thread action",
    async ({ width, collapsed }) => {
      await using screen = await renderHeader(width, collapsed);
      await expect.element(screen.getByText(LONG_NAME)).toBeVisible();

      // At rest the action is hidden and the name keeps its full width.
      expect(getComputedStyle(newThread().parentElement!).opacity).toBe("0");
      expect(getComputedStyle(nameOf()).maskImage).toBe("none");

      await userEvent.hover(folder());
      expect(getComputedStyle(newThread().parentElement!).opacity).toBe("1");
      await page.screenshot({
        path: `__screenshots__/folder-header-${collapsed ? "collapsed" : "open"}-${width}-hover.png`,
        element: screen.getByTestId("sidebar"),
      });
      expectNameEndsBeforeAction();

      // Keyboard focus on the action shows it without a hover.
      await userEvent.unhover(folder());
      await userEvent.tab();
      await userEvent.tab();
      expect(document.activeElement).toBe(newThread());
      expect(getComputedStyle(newThread().parentElement!).opacity).toBe("1");
      expectNameEndsBeforeAction();
    },
  );
});
