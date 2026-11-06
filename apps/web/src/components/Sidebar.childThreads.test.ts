import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSidebarChildThreadSections,
  nestedRowLevelOf,
  pageSidebarSettledFamilies,
  placeSidebarChildThreads,
} from "./Sidebar.childThreads";
import { sidebarFolderKeyByProject } from "./Sidebar.logic";

const thread = (
  id: string,
  overrides: {
    readonly openedBy?: string;
    readonly delegatedBy?: string;
    readonly projectId?: string;
    readonly settled?: boolean;
    readonly runtime?: "running" | "failed" | null;
    readonly input?: boolean;
  } = {},
) =>
  ({
    environmentId: "env",
    id,
    projectId: overrides.projectId ?? "project",
    title: id,
    archivedAt: null,
    settledOverride: overrides.settled ? "settled" : null,
    settledAt: overrides.settled ? "2026-10-18T00:00:00.000Z" : null,
    snoozedAt: null,
    openedByThreadId: overrides.openedBy,
    delegatedByThreadId: overrides.delegatedBy,
    hasPendingApprovals: false,
    hasPendingUserInput: overrides.input === true,
    pendingSubagentRequest: null,
    runtime: overrides.runtime ? { status: overrides.runtime, lastErrorClass: null } : null,
  }) as unknown as EnvironmentThreadShell;

const ids = (threads: readonly EnvironmentThreadShell[]) => threads.map((t) => t.id);
const noFolds = { collapsed: [], expandedInSettled: [] };

describe("buildSidebarChildThreadSections", () => {
  const sections = (
    overrides: Partial<Parameters<typeof buildSidebarChildThreadSections>[0]> = {},
  ) =>
    buildSidebarChildThreadSections({
      pinned: [],
      active: [],
      working: [],
      snoozed: [],
      settled: [],
      folds: noFolds,
      shownSettledKeys: new Set(),
      routeThreadKey: null,
      ...overrides,
    });

  it("nests a child under its opener in the same section and orders heads first", () => {
    const { sectionFamilies, orderedThreads } = sections({
      active: [thread("child", { openedBy: "head" }), thread("head"), thread("other")],
    });
    expect(sectionFamilies.active.map((family) => family.head.id)).toEqual(["head", "other"]);
    expect(ids(sectionFamilies.active[0]!.children)).toEqual(["child"]);
    expect(sectionFamilies.active[0]!.hasChildren).toBe(true);
    expect(sectionFamilies.active[1]!.hasChildren).toBe(false);
    expect(ids(orderedThreads)).toEqual(["head", "child", "other"]);
  });

  it("keeps children that need the user and the open thread in a collapsed family", () => {
    const { sectionFamilies, orderedThreads } = sections({
      active: [
        thread("head"),
        thread("quiet", { openedBy: "head" }),
        thread("asks", { openedBy: "head", input: true }),
        thread("open", { openedBy: "head" }),
      ],
      folds: { collapsed: ["env:head"], expandedInSettled: [] },
      routeThreadKey: "env:open",
    });
    const [family] = sectionFamilies.active;
    expect(family!.collapsed).toBe(true);
    expect(ids(family!.children)).toEqual(["asks", "open"]);
    expect(ids(family!.hidden)).toEqual(["quiet"]);
    expect(ids(family!.all)).toEqual(["quiet", "asks", "open"]);
    expect(ids(orderedThreads)).toEqual(["head", "asks", "open"]);
  });

  it("folds settled children behind their row and lists them once it opens", () => {
    const active = [
      thread("head"),
      thread("done", { openedBy: "head", settled: true }),
      thread("live", { openedBy: "head" }),
    ];
    const closed = sections({ active });
    expect(ids(closed.sectionFamilies.active[0]!.settled)).toEqual(["done"]);
    expect(closed.sectionFamilies.active[0]!.settledShown).toBe(false);
    expect(ids(closed.orderedThreads)).toEqual(["head", "live"]);

    const open = sections({ active, shownSettledKeys: new Set(["env:head"]) });
    expect(open.sectionFamilies.active[0]!.settledShown).toBe(true);
    expect(ids(open.orderedThreads)).toEqual(["head", "live", "done"]);
  });

  it("starts a settled family collapsed", () => {
    const { sectionFamilies } = sections({
      settled: [
        thread("head", { settled: true }),
        thread("child", { openedBy: "head", settled: true }),
      ],
    });
    const [family] = sectionFamilies.settled;
    expect(family!.place.section).toBe("settled");
    expect(family!.collapsed).toBe(true);
    expect(ids(family!.children)).toEqual([]);
    // Every child is settled, so the "+N settled" row is the family's fold.
    expect(family!.disclosure).toBe(false);
    expect(family!.settledRow).toBe(true);
    expect(family!.settledShown).toBe(false);
  });

  it("keeps a failed child visible in a collapsed family", () => {
    const { sectionFamilies } = sections({
      active: [
        thread("head"),
        thread("quiet", { openedBy: "head" }),
        thread("broke", { openedBy: "head", runtime: "failed" }),
      ],
      folds: { collapsed: ["env:head"], expandedInSettled: [] },
    });
    const [family] = sectionFamilies.active;
    expect(ids(family!.children)).toEqual(["broke"]);
    expect(family!.chips.map((chip) => chip.kind)).toEqual(["failed", "done"]);
  });

  it("nests the whole chain, in the order the rows render", () => {
    const { sectionFamilies, familyByKey, orderedThreads } = sections({
      active: [
        thread("grandchild", { openedBy: "child" }),
        thread("root"),
        thread("child", { openedBy: "root" }),
        thread("sibling", { openedBy: "root" }),
        thread("lone"),
      ],
    });
    expect(sectionFamilies.active.map((family) => family.head.id)).toEqual(["root", "lone"]);
    const [root] = sectionFamilies.active;
    expect(ids(root!.children)).toEqual(["child", "sibling"]);
    expect(ids(root!.all)).toEqual(["child", "grandchild", "sibling"]);
    // The chip row counts what the whole family does, as the flat list did.
    expect(root!.summary).toBe("3 child threads · 3 done");
    expect(root!.chips).toEqual([{ kind: "done", count: 3 }]);
    const child = familyByKey.get("env:child")!;
    expect([root!.depth, child.depth]).toEqual([0, 1]);
    expect(ids(child.children)).toEqual(["grandchild"]);
    expect(ids(orderedThreads)).toEqual(["root", "child", "grandchild", "sibling", "lone"]);
  });

  it.each([
    ["needs the user", thread("deep", { openedBy: "path", input: true }), null],
    ["failed", thread("deep", { openedBy: "path", runtime: "failed" }), null],
    ["is open", thread("deep", { openedBy: "path" }), "env:deep"],
  ])("keeps a descendant that %s under closed rows, with the path to it", (_name, deep, route) => {
    const active = [
      thread("root"),
      thread("quiet", { openedBy: "root" }),
      thread("path", { openedBy: "root" }),
      deep,
      thread("cousin", { openedBy: "path" }),
    ];
    const closed = sections({
      active,
      routeThreadKey: route,
      folds: { collapsed: ["env:root", "env:path"], expandedInSettled: [] },
    });
    expect(ids(closed.sectionFamilies.active[0]!.children)).toEqual(["path"]);
    expect(ids(closed.familyByKey.get("env:path")!.children)).toEqual(["deep"]);
    expect(ids(closed.orderedThreads)).toEqual(["root", "path", "deep"]);
    // A row under a closed one still answers to its own fold.
    const pathOpen = sections({
      active,
      routeThreadKey: route,
      folds: { collapsed: ["env:root"], expandedInSettled: [] },
    });
    expect(ids(pathOpen.orderedThreads)).toEqual(["root", "path", "deep", "cousin"]);
  });

  it("never folds a live thread away behind a settled one", () => {
    const { sectionFamilies, familyByKey, orderedThreads } = sections({
      active: [
        thread("root"),
        thread("done", { openedBy: "root", settled: true }),
        thread("live", { openedBy: "done" }),
      ],
    });
    const [root] = sectionFamilies.active;
    expect(root!.disclosure).toBe(true);
    expect(root!.settledRow).toBe(false);
    expect(ids(root!.children)).toEqual(["done"]);
    expect(ids(familyByKey.get("env:done")!.children)).toEqual(["live"]);
    expect(ids(orderedThreads)).toEqual(["root", "done", "live"]);
  });

  it("folds a settled subtree behind one row that counts it", () => {
    const active = [
      thread("root"),
      thread("old", { openedBy: "root", settled: true }),
      thread("older", { openedBy: "old", settled: true }),
    ];
    const { sectionFamilies, orderedThreads } = sections({ active });
    const [root] = sectionFamilies.active;
    expect(ids(root!.settled)).toEqual(["old"]);
    expect(ids(root!.settledAll)).toEqual(["old", "older"]);
    expect(root!.disclosure).toBe(false);
    expect(ids(orderedThreads)).toEqual(["root"]);
  });

  it("dissects a family by state", () => {
    // A settled parent is in Settled; its live child is a top-level row where it lives.
    const parent = thread("parent", { settled: true });
    const live = thread("child", { openedBy: "parent" });
    const dissected = sections({ active: [live], settled: [parent] });
    expect(dissected.sectionFamilies.active.map((family) => family.head.id)).toEqual(["child"]);
    expect(dissected.sectionFamilies.settled[0]!.hasChildren).toBe(false);
    expect(ids(dissected.orderedThreads)).toEqual(["child", "parent"]);
    // When the child settles it lands under its parent.
    const settledChild = thread("child", { openedBy: "parent", settled: true });
    const landed = sections({ settled: [parent, settledChild] });
    expect(landed.sectionFamilies.settled.map((family) => family.head.id)).toEqual(["parent"]);
    expect(ids(landed.sectionFamilies.settled[0]!.settled)).toEqual(["child"]);
    // A shelf only nests what is on it.
    const shelved = sections({
      pinned: [thread("pinned")],
      snoozed: [
        thread("sleeper", { openedBy: "pinned" }),
        thread("under", { openedBy: "sleeper" }),
      ],
    });
    expect(shelved.sectionFamilies.pinned[0]!.hasChildren).toBe(false);
    expect(shelved.sectionFamilies.snoozed.map((family) => family.head.id)).toEqual(["sleeper"]);
    expect(ids(shelved.sectionFamilies.snoozed[0]!.children)).toEqual(["under"]);
  });

  it("forms families within each folder", () => {
    const { sectionFamilies, orderedThreads } = sections({
      activeFolders: [
        [thread("opener"), thread("same-folder", { openedBy: "opener" })],
        [thread("cross-project", { openedBy: "opener", projectId: "other" })],
      ],
    });
    expect(sectionFamilies.active.map((family) => family.head.id)).toEqual([
      "opener",
      "cross-project",
    ]);
    expect(ids(sectionFamilies.active[0]!.children)).toEqual(["same-folder"]);
    expect(ids(orderedThreads)).toEqual(["opener", "same-folder", "cross-project"]);
  });

  it("does not call an unsettled worker in Settled settled", () => {
    const { sectionFamilies } = sections({
      settled: [
        thread("head", { settled: true }),
        thread("broke", { delegatedBy: "head", runtime: "failed" }),
      ],
    });
    const [family] = sectionFamilies.settled;
    expect(family!.collapsed).toBe(true);
    expect(ids(family!.children)).toEqual(["broke"]);
    expect(family!.chips.map((chip) => chip.kind)).toEqual(["failed"]);
  });
});

describe("nestedRowLevelOf", () => {
  it("grows per depth and stays flat past the cap", () => {
    expect([1, 2, 3, 4].map((depth) => nestedRowLevelOf(depth).indent)).toEqual([
      "ps-6",
      "ps-9",
      "ps-12",
      "ps-15",
    ]);
    expect(nestedRowLevelOf(5)).toBe(nestedRowLevelOf(4));
    expect(nestedRowLevelOf(32)).toBe(nestedRowLevelOf(4));
  });
});

describe("pageSidebarSettledFamilies", () => {
  const settledThreads = [
    thread("a", { settled: true }),
    thread("a1", { openedBy: "a", settled: true }),
    thread("b", { settled: true }),
    thread("c", { settled: true }),
    thread("c1", { openedBy: "c", settled: true }),
  ];

  it("pages a family at a time and counts the threads left out", () => {
    const page = pageSidebarSettledFamilies({
      settledThreads,
      limit: 2,
      pageSize: 25,
      shelfExpanded: true,
      routeThreadKey: null,
    });
    expect(ids(page.renderedSettledThreads)).toEqual(["a", "a1", "b"]);
    expect(page.hiddenSettledCount).toBe(2);
    expect(page.nextSettledPageCount).toBe(2);
  });

  it("keeps the open thread's family past the page", () => {
    const page = pageSidebarSettledFamilies({
      settledThreads,
      limit: 1,
      pageSize: 25,
      shelfExpanded: true,
      routeThreadKey: "env:c1",
    });
    expect(ids(page.renderedSettledThreads)).toEqual(["a", "a1", "c", "c1"]);
    const deep = pageSidebarSettledFamilies({
      settledThreads: [...settledThreads, thread("c2", { openedBy: "c1", settled: true })],
      limit: 10,
      pageSize: 25,
      shelfExpanded: false,
      routeThreadKey: "env:c2",
    });
    expect(ids(deep.renderedSettledThreads)).toEqual(["c", "c1", "c2"]);
  });

  it("shows only the open thread's family on a collapsed shelf", () => {
    const collapsed = (routeThreadKey: string | null) =>
      ids(
        pageSidebarSettledFamilies({
          settledThreads,
          limit: 10,
          pageSize: 25,
          shelfExpanded: false,
          routeThreadKey,
        }).renderedSettledThreads,
      );
    expect(collapsed("env:a1")).toEqual(["a", "a1"]);
    expect(collapsed(null)).toEqual([]);
  });
});

describe("placeSidebarChildThreads", () => {
  it("adds a delegated worker to its delegator's section, within the project scope", () => {
    const head = thread("head");
    const worker = thread("worker", { delegatedBy: "head" });
    const elsewhere = thread("elsewhere", { delegatedBy: "head", projectId: "other" });
    const active = [head];
    const settled: EnvironmentThreadShell[] = [];
    placeSidebarChildThreads({
      live: [[], active, [], []],
      settled,
      threads: [head, worker, elsewhere],
      scopedProjectKeys: new Set(["env:project"]),
    });
    expect(ids(active)).toEqual(["head", "worker"]);
  });

  it("moves a settled child to its live opener's section", () => {
    const head = thread("head");
    const child = thread("child", { openedBy: "head", settled: true });
    const active = [head];
    const settled = [child];
    placeSidebarChildThreads({
      live: [[], active, [], []],
      settled,
      threads: [],
      scopedProjectKeys: null,
    });
    expect(ids(active)).toEqual(["head", "child"]);
    expect(settled).toEqual([]);
  });

  it("folds a settled child under its live opener only inside one folder", () => {
    const head = thread("head");
    const sameFolder = thread("same-folder", { openedBy: "head", settled: true });
    const crossProject = thread("cross", { openedBy: "head", settled: true, projectId: "other" });
    const underCross = thread("under-cross", { openedBy: "cross", settled: true });
    const threads = [head, sameFolder, crossProject, underCross];
    const active = [head];
    const settled = [sameFolder, crossProject, underCross];
    placeSidebarChildThreads({
      live: [[], active, [], []],
      settled,
      threads,
      scopedProjectKeys: null,
      folderKeyByProject: sidebarFolderKeyByProject([
        {
          projectKey: "project-folder",
          memberProjectRefs: [
            { environmentId: "env" as never, projectId: "project" },
            { environmentId: "elsewhere" as never, projectId: "project" },
          ],
        },
        {
          projectKey: "other-folder",
          memberProjectRefs: [{ environmentId: "env" as never, projectId: "other" }],
        },
      ]),
    });
    expect(ids(active)).toEqual(["head", "same-folder"]);
    expect(ids(settled)).toEqual(["cross", "under-cross"]);
  });
});
