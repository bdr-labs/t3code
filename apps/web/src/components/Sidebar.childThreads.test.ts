import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSidebarChildThreadSections,
  pageSidebarSettledFamilies,
  placeSidebarChildThreads,
} from "./Sidebar.childThreads";

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
});
