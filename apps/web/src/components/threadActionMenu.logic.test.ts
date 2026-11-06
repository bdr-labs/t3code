import { describe, expect, it } from "vite-plus/test";

import {
  buildDraftActionMenuItems,
  buildThreadActionMenuItems,
  type ThreadActionMenuState,
} from "./threadActionMenu.logic";

const baseState: ThreadActionMenuState = {
  canOperate: true,
  branch: null,
  projectFilter: null,
  isPinned: false,
  isSettled: false,
  autoSettleEnabled: true,
  isSnoozed: false,
  canSnoozeNow: true,
  isRegeneratingTitle: false,
  isRunning: false,
  supports: {
    settlement: true,
    autoSettleOptOut: true,
    snooze: true,
    pinning: true,
    titleRegeneration: true,
  },
  snoozePresets: [
    { id: "hour", label: "In 1 hour", whenLabel: "3:00 PM", snoozedUntil: "2026-08-07T15:00:00Z" },
  ],
};

function ids(state: ThreadActionMenuState): string[] {
  return buildThreadActionMenuItems(state).map((item) => item.id);
}

describe("buildThreadActionMenuItems", () => {
  it("offers hiding and showing child threads only on a family head", () => {
    expect(ids(baseState)).not.toContain("hide-child-threads");
    expect(ids({ ...baseState, childThreads: null })).not.toContain("hide-child-threads");
    const hide = ids({ ...baseState, childThreads: { collapsed: false } });
    expect(hide).toContain("hide-child-threads");
    expect(hide.indexOf("hide-child-threads")).toBe(hide.indexOf("mark-unread") + 1);
    expect(ids({ ...baseState, childThreads: { collapsed: true } })).toContain(
      "show-child-threads",
    );
  });

  it.each([false, true])(
    "disables both lifecycle directions without permission (reversed: %s)",
    (reversed) => {
      const items = buildThreadActionMenuItems({
        ...baseState,
        canOperate: false,
        isPinned: reversed,
        isSettled: reversed,
        isSnoozed: reversed,
      });
      const expected = reversed
        ? [
            "unpin",
            "unsettle",
            "unsnooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ]
        : [
            "pin",
            "settle",
            "snooze",
            "rename",
            "regenerate-title",
            "auto-settle",
            "archive",
            "delete",
          ];
      expect(items.filter((item) => item.disabled).map((item) => item.id)).toEqual(expected);
      expect(
        items.find((item) => item.id === "snooze")?.children?.every((child) => child.disabled) ??
          true,
      ).toBe(true);
    },
  );

  it("disables archive and turning into a project while the thread is running", () => {
    const items = buildThreadActionMenuItems({
      ...baseState,
      isRunning: true,
      canTurnIntoProject: true,
    });
    expect(items.find((item) => item.id === "archive")?.disabled).toBe(true);
    expect(items.find((item) => item.id === "turn-into-project")?.disabled).toBe(true);
  });
});

describe("buildDraftActionMenuItems", () => {
  it("copies the draft's thread even with no path or branch to copy", () => {
    const copy = buildDraftActionMenuItems({
      hasPath: false,
      hasBranch: false,
      hasProject: false,
    }).find((item) => item.id === "copy");

    expect(copy?.disabled).toBeUndefined();
    expect(copy?.children?.map((item) => item.id)).toEqual(["copy-thread", "copy-thread-id"]);
  });
});
