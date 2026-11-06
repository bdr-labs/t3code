import { describe, expect, it } from "vite-plus/test";
import {
  buildSidebarThreadFamilies,
  childThreadFoldHeadStateOf,
  childThreadNeedsUser,
  childThreadStillRuns,
  flattenSidebarThreadFamilies,
  flattenSidebarThreadNodes,
  foldSidebarThreadFamily,
  formatChildThreadsDisclosureLabel,
  formatChildThreadsLabel,
  isChildThreadFamilyCollapsed,
  pageSidebarThreadFamilies,
  placeChildThreadSections,
  placeDelegatedChildThreads,
  placeSettledChildThreads,
  pruneChildThreadFolds,
  settledEntryOf,
  toggleChildThreadFamily,
  type ChildThreadFolds,
  type SidebarThreadNode,
} from "./Sidebar.families";

interface Row {
  readonly key: string;
  readonly openedBy: string | null;
  readonly running?: boolean;
}

const row = (key: string, openedBy: string | null = null): Row => ({ key, openedBy });
const families = (rows: readonly Row[]) =>
  buildSidebarThreadFamilies(
    rows,
    (thread) => thread.key,
    (thread) => thread.openedBy,
  ).map((family) => [
    family.head.key,
    flattenSidebarThreadNodes(family.children).map((child) => child.key),
  ]);

describe("buildSidebarThreadFamilies", () => {
  it("puts children after their head in section order", () => {
    expect(families([row("c1", "p"), row("x"), row("p"), row("c2", "p")])).toEqual([
      ["x", []],
      ["p", ["c1", "c2"]],
    ]);
  });

  it("keeps a child on its own when its opener is not in the section", () => {
    expect(families([row("child", "settled-parent"), row("other")])).toEqual([
      ["child", []],
      ["other", []],
    ]);
  });

  it("nests a thread under its own opener, as deep as the chain goes", () => {
    const shape = (nodes: readonly SidebarThreadNode<Row>[]): unknown[] =>
      nodes.map((node) => [node.thread.key, node.depth, shape(node.children)]);
    const built = buildSidebarThreadFamilies(
      [
        row("grandchild", "child"),
        row("root"),
        row("child", "root"),
        row("sibling", "root"),
        row("great", "grandchild"),
      ],
      (thread) => thread.key,
      (thread) => thread.openedBy,
    );
    expect(built.map((family) => family.head.key)).toEqual(["root"]);
    expect(shape(built[0]!.children)).toEqual([
      ["child", 1, [["grandchild", 2, [["great", 3, []]]]]],
      ["sibling", 1, []],
    ]);
  });

  it.each([
    ["an opener cycle", [row("a", "b"), row("b", "a")]],
    ["a thread opened from inside a cycle", [row("a", "b"), row("b", "a"), row("c", "a")]],
    ["a thread opened by itself", [row("a", "a"), row("b", "a")]],
    ["a dangling opener", [row("a", "gone"), row("b", "a")]],
    ["an opener in another section", [row("a", "elsewhere"), row("b", "a"), row("c", "b")]],
    [
      "a chain past the depth limit",
      Array.from({ length: 40 }, (_, index) => row(`t${index}`, index ? `t${index - 1}` : null)),
    ],
  ])("shows every row exactly once with %s", (_name, rows) => {
    const built = buildSidebarThreadFamilies(
      rows,
      (thread) => thread.key,
      (thread) => thread.openedBy,
    );
    expect(
      flattenSidebarThreadFamilies(built)
        .map((thread) => thread.key)
        .toSorted(),
    ).toEqual(rows.map((thread) => thread.key).toSorted());
  });

  it("stops at the topmost ancestor that is in the section", () => {
    // The root sits in another section, so the child heads its own family.
    expect(families([row("child", "root"), row("grandchild", "child")])).toEqual([
      ["child", ["grandchild"]],
    ]);
  });

  it("leaves threads in an opener cycle on their own", () => {
    expect(families([row("a", "b"), row("b", "a"), row("c", "a")])).toEqual([
      ["a", []],
      ["b", []],
      ["c", []],
    ]);
  });

  it("flattens families back to render order", () => {
    const built = buildSidebarThreadFamilies(
      [row("c", "p"), row("p"), row("x")],
      (thread) => thread.key,
      (thread) => thread.openedBy,
    );
    expect(flattenSidebarThreadFamilies(built).map((thread) => thread.key)).toEqual([
      "p",
      "c",
      "x",
    ]);
  });
});

describe("placeSettledChildThreads", () => {
  const place = (settled: readonly Row[], live: Record<string, "active" | "working">) => {
    const placed = placeSettledChildThreads(
      settled,
      (thread) => thread.key,
      (thread) => thread.openedBy,
      (key) => live[key] ?? null,
    );
    return {
      settled: placed.settled.map((thread) => thread.key),
      moved: placed.moved.map(({ thread, section }) => [thread.key, section]),
    };
  };

  it("keeps settled children with an opener that is not settled", () => {
    // Whoever settled them (agent, auto-settle or the user), finished or not.
    expect(
      place([row("done", "parent"), { ...row("busy", "parent"), running: true }, row("old")], {
        parent: "working",
      }),
    ).toEqual({
      settled: ["old"],
      moved: [
        ["done", "working"],
        ["busy", "working"],
      ],
    });
  });

  it("follows settled openers up to the live root", () => {
    expect(place([row("child", "root"), row("grandchild", "child")], { root: "active" })).toEqual({
      settled: [],
      moved: [
        ["child", "active"],
        ["grandchild", "active"],
      ],
    });
  });

  it("keeps a family in Settled when its opener settled too", () => {
    expect(place([row("child", "parent"), row("parent"), row("orphan", "gone")], {})).toEqual({
      settled: ["child", "parent", "orphan"],
      moved: [],
    });
  });

  it("stops on an opener cycle", () => {
    expect(place([row("a", "b"), row("b", "a")], {})).toEqual({
      settled: ["a", "b"],
      moved: [],
    });
  });
});

describe("placeDelegatedChildThreads", () => {
  const place = (
    delegated: readonly { key: string; by: string }[],
    sections: Record<string, string>,
  ) => {
    const result = placeDelegatedChildThreads(
      delegated,
      (thread) => thread.key,
      (thread) => thread.by,
      (key) => sections[key] ?? null,
    );
    return {
      placed: result.placed.map(({ thread, section }) => [thread.key, section]),
      hidden: result.hidden.map((thread) => thread.key),
    };
  };

  it("puts a delegated child in its delegator's section, whatever its own state", () => {
    expect(place([{ key: "worker", by: "orchestrator" }], { orchestrator: "settled" })).toEqual({
      placed: [["worker", "settled"]],
      hidden: [],
    });
  });

  it("follows delegated ancestors up to the shown thread", () => {
    expect(
      place(
        [
          { key: "reviewer", by: "worker" },
          { key: "worker", by: "orchestrator" },
        ],
        { orchestrator: "active" },
      ),
    ).toEqual({
      placed: [
        ["reviewer", "active"],
        ["worker", "active"],
      ],
      hidden: [],
    });
  });

  it("hides a child whose delegator is not shown, and survives cycles", () => {
    expect(
      place(
        [
          { key: "orphan", by: "archived" },
          { key: "a", by: "b" },
          { key: "b", by: "a" },
        ],
        {},
      ),
    ).toEqual({ placed: [], hidden: ["orphan", "a", "b"] });
  });
});

describe("foldSidebarThreadFamily", () => {
  const children = [row("working"), row("asks"), row("open")];
  const keepVisible = (thread: Row) => thread.key === "asks" || thread.key === "open";
  const keys = (rows: readonly Row[]) => rows.map((thread) => thread.key);

  it("shows every child while the family is open", () => {
    expect(foldSidebarThreadFamily(children, { collapsed: false, keepVisible })).toEqual({
      shown: children,
      hidden: [],
      settled: [],
    });
  });

  it("keeps only children that need the user or are open when collapsed", () => {
    const folded = foldSidebarThreadFamily(children, { collapsed: true, keepVisible });
    expect(keys(folded.shown)).toEqual(["asks", "open"]);
    expect(keys(folded.hidden)).toEqual(["working"]);
    expect(folded.settled).toEqual([]);
  });

  it("folds settled children behind their own row in an open family", () => {
    const family = [row("live"), row("done"), row("open"), row("old")];
    const isSettled = (thread: Row) => thread.key !== "live";
    const keepOpen = (thread: Row) => thread.key === "open";
    const closed = foldSidebarThreadFamily(family, {
      collapsed: false,
      keepVisible: keepOpen,
      isSettled,
    });
    // The open thread stays in view even when it is settled.
    expect(keys(closed.shown)).toEqual(["live", "open"]);
    expect(keys(closed.settled)).toEqual(["done", "old"]);
    expect(keys(closed.hidden)).toEqual(["done", "old"]);
    const opened = foldSidebarThreadFamily(family, {
      collapsed: false,
      keepVisible: keepOpen,
      isSettled,
      settledShown: true,
    });
    expect(keys(opened.settled)).toEqual(["done", "old"]);
    expect(opened.hidden).toEqual([]);
    // Collapsed, settled children hide with the rest and get no row of their own.
    const collapsed = foldSidebarThreadFamily(family, {
      collapsed: true,
      keepVisible: keepOpen,
      isSettled,
      settledShown: true,
    });
    expect(keys(collapsed.shown)).toEqual(["open"]);
    expect(collapsed.settled).toEqual([]);
  });

  it("treats approvals and questions as needing the user, not working", () => {
    expect(childThreadNeedsUser("approval")).toBe(true);
    expect(childThreadNeedsUser("input")).toBe(true);
    expect(childThreadNeedsUser("working")).toBe(false);
    expect(childThreadNeedsUser("ready")).toBe(false);
  });
});

describe("child thread folds", () => {
  const none: ChildThreadFolds = { collapsed: [], expandedInSettled: [] };
  const live = { section: "live", headKey: "env:p" } as const;
  const settled = (entry: string) => ({ section: "settled", headKey: "env:p", entry }) as const;

  it("opens families outside Settled and folds them in Settled by default", () => {
    expect(isChildThreadFamilyCollapsed(none, live)).toBe(false);
    expect(isChildThreadFamilyCollapsed(none, settled("2026-10-16T10:00:00.000Z"))).toBe(true);
    expect(isChildThreadFamilyCollapsed(none, settled(""))).toBe(true);
  });

  it("toggles a live family both ways", () => {
    const collapsed = toggleChildThreadFamily(none, live);
    expect(collapsed).toEqual({ collapsed: ["env:p"], expandedInSettled: [] });
    expect(isChildThreadFamilyCollapsed(collapsed, live)).toBe(true);
    expect(toggleChildThreadFamily(collapsed, live)).toEqual(none);
  });

  it("keeps a Settled expansion until the family settles again", () => {
    const first = settled("2026-10-16T10:00:00.000Z");
    const expanded = toggleChildThreadFamily(none, first);
    expect(isChildThreadFamilyCollapsed(expanded, first)).toBe(false);
    // Leaving Settled restores the live default...
    expect(isChildThreadFamilyCollapsed(expanded, live)).toBe(false);
    // ...and re-entering it is a new settle, so the family folds again.
    const second = settled("2026-10-16T12:00:00.000Z");
    expect(isChildThreadFamilyCollapsed(expanded, second)).toBe(true);
    // Expanding the new settle drops the old entry.
    expect(toggleChildThreadFamily(expanded, second).expandedInSettled).toEqual([
      "env:p@2026-10-16T12:00:00.000Z",
    ]);
    expect(toggleChildThreadFamily(expanded, first)).toEqual(none);
  });

  it("restores a live collapse after a trip through Settled", () => {
    const collapsed = toggleChildThreadFamily(none, live);
    const expandedInSettled = toggleChildThreadFamily(collapsed, settled("t1"));
    expect(isChildThreadFamilyCollapsed(expandedInSettled, settled("t1"))).toBe(false);
    expect(isChildThreadFamilyCollapsed(expandedInSettled, live)).toBe(true);
  });

  it("only touches its own family", () => {
    const other = { section: "settled", headKey: "env:p2", entry: "t1" } as const;
    const folds = toggleChildThreadFamily(toggleChildThreadFamily(none, settled("t1")), other);
    expect(folds.expandedInSettled).toEqual(["env:p@t1", "env:p2@t1"]);
    expect(isChildThreadFamilyCollapsed(folds, settled("t1"))).toBe(false);
  });
});

describe("settled entries", () => {
  const none: ChildThreadFolds = { collapsed: [], expandedInSettled: [] };
  const settledAt = "2026-10-16T10:00:00.000Z";

  it("folds a family again when its opener wakes from a snooze back into Settled", () => {
    // Snoozing keeps settledAt; only snoozedAt tells the stays apart.
    const before = { settledAt, snoozedAt: null, lastSnoozeWakeAt: null };
    const afterWake = {
      settledAt,
      snoozedAt: "2026-10-16T11:00:00.000Z",
      lastSnoozeWakeAt: null,
    };
    const place = (entry: string) => ({ section: "settled", headKey: "env:p", entry }) as const;
    const expanded = toggleChildThreadFamily(none, place(settledEntryOf(before)));
    expect(isChildThreadFamilyCollapsed(expanded, place(settledEntryOf(before)))).toBe(false);
    expect(isChildThreadFamilyCollapsed(expanded, place(settledEntryOf(afterWake)))).toBe(true);
  });

  it("folds a family again after a snooze and wake this client never saw", () => {
    // Expanded before the snooze; snoozed and woken by hand on another device
    // while this client was closed. The wake clears snoozedAt but stamps
    // lastSnoozeWakeAt, and settledAt never changed.
    const before = { settledAt, snoozedAt: null, lastSnoozeWakeAt: null };
    const afterUnseenWake = {
      settledAt,
      snoozedAt: null,
      lastSnoozeWakeAt: "2026-10-16T12:00:00.000Z",
    };
    const place = (entry: string) => ({ section: "settled", headKey: "env:p", entry }) as const;
    const expanded = toggleChildThreadFamily(none, place(settledEntryOf(before)));
    expect(isChildThreadFamilyCollapsed(expanded, place(settledEntryOf(afterUnseenWake)))).toBe(
      true,
    );
  });

  it("folds a family again after an automatic wake, which keeps snoozedAt", () => {
    // A snooze that runs out is not cleared on the server: snoozedUntil
    // passes and snoozedAt stays, so the stay differs from the one before.
    const before = { settledAt, snoozedAt: null, lastSnoozeWakeAt: null };
    const afterTimedWake = {
      settledAt,
      snoozedAt: "2026-10-16T11:00:00.000Z",
      lastSnoozeWakeAt: null,
    };
    const place = (entry: string) => ({ section: "settled", headKey: "env:p", entry }) as const;
    const expanded = toggleChildThreadFamily(none, place(settledEntryOf(before)));
    expect(isChildThreadFamilyCollapsed(expanded, place(settledEntryOf(afterTimedWake)))).toBe(
      true,
    );
  });

  it("keeps an expansion while the head stays in the same Settled stay", () => {
    const head = { settledAt, snoozedAt: null, lastSnoozeWakeAt: "2026-10-15T08:00:00.000Z" };
    const place = (entry: string) => ({ section: "settled", headKey: "env:p", entry }) as const;
    const expanded = toggleChildThreadFamily(none, place(settledEntryOf(head)));
    // A re-render builds the entry from an equal but new shell object.
    expect(isChildThreadFamilyCollapsed(expanded, place(settledEntryOf({ ...head })))).toBe(false);
  });

  it("drops a Settled expansion once its head is outside Settled", () => {
    const entry = settledEntryOf({ settledAt, snoozedAt: null, lastSnoozeWakeAt: null });
    const folds: ChildThreadFolds = {
      collapsed: ["env:live", "env:gone", "other:far"],
      expandedInSettled: [
        `env:settled@${entry}`,
        `env:snoozed@${entry}`,
        `env:gone@${entry}`,
        `other:far@${entry}`,
      ],
    };
    const where = {
      "env:live": "elsewhere",
      "env:settled": "settled",
      "env:snoozed": "elsewhere",
      "env:gone": "gone",
    } as const;
    const pruned = pruneChildThreadFolds(
      folds,
      (key) => where[key as keyof typeof where] ?? "unknown",
    );
    // A snoozed head comes back folded; an unloaded environment keeps its folds.
    expect(pruned).toEqual({
      collapsed: ["env:live", "other:far"],
      expandedInSettled: [`env:settled@${entry}`, `other:far@${entry}`],
    });
    expect(
      pruneChildThreadFolds(pruned, (key) => where[key as keyof typeof where] ?? "unknown"),
    ).toBe(pruned);
    const onlySettled = pruneChildThreadFolds(
      { collapsed: ["env:live"], expandedInSettled: [`env:snoozed@${entry}`] },
      (key) => where[key as keyof typeof where] ?? "unknown",
    );
    expect(onlySettled.expandedInSettled).toEqual([]);
  });

  it("keeps every Settled expansion however many there are", () => {
    let folds = none;
    for (let index = 0; index < 250; index += 1) {
      folds = toggleChildThreadFamily(folds, {
        section: "settled",
        headKey: `env:p${index}`,
        entry: "t1",
      });
    }
    expect(
      isChildThreadFamilyCollapsed(folds, { section: "settled", headKey: "env:p0", entry: "t1" }),
    ).toBe(false);
  });
});

describe("childThreadFoldHeadStateOf", () => {
  it("judges heads by their own state and skips environments not loaded", () => {
    const shell = (id: string, settled: boolean) => ({ environmentId: "env", id, settled });
    const stateOf = childThreadFoldHeadStateOf(
      [shell("a", true), shell("b", false)],
      (thread) => `${thread.environmentId}:${thread.id}`,
      (thread) => thread.settled,
    );
    expect(["env:a", "env:b", "env:c", "other:a"].map(stateOf)).toEqual([
      "settled",
      "elsewhere",
      "gone",
      "unknown",
    ]);
    const undecided = childThreadFoldHeadStateOf(
      [shell("a", true)],
      (thread) => `${thread.environmentId}:${thread.id}`,
      () => null,
    );
    expect(undecided("env:a")).toBe("unknown");
  });
});

describe("pageSidebarThreadFamilies", () => {
  const page = (rows: readonly Row[], limit: number, keepKey: string | null = null) => {
    const result = pageSidebarThreadFamilies(
      rows,
      (thread) => thread.key,
      (thread) => thread.openedBy,
      { limit, keepKey, pageSize: 1 },
    );
    return { visible: result.visible.map((thread) => thread.key), hidden: result.hiddenCount };
  };

  it("counts a family as one item and brings its children along", () => {
    expect(page([row("a"), row("b"), row("a1", "a"), row("c"), row("a2", "a")], 2)).toEqual({
      visible: ["a", "a1", "a2", "b"],
      hidden: 1,
    });
  });

  it("never shows a child without its head", () => {
    // The hidden family is one row but two threads.
    expect(page([row("x1", "x"), row("a"), row("x")], 1)).toEqual({ visible: ["a"], hidden: 2 });
  });

  it("counts hidden threads, and the threads the next page shows", () => {
    const result = pageSidebarThreadFamilies(
      [row("a"), row("b"), row("b1", "b"), row("b2", "b"), row("c")],
      (thread) => thread.key,
      (thread) => thread.openedBy,
      { limit: 1, keepKey: null, pageSize: 1 },
    );
    expect(result.hiddenCount).toBe(4);
    expect(result.nextPageCount).toBe(3);
    // A grandchild is one more thread of the family it hides with.
    expect(page([row("a"), row("x"), row("x1", "x"), row("x2", "x1")], 1).hidden).toBe(3);
  });

  it("brings the open thread's whole family past the page", () => {
    expect(page([row("a"), row("x"), row("x1", "x"), row("b")], 1, "x1")).toEqual({
      visible: ["a", "x", "x1"],
      hidden: 1,
    });
    expect(page([row("a"), row("x"), row("x1", "x"), row("x2", "x1")], 1, "x2")).toEqual({
      visible: ["a", "x", "x1", "x2"],
      hidden: 0,
    });
  });
});

describe("placeChildThreadSections", () => {
  interface Shell extends Row {
    readonly delegatedBy?: string;
  }
  const place = (
    sections: Record<"active" | "settled", Shell[]>,
    delegated: Shell[],
  ): Record<string, string[]> => {
    const result = placeChildThreadSections({
      live: [sections.active],
      settled: sections.settled,
      delegated,
      keyOf: (thread) => thread.key,
      openerKeyOf: (thread) => thread.openedBy ?? thread.delegatedBy ?? null,
      delegatorKeyOf: (thread) => thread.delegatedBy ?? thread.key,
    });
    return {
      active: sections.active.map((thread) => thread.key),
      settled: sections.settled.map((thread) => thread.key),
      hidden: result.hidden.map((thread) => thread.key),
    };
  };
  const worker: Shell = { key: "worker", openedBy: null, delegatedBy: "orchestrator" };

  it("folds a worker's settled child under the worker in its delegator's section", () => {
    expect(
      place({ active: [row("orchestrator")], settled: [row("launched", "worker")] }, [worker]),
    ).toEqual({ active: ["orchestrator", "worker", "launched"], settled: [], hidden: [] });
  });

  it("keeps a worker and its settled child in Settled with their delegator", () => {
    expect(
      place({ active: [], settled: [row("orchestrator"), row("launched", "worker")] }, [worker]),
    ).toEqual({ active: [], settled: ["orchestrator", "launched", "worker"], hidden: [] });
  });
});

describe("childThreadStillRuns", () => {
  it("counts working and waiting on the user, not finished or idle", () => {
    expect(
      (
        [
          "preparing",
          "working",
          "approval",
          "input",
          "waiting",
          "ready",
          "failed",
          "limited",
        ] as const
      ).filter(childThreadStillRuns),
    ).toEqual(["preparing", "working", "approval", "input"]);
  });
});

describe("formatChildThreadsLabel", () => {
  it("counts every child and their news", () => {
    expect(
      formatChildThreadsLabel([
        { status: "failed", isUnread: true },
        { status: "ready", isUnread: true },
        { status: "working", isUnread: false },
        { status: "waiting", isUnread: false },
        { status: "approval", isUnread: false },
        { status: "failed", isUnread: false, settled: true },
        { status: "ready", isUnread: true, settled: true },
      ]),
    ).toBe("7 child threads · 1 failed · 1 new · 2 working · 2 settled");
  });

  it("names a single quiet child", () => {
    expect(formatChildThreadsLabel([{ status: "ready", isUnread: false }])).toBe("1 child thread");
  });
});

describe("formatChildThreadsDisclosureLabel", () => {
  it("names the action, the count and the opener", () => {
    expect(
      formatChildThreadsDisclosureLabel({
        kind: "family",
        expanded: false,
        count: 6,
        headTitle: "Release notes",
      }),
    ).toBe("Show 6 child threads of Release notes");
    expect(
      formatChildThreadsDisclosureLabel({
        kind: "family",
        expanded: true,
        count: 6,
        headTitle: "Release notes",
        summary: "6 child threads · 1 failed · 2 working",
      }),
    ).toBe("Hide 6 child threads of Release notes, 1 failed, 2 working");
    expect(
      formatChildThreadsDisclosureLabel({
        kind: "settled",
        expanded: true,
        count: 1,
        headTitle: "Release notes",
      }),
    ).toBe("Hide 1 settled child thread of Release notes");
  });
});
