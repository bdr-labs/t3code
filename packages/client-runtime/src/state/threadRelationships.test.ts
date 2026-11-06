import { describe, expect, it } from "vite-plus/test";
import { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

import {
  deriveThreadFamilyTree,
  deriveThreadRelationshipGraph,
  immediateThreadRelationships,
  isParentThreadRelationship,
  orderWebThreadLineageRows,
  resolveMergeBackTargetThreadId,
  threadRelationshipRowStatus,
  withProjectedThread,
} from "./threadRelationships.ts";

describe("thread relationships", () => {
  it.each([
    ["running", "completed"],
    ["completed", "running"],
  ])("keeps parent %s independent of child %s", (parentStatus, childStatus) => {
    const parent = ThreadId.make("parent");
    const child = ThreadId.make("child");
    const graph = deriveThreadRelationshipGraph({
      threads: [
        {
          id: parent,
          activityRunStatus: parentStatus,
          status: "cancelled",
          lineage: { parentThreadId: null },
        },
        {
          id: child,
          activityRunStatus: childStatus,
          lineage: { parentThreadId: parent, relationshipToParent: "fork" },
        },
      ] as never,
      projection: null,
    });
    expect(threadRelationshipRowStatus(graph, immediateThreadRelationships(graph, child)[0]!)).toBe(
      parentStatus,
    );
    expect(
      threadRelationshipRowStatus(graph, immediateThreadRelationships(graph, parent)[0]!),
    ).toBe(childStatus);
  });

  it("does not label a missing parent with its child's running status", () => {
    const parent = ThreadId.make("missing-parent");
    const child = ThreadId.make("child");
    const graph = deriveThreadRelationshipGraph({
      threads: [
        {
          id: child,
          status: "running",
          lineage: { parentThreadId: parent, relationshipToParent: "subagent" },
        },
      ] as never,
      projection: null,
    });
    expect(
      threadRelationshipRowStatus(graph, immediateThreadRelationships(graph, child)[0]!),
    ).toBeNull();
  });

  it.each(["fork", "subagent"] as const)(
    "keeps the parent edge of an opened %s omitted from the shell",
    (relationshipToParent) => {
      const parent = ThreadId.make("parent");
      const child = ThreadId.make("omitted-child");
      const projection = {
        thread: {
          id: child,
          forkedFrom:
            relationshipToParent === "fork"
              ? { type: "run", threadId: parent, runId: "source-run" }
              : null,
          lineage: { rootThreadId: parent, parentThreadId: parent, relationshipToParent },
        },
        subagents: [],
        contextTransfers: [],
      } as never;
      const graph = deriveThreadRelationshipGraph({ threads: [], projection });
      expect(immediateThreadRelationships(graph, child)).toEqual([
        expect.objectContaining({
          threadId: parent,
          edge: expect.objectContaining({
            sourceThreadId: parent,
            targetThreadId: child,
            kind: relationshipToParent,
          }),
        }),
      ]);
      expect(resolveMergeBackTargetThreadId(projection)).toBe(
        relationshipToParent === "fork" ? parent : null,
      );
    },
  );

  it("keeps an older activity run visible over a newer cancelled run", () => {
    const parent = ThreadId.make("thread-parent");
    const child = ThreadId.make("thread-child");
    const graph = deriveThreadRelationshipGraph({
      threads: [
        {
          id: child,
          title: "Active child",
          activityRunStatus: "running",
          status: "cancelled",
          forkedFrom: { type: "run", threadId: parent, runId: "run-parent" },
          lineage: {
            rootThreadId: parent,
            parentThreadId: parent,
            relationshipToParent: "subagent",
          },
        },
      ] as never,
      projection: null,
    });

    expect(graph.edges).toEqual([
      expect.objectContaining({ targetThreadId: child, status: "running" }),
    ]);
  });

  it("keeps missing parents and cycles navigable without recursive traversal", () => {
    const root = ThreadId.make("thread-root");
    const child = ThreadId.make("thread-child");
    const missing = ThreadId.make("thread-missing");
    const graph = deriveThreadRelationshipGraph({
      threads: [
        {
          id: root,
          title: "Root",
          status: "completed",
          forkedFrom: { type: "run", threadId: child, runId: "run-cycle" },
          lineage: { rootThreadId: root, parentThreadId: child, relationshipToParent: "fork" },
        },
        {
          id: child,
          title: "Child",
          status: "completed",
          forkedFrom: { type: "run", threadId: missing, runId: "run-missing" },
          lineage: { rootThreadId: root, parentThreadId: missing, relationshipToParent: "fork" },
        },
      ] as never,
      projection: null,
    });

    expect(graph.nodes.get(missing)?.missing).toBe(true);
    expect(immediateThreadRelationships(graph, root).map(({ threadId }) => threadId)).toEqual([
      child,
    ]);
  });

  it("combines subagent and transfer edges with archived shell state", () => {
    const parent = ThreadId.make("thread-parent");
    const child = ThreadId.make("thread-child");
    const transferTarget = ThreadId.make("thread-transfer");
    const graph = deriveThreadRelationshipGraph({
      threads: [
        {
          id: parent,
          title: "Parent",
          status: "completed",
          archivedAt: null,
          forkedFrom: null,
          lineage: { rootThreadId: parent, parentThreadId: null, relationshipToParent: null },
        },
        {
          id: child,
          title: "Subagent",
          status: "completed",
          archivedAt: "2026-06-24T00:00:00.000Z",
          forkedFrom: null,
          lineage: {
            rootThreadId: parent,
            parentThreadId: parent,
            relationshipToParent: "subagent",
          },
        },
      ] as never,
      projection: {
        thread: { id: parent },
        subagents: [{ childThreadId: child, status: "completed" }],
        contextTransfers: [
          {
            sourceThreadId: child,
            targetThreadId: transferTarget,
            status: "completed",
          },
        ],
      } as never,
    });

    expect(graph.nodes.get(child)?.thread?.archivedAt).not.toBeNull();
    expect(graph.nodes.get(transferTarget)?.missing).toBe(true);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sourceThreadId: parent,
          targetThreadId: child,
          kind: "subagent",
        }),
        expect.objectContaining({
          sourceThreadId: child,
          targetThreadId: transferTarget,
          kind: "transfer",
        }),
      ]),
    );
  });

  it("links an opener to the thread it opened, from either side, with each row's own status", () => {
    const opener = ThreadId.make("opener");
    const child = ThreadId.make("child");
    const graph = deriveThreadRelationshipGraph({
      threads: [
        { id: opener, status: "completed", lineage: { parentThreadId: null } },
        {
          id: child,
          activityRunStatus: "running",
          status: "running",
          openedByThreadId: opener,
          lineage: { parentThreadId: null },
        },
      ] as never,
      projection: null,
    });
    const edge = {
      sourceThreadId: opener,
      targetThreadId: child,
      kind: "opened",
      status: "running",
    };
    const childRows = immediateThreadRelationships(graph, child);
    const openerRows = immediateThreadRelationships(graph, opener);
    expect(childRows).toEqual([{ threadId: opener, fromThreadId: child, depth: 1, edge }]);
    expect(openerRows).toEqual([{ threadId: child, fromThreadId: opener, depth: 1, edge }]);
    expect(threadRelationshipRowStatus(graph, childRows[0]!)).toBe("completed");
    expect(threadRelationshipRowStatus(graph, openerRows[0]!)).toBe("running");
    expect(isParentThreadRelationship(edge as never, child)).toBe(false);
  });

  it("links the open thread's opener when only its projection is loaded", () => {
    const opener = ThreadId.make("opener");
    const child = ThreadId.make("child");
    const graph = deriveThreadRelationshipGraph({
      threads: [{ id: opener, status: "completed", lineage: { parentThreadId: null } }] as never,
      projection: {
        thread: { id: child, openedByThreadId: opener, lineage: { parentThreadId: null } },
        subagents: [],
        contextTransfers: [],
      } as never,
    });
    expect(immediateThreadRelationships(graph, child).map((row) => row.edge.kind)).toEqual([
      "opened",
    ]);
  });

  it.each([
    ["a delegate_task worker", { parentThreadId: "opener", relationshipToParent: "subagent" }],
    ["a fork", { parentThreadId: "opener", relationshipToParent: "fork" }],
  ])("keeps %s on its own edge when its opener is also its parent", (_name, lineage) => {
    const opener = ThreadId.make("opener");
    const child = ThreadId.make("child");
    const graph = deriveThreadRelationshipGraph({
      threads: [
        { id: opener, status: "running", lineage: { parentThreadId: null } },
        { id: child, status: "running", openedByThreadId: opener, lineage },
      ] as never,
      projection: null,
    });
    expect(graph.edges.map((edge) => edge.kind)).toEqual([
      lineage.relationshipToParent === "subagent" ? "subagent" : "fork",
    ]);
    expect(immediateThreadRelationships(graph, opener)).toHaveLength(1);
  });

  it("keeps one row for a pair that opened each other", () => {
    const left = ThreadId.make("left");
    const right = ThreadId.make("right");
    const graph = deriveThreadRelationshipGraph({
      threads: [
        { id: left, status: "idle", openedByThreadId: right, lineage: { parentThreadId: null } },
        { id: right, status: "idle", openedByThreadId: left, lineage: { parentThreadId: null } },
      ] as never,
      projection: null,
    });
    expect(graph.edges).toHaveLength(1);
  });

  it.each([
    ["a dangling opener", "gone", {}],
    [
      "another environment's opener",
      "remote-opener",
      { delegatedFrom: { environmentId: "remote", threadId: "remote-opener", title: "Remote" } },
    ],
    ["itself", "child", {}],
  ])("makes no edge or node for %s", (_name, openerThreadId, extra) => {
    const child = ThreadId.make("child");
    const graph = deriveThreadRelationshipGraph({
      threads: [
        {
          id: child,
          status: "running",
          openedByThreadId: openerThreadId,
          lineage: { parentThreadId: null },
          ...extra,
        },
      ] as never,
      projection: null,
    });
    expect(graph.edges).toEqual([]);
    expect([...graph.nodes.keys()]).toEqual([child]);
  });

  it("makes no edge to or from a deleted thread", () => {
    const opener = ThreadId.make("opener");
    const child = ThreadId.make("child");
    const deletedAt = "2026-06-24T00:00:00.000Z";
    const threads = (openerDeleted: boolean) =>
      [
        {
          id: opener,
          status: "idle",
          deletedAt: openerDeleted ? deletedAt : null,
          lineage: { parentThreadId: null },
        },
        {
          id: child,
          status: "idle",
          deletedAt: openerDeleted ? null : deletedAt,
          openedByThreadId: opener,
          lineage: { parentThreadId: null },
        },
      ] as never;
    expect(
      deriveThreadRelationshipGraph({ threads: threads(true), projection: null }).edges,
    ).toEqual([]);
    expect(
      deriveThreadRelationshipGraph({ threads: threads(false), projection: null }).edges,
    ).toEqual([]);
  });

  it("keeps the live shell when an archived snapshot contains the same thread id", () => {
    const parent = ThreadId.make("thread-parent");
    const staleParent = ThreadId.make("thread-stale-parent");
    const child = ThreadId.make("thread-child");
    const liveChild = {
      id: child,
      title: "Live child",
      status: "running",
      archivedAt: null,
      forkedFrom: { type: "run", threadId: parent, runId: "run-live" },
      lineage: {
        rootThreadId: parent,
        parentThreadId: parent,
        relationshipToParent: "fork",
      },
    } as const;
    const staleArchivedChild = {
      ...liveChild,
      title: "Stale archived child",
      status: "completed",
      archivedAt: "2026-06-24T00:00:00.000Z",
      forkedFrom: { type: "run", threadId: staleParent, runId: "run-stale" },
      lineage: {
        rootThreadId: staleParent,
        parentThreadId: staleParent,
        relationshipToParent: "fork",
      },
    } as const;

    const graph = deriveThreadRelationshipGraph({
      threads: [liveChild, staleArchivedChild] as never,
      projection: null,
    });

    expect(graph.nodes.get(child)?.thread).toMatchObject({
      title: "Live child",
      status: "running",
      archivedAt: null,
    });
    expect(graph.edges).toEqual([
      expect.objectContaining({
        sourceThreadId: parent,
        targetThreadId: child,
      }),
    ]);
    expect(graph.nodes.has(staleParent)).toBe(false);
  });

  it("resolves merge-back only for forks and prefers the recorded fork source", () => {
    const source = ThreadId.make("thread-source");
    const fallbackParent = ThreadId.make("thread-parent");
    const fork = ThreadId.make("thread-fork");

    expect(
      resolveMergeBackTargetThreadId({
        thread: {
          id: fork,
          forkedFrom: { type: "run", threadId: source, runId: "run-source" },
          lineage: {
            rootThreadId: source,
            parentThreadId: fallbackParent,
            relationshipToParent: "fork",
          },
        },
      } as never),
    ).toBe(source);
    expect(
      resolveMergeBackTargetThreadId({
        thread: {
          id: fork,
          forkedFrom: null,
          lineage: {
            rootThreadId: source,
            parentThreadId: fallbackParent,
            relationshipToParent: "fork",
          },
        },
      } as never),
    ).toBe(fallbackParent);
    expect(
      resolveMergeBackTargetThreadId({
        thread: {
          id: fork,
          forkedFrom: null,
          lineage: {
            rootThreadId: source,
            parentThreadId: fallbackParent,
            relationshipToParent: "subagent",
          },
        },
      } as never),
    ).toBeNull();
  });
});

const current = ThreadId.make("thread-current");

function forkShell(input: {
  readonly id: ThreadId;
  readonly parentThreadId: ThreadId | null;
  readonly createdAt?: string;
  readonly updatedAt?: string;
  readonly status?: string;
}) {
  return {
    id: input.id,
    title: input.id,
    status: input.status ?? "completed",
    archivedAt: null,
    forkedFrom:
      input.parentThreadId === null
        ? null
        : { type: "run", threadId: input.parentThreadId, runId: `run-${input.id}` },
    lineage: {
      rootThreadId: input.parentThreadId ?? input.id,
      parentThreadId: input.parentThreadId,
      relationshipToParent: input.parentThreadId === null ? null : "fork",
    },
    createdAt: input.createdAt === undefined ? undefined : DateTime.makeUnsafe(input.createdAt),
    updatedAt: DateTime.makeUnsafe(input.updatedAt ?? "2026-06-20T00:00:00.000Z"),
  };
}

function orderedLineageIds(input: {
  readonly threads: ReadonlyArray<unknown>;
  readonly mergeTargetThreadId?: ThreadId | null;
  readonly projection?: unknown;
}): ReadonlyArray<ThreadId> {
  const graph = deriveThreadRelationshipGraph({
    threads: input.threads as never,
    projection: (input.projection ?? null) as never,
  });
  return orderWebThreadLineageRows({
    graph,
    rows: immediateThreadRelationships(graph, current),
    currentThreadId: current,
    mergeTargetThreadId: input.mergeTargetThreadId ?? null,
  }).map(({ threadId }) => threadId);
}

describe("web thread lineage ordering", () => {
  it("does not reorder when related-thread activity arrives", () => {
    const first = ThreadId.make("thread-fork-a");
    const second = ThreadId.make("thread-fork-b");
    const third = ThreadId.make("thread-fork-c");
    const before = orderedLineageIds({
      threads: [
        forkShell({ id: current, parentThreadId: null, createdAt: "2026-06-01T00:00:00.000Z" }),
        forkShell({ id: first, parentThreadId: current, createdAt: "2026-06-02T00:00:00.000Z" }),
        forkShell({ id: second, parentThreadId: current, createdAt: "2026-06-03T00:00:00.000Z" }),
        forkShell({ id: third, parentThreadId: current, createdAt: "2026-06-04T00:00:00.000Z" }),
      ],
    });

    const after = orderedLineageIds({
      threads: [
        forkShell({
          id: second,
          parentThreadId: current,
          createdAt: "2026-06-03T00:00:00.000Z",
          updatedAt: "2026-07-30T00:00:00.000Z",
          status: "running",
        }),
        forkShell({ id: third, parentThreadId: current, createdAt: "2026-06-04T00:00:00.000Z" }),
        forkShell({ id: current, parentThreadId: null, createdAt: "2026-06-01T00:00:00.000Z" }),
        forkShell({
          id: first,
          parentThreadId: current,
          createdAt: "2026-06-02T00:00:00.000Z",
          updatedAt: "2026-07-31T00:00:00.000Z",
          status: "failed",
        }),
      ],
    });

    expect(before).toEqual([third, second, first]);
    expect(after).toEqual(before);
  });

  it("pins the parent first and a distinct merge-back target second", () => {
    const parent = ThreadId.make("thread-parent");
    const mergeTarget = ThreadId.make("thread-merge-target");
    const newestFork = ThreadId.make("thread-newest-fork");

    expect(
      orderedLineageIds({
        threads: [
          forkShell({ id: parent, parentThreadId: null, createdAt: "2026-06-01T00:00:00.000Z" }),
          forkShell({
            id: current,
            parentThreadId: parent,
            createdAt: "2026-06-02T00:00:00.000Z",
          }),
          forkShell({
            id: mergeTarget,
            parentThreadId: current,
            createdAt: "2026-06-03T00:00:00.000Z",
          }),
          forkShell({
            id: newestFork,
            parentThreadId: current,
            createdAt: "2026-06-09T00:00:00.000Z",
          }),
        ],
        mergeTargetThreadId: mergeTarget,
      }),
    ).toEqual([parent, mergeTarget, newestFork]);
  });

  it("sinks missing nodes and shells without a decoded createdAt", () => {
    const missingTransfer = ThreadId.make("thread-missing-transfer");
    const undated = ThreadId.make("thread-undated-fork");
    const dated = ThreadId.make("thread-dated-fork");

    expect(
      orderedLineageIds({
        threads: [
          forkShell({ id: current, parentThreadId: null, createdAt: "2026-06-01T00:00:00.000Z" }),
          forkShell({ id: undated, parentThreadId: current }),
          forkShell({ id: dated, parentThreadId: current, createdAt: "2026-06-02T00:00:00.000Z" }),
        ],
        projection: {
          thread: { id: current },
          subagents: [],
          contextTransfers: [
            { sourceThreadId: current, targetThreadId: missingTransfer, status: "completed" },
          ],
        },
      }),
    ).toEqual([dated, missingTransfer, undated]);
  });
});

describe("deriveThreadFamilyTree", () => {
  const shell = (id: string, opener?: string, extra: Record<string, unknown> = {}) =>
    ({
      id: ThreadId.make(id),
      ...(opener === undefined ? {} : { openedByThreadId: ThreadId.make(opener) }),
      lineage: { parentThreadId: null },
      ...extra,
    }) as never;
  const chain = (length: number) =>
    Array.from({ length }, (_, index) =>
      shell(`t${index}`, index === 0 ? undefined : `t${index - 1}`),
    );
  const tree = (current: string, shells: ReadonlyArray<never>) =>
    deriveThreadFamilyTree(ThreadId.make(current), shells);
  const rows = (current: string, shells: ReadonlyArray<never>) =>
    tree(current, shells).nodes.map(({ thread, depth, isCurrent, isAncestor }) =>
      [thread.id, depth, isCurrent ? "current" : isAncestor ? "ancestor" : "other"].join(" "),
    );

  const family = [
    shell("uncle", "root"),
    shell("root"),
    shell("leaf", "middle"),
    shell("sibling", "root"),
    shell("middle", "root"),
    shell("unrelated"),
  ];

  it.each([
    [
      "root",
      ["root 0 current", "middle 1 other", "leaf 2 other", "sibling 1 other", "uncle 1 other"],
    ],
    [
      "middle",
      ["root 0 ancestor", "middle 1 current", "leaf 2 other", "sibling 1 other", "uncle 1 other"],
    ],
    [
      "leaf",
      [
        "root 0 ancestor",
        "middle 1 ancestor",
        "leaf 2 current",
        "sibling 1 other",
        "uncle 1 other",
      ],
    ],
  ])("gives the whole family root first from %s", (current, expected) => {
    expect(rows(current, family)).toEqual(expected);
  });

  it("gives a thread with no opener and no child a tree of itself", () => {
    expect(rows("unrelated", family)).toEqual(["unrelated 0 current"]);
    expect(tree("nowhere", family).nodes).toEqual([]);
  });

  it("lists siblings newest first", () => {
    const at = (millis: number) => ({ createdAt: DateTime.makeUnsafe(millis) });
    const siblings = [
      shell("root"),
      shell("old", "root", at(1)),
      shell("new", "root", at(3)),
      shell("mid", "root", at(2)),
    ];
    expect(rows("root", siblings).slice(1)).toEqual(["new 1 other", "mid 1 other", "old 1 other"]);
  });

  it.each([
    ["itself", [shell("a", "a")], "a", ["a 0 current"]],
    ["a pair", [shell("a", "b"), shell("b", "a")], "a", ["b 0 ancestor", "a 1 current"]],
    [
      "a ring it hangs off",
      [shell("x", "y"), shell("y", "x"), shell("c", "y")],
      "c",
      ["x 0 ancestor", "y 1 ancestor", "c 2 current"],
    ],
    [
      "a ring of three",
      [shell("a", "c"), shell("b", "a"), shell("c", "b")],
      "b",
      ["c 0 ancestor", "a 1 ancestor", "b 2 current"],
    ],
  ])("ends the walk where a cycle through %s closes", (_name, shells, current, expected) => {
    expect(rows(current, shells as never)).toEqual(expected);
  });

  it("makes a thread a root when its opener is missing, deleted or in another environment", () => {
    const deleted = { deletedAt: DateTime.makeUnsafe(0) };
    const shells = [
      shell("from-other-environment", "only-in-another-environment"),
      shell("gone", "root", deleted),
      shell("root"),
      shell("orphan", "gone"),
      shell("orphan-child", "orphan"),
    ];
    expect(rows("from-other-environment", shells)).toEqual(["from-other-environment 0 current"]);
    expect(rows("orphan-child", shells)).toEqual(["orphan 0 ancestor", "orphan-child 1 current"]);
    expect(rows("root", shells)).toEqual(["root 0 current"]);
    expect(tree("gone", shells).nodes).toEqual([]);
  });

  it("uses the most authoritative copy of a thread", () => {
    const shells = [
      shell("child", "root", { title: "live" }),
      shell("root"),
      shell("child", undefined, { title: "archived" }),
    ];
    const nodes = tree("root", shells).nodes;
    expect(nodes.map(({ thread }) => thread.title)).toEqual([undefined, "live"]);
  });

  it("counts what is past the cap on the last row above it, and keeps every member", () => {
    const shells = chain(12);
    const fromRoot = tree("t0", shells);
    expect(fromRoot.nodes.map(({ thread }) => thread.id)).toEqual(
      Array.from({ length: 9 }, (_, index) => `t${index}`),
    );
    expect(fromRoot.nodes.at(-1)).toMatchObject({ depth: 8, deeperCount: 3 });
    expect(fromRoot.nodes.slice(0, -1).every(({ deeperCount }) => deeperCount === 0)).toBe(true);
    expect(fromRoot.memberIds.size).toBe(12);
  });

  it.each([
    ["t8", 10, 2],
    ["t11", 12, 0],
  ])("keeps %s and what it opened past the cap", (current, rowCount, deeper) => {
    const { nodes } = tree(current, chain(12));
    expect(nodes).toHaveLength(rowCount);
    expect(nodes.at(-1)?.deeperCount).toBe(deeper);
    expect(nodes.some(({ thread, isCurrent }) => isCurrent && thread.id === current)).toBe(true);
  });

  it("walks from the open thread's projection when no shell carries it", () => {
    const thread = shell("omitted", "root");
    const shells = [shell("root"), shell("child", "omitted")];
    const projection = { thread } as never;
    expect(rows("omitted", withProjectedThread(shells, projection) as never)).toEqual([
      "root 0 ancestor",
      "omitted 1 current",
      "child 2 other",
    ]);
    expect(withProjectedThread(shells, null)).toBe(shells);
    expect(withProjectedThread(shells, { thread: shells[0] } as never)).toBe(shells);
  });
});
