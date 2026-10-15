import { describe, expect, it } from "vite-plus/test";

import {
  childThreadChipsOf,
  childThreadKindOf,
  childThreadRoleOf,
  childThreadRolesOf,
  foldChildThreadFamily,
  formatChildThreadKindsLabel,
  type ChildThreadKind,
} from "./childThreadSummary.ts";

describe("childThreadKindOf", () => {
  it("puts what needs the user and what still works above settled", () => {
    for (const status of ["approval", "input", "request"] as const) {
      expect(childThreadKindOf({ status, isUnread: false, settled: true })).toBe("needs-you");
    }
    for (const status of ["preparing", "working"] as const) {
      expect(childThreadKindOf({ status, isUnread: false, settled: true })).toBe("working");
    }
  });

  it("counts a settled child as settled whatever it last did", () => {
    expect(childThreadKindOf({ status: "failed", isUnread: true, settled: true })).toBe("settled");
    expect(childThreadKindOf({ status: "ready", isUnread: true, settled: true })).toBe("settled");
  });

  it("tells failed, new and done apart", () => {
    expect(childThreadKindOf({ status: "limited", isUnread: false, settled: false })).toBe(
      "failed",
    );
    expect(childThreadKindOf({ status: "waiting", isUnread: false, settled: false })).toBe(
      "working",
    );
    expect(childThreadKindOf({ status: "ready", isUnread: true, settled: false })).toBe("new");
    expect(childThreadKindOf({ status: "ready", isUnread: false, settled: false })).toBe("done");
  });
});

describe("childThreadChipsOf", () => {
  const kinds: ChildThreadKind[] = ["settled", "done", "working", "needs-you", "settled", "new"];

  it("lists chips in kind order and drops settled while expanded", () => {
    expect(childThreadChipsOf(kinds, { collapsed: false })).toEqual([
      { kind: "needs-you", count: 1 },
      { kind: "new", count: 1 },
      { kind: "working", count: 1 },
      { kind: "done", count: 1 },
    ]);
    expect(childThreadChipsOf(kinds, { collapsed: true }).at(-1)).toEqual({
      kind: "settled",
      count: 2,
    });
  });

  it("summarizes every child", () => {
    expect(formatChildThreadKindsLabel(kinds)).toBe(
      "6 child threads · 1 needs you · 1 new · 1 working · 1 done · 2 settled",
    );
    expect(formatChildThreadKindsLabel(["working"])).toBe("1 child thread · 1 working");
  });
});

describe("foldChildThreadFamily", () => {
  type Child = { readonly id: string; readonly kind: ChildThreadKind };
  const child = (id: string, kind: ChildThreadKind): Child => ({ id, kind });
  const family = [
    child("done", "done"),
    child("old-1", "settled"),
    child("work", "working"),
    child("fail", "failed"),
    child("old-2", "settled"),
    child("asks", "needs-you"),
    child("fresh", "new"),
  ];
  const fold = (
    children: readonly Child[],
    input: { collapsed?: boolean; settledOpen?: boolean; open?: string } = {},
  ) => {
    const result = foldChildThreadFamily(children, {
      kindOf: (item) => item.kind,
      isOpen: (item) => item.id === input.open,
      collapsed: input.collapsed ?? false,
      settledOpen: input.settledOpen ?? false,
    });
    return {
      ...result,
      shown: result.shown.map((item) => item.id),
      settled: result.settled.map((item) => item.id),
      hidden: result.hidden.map((item) => item.id),
    };
  };

  it("shows every live child by kind and keeps settled ones behind one row", () => {
    const result = fold(family);
    expect(result.shown).toEqual(["asks", "fail", "fresh", "work", "done"]);
    expect(result.settled).toEqual(["old-1", "old-2"]);
    expect(result.settledRow).toBe(true);
    expect(result.settledShown).toBe(false);
    expect(result.hidden).toEqual(["old-1", "old-2"]);
    expect(result.chips.map((chip) => chip.kind)).toEqual([
      "needs-you",
      "failed",
      "new",
      "working",
      "done",
    ]);
  });

  it("opens the settled row in place", () => {
    const result = fold(family, { settledOpen: true });
    expect(result.settledShown).toBe(true);
    expect(result.hidden).toEqual([]);
  });

  it("collapsed, keeps only what waits on the user, failed or is open", () => {
    const result = fold(family, { collapsed: true, settledOpen: true, open: "work" });
    expect(result.shown).toEqual(["asks", "fail", "work"]);
    expect(result.settledRow).toBe(false);
    expect(result.settledShown).toBe(false);
    expect(result.chips.at(-1)).toEqual({ kind: "settled", count: 2 });
  });

  it("keeps a settled open thread visible and out of the settled row", () => {
    const result = fold(family, { collapsed: true, open: "old-2" });
    expect(result.shown).toEqual(["asks", "fail", "old-2"]);
    expect(result.settled).toEqual(["old-1"]);
  });

  it("renders a family of settled children as just the settled row", () => {
    const result = fold([child("a", "settled"), child("b", "settled")], { collapsed: true });
    expect(result.disclosure).toBe(false);
    expect(result.chips).toEqual([]);
    expect(result.shown).toEqual([]);
    expect(result.settledRow).toBe(true);
    expect(result.summary).toBe("2 child threads · 2 settled");
  });
});

describe("childThreadRoleOf", () => {
  it("reads the role from the title prefix", () => {
    expect(childThreadRoleOf("Rev #2298")).toBe("review");
    expect(childThreadRoleOf("Review the sidebar")).toBe("review");
    expect(childThreadRoleOf("Rev #2298 herstel")).toBe("fix");
    expect(childThreadRoleOf("Herstelwerk planbord")).toBe("build");
    expect(childThreadRoleOf("fix: flaky test")).toBe("fix");
    expect(childThreadRoleOf("W: verify-skill web")).toBe("worker");
    expect(childThreadRoleOf("S12: migratie")).toBe("step");
    expect(childThreadRoleOf("#2294 annuleren")).toBe("build");
    expect(childThreadRoleOf("Revenue report")).toBe("build");
    expect(childThreadRoleOf("Wire up S1:")).toBe("build");
  });

  it("lists the distinct roles in role order", () => {
    expect(childThreadRolesOf(["#1 a", "W: b", "Rev #1", "Rev #2"])).toEqual([
      "review",
      "worker",
      "build",
    ]);
  });
});
