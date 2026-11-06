import {
  isOrchestrationV2WorkActive,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export type ThreadRelationshipKind = "parent" | "fork" | "subagent" | "transfer" | "opened";

export interface ThreadRelationshipNode {
  readonly threadId: ThreadId;
  readonly thread: OrchestrationV2ThreadShell | null;
  readonly missing: boolean;
}

export interface ThreadRelationshipEdge {
  readonly sourceThreadId: ThreadId;
  readonly targetThreadId: ThreadId;
  readonly kind: ThreadRelationshipKind;
  readonly status: string | null;
}

export interface ThreadRelationshipGraph {
  readonly nodes: ReadonlyMap<ThreadId, ThreadRelationshipNode>;
  readonly edges: ReadonlyArray<ThreadRelationshipEdge>;
}

export interface ThreadRelationshipWalkRow {
  readonly threadId: ThreadId;
  readonly fromThreadId: ThreadId;
  readonly depth: number;
  readonly edge: ThreadRelationshipEdge;
}

export function resolveMergeBackTargetThreadId(
  projection: Pick<OrchestrationV2ThreadProjection, "thread"> | null,
): ThreadId | null {
  if (projection?.thread.lineage.relationshipToParent !== "fork") return null;
  return projection.thread.forkedFrom?.type === "run"
    ? projection.thread.forkedFrom.threadId
    : projection.thread.lineage.parentThreadId;
}

function edgeKey(edge: ThreadRelationshipEdge): string {
  return `${edge.sourceThreadId}\u001f${edge.targetThreadId}\u001f${edge.kind}`;
}

function threadPairKey(left: ThreadId, right: ThreadId): string {
  return left < right ? `${left}\u001f${right}` : `${right}\u001f${left}`;
}

export function deriveThreadRelationshipGraph(input: {
  readonly threads: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly projection: OrchestrationV2ThreadProjection | null;
}): ThreadRelationshipGraph {
  const threadsById = new Map<ThreadId, OrchestrationV2ThreadShell>();
  for (const thread of input.threads) {
    // Callers order shells from most to least authoritative. In particular,
    // live shells precede archived snapshots, which may still contain a stale
    // copy during archive refresh.
    if (!threadsById.has(thread.id)) {
      threadsById.set(thread.id, thread);
    }
  }
  const threads = [...threadsById.values()];
  const nodes = new Map<ThreadId, ThreadRelationshipNode>(
    threads.map((thread) => [thread.id, { threadId: thread.id, thread, missing: false }]),
  );
  const edgesByKey = new Map<string, ThreadRelationshipEdge>();
  const ensureNode = (threadId: ThreadId) => {
    if (!nodes.has(threadId)) {
      nodes.set(threadId, { threadId, thread: null, missing: true });
    }
  };
  const addEdge = (edge: ThreadRelationshipEdge) => {
    ensureNode(edge.sourceThreadId);
    ensureNode(edge.targetThreadId);
    edgesByKey.set(
      edgeKey(edge),
      edge.kind === "subagent" && edge.status === "rolled_back"
        ? { ...edge, status: "interrupted" }
        : edge,
    );
  };

  const selectedThread = input.projection?.thread;
  const lineageThreads =
    selectedThread !== undefined && !threadsById.has(selectedThread.id)
      ? [...threads, { ...selectedThread, activityRunStatus: null, status: null }]
      : threads;
  for (const thread of lineageThreads) {
    const parentThreadId =
      thread.forkedFrom?.type === "run"
        ? thread.forkedFrom.threadId
        : thread.lineage.parentThreadId;
    if (parentThreadId === null) continue;
    addEdge({
      sourceThreadId: parentThreadId,
      targetThreadId: thread.id,
      kind: thread.lineage.relationshipToParent === "subagent" ? "subagent" : "fork",
      status: thread.activityRunStatus ?? thread.status,
    });
  }

  if (input.projection !== null) {
    const ownerThreadId = input.projection.thread.id;
    for (const subagent of input.projection.subagents) {
      if (subagent.childThreadId === null) continue;
      const child = threadsById.get(subagent.childThreadId);
      addEdge({
        sourceThreadId: ownerThreadId,
        targetThreadId: subagent.childThreadId,
        kind: "subagent",
        status:
          child?.activityRunStatus ??
          (child?.latestRunId != null && !isOrchestrationV2WorkActive(subagent.status)
            ? child.status
            : subagent.status),
      });
    }
    for (const transfer of input.projection.contextTransfers) {
      if (transfer.sourceThreadId === transfer.targetThreadId) continue;
      addEdge({
        sourceThreadId: transfer.sourceThreadId,
        targetThreadId: transfer.targetThreadId,
        kind: "transfer",
        status: transfer.status,
      });
    }
  }

  // Added last, so a pair with another edge keeps it: a delegate_task worker stays an agent row.
  // Only a thread present here can be an opener: a deleted or another environment's has no row.
  const linkedPairs = new Set(
    [...edgesByKey.values()].map((edge) => threadPairKey(edge.sourceThreadId, edge.targetThreadId)),
  );
  const presentThreadIds = new Set(
    lineageThreads.filter((thread) => thread.deletedAt == null).map((thread) => thread.id),
  );
  for (const thread of lineageThreads) {
    const openerThreadId = thread.openedByThreadId;
    if (openerThreadId === undefined || openerThreadId === thread.id) continue;
    if (!presentThreadIds.has(openerThreadId) || !presentThreadIds.has(thread.id)) continue;
    const pair = threadPairKey(openerThreadId, thread.id);
    if (linkedPairs.has(pair)) continue;
    linkedPairs.add(pair);
    addEdge({
      sourceThreadId: openerThreadId,
      targetThreadId: thread.id,
      kind: "opened",
      status: thread.activityRunStatus ?? thread.status,
    });
  }

  return { nodes, edges: [...edgesByKey.values()] };
}

export function immediateThreadRelationships(
  graph: ThreadRelationshipGraph,
  threadId: ThreadId,
): ReadonlyArray<ThreadRelationshipWalkRow> {
  const visited = new Set<ThreadId>();
  const rows: ThreadRelationshipWalkRow[] = [];

  for (const edge of graph.edges) {
    const relatedId =
      edge.sourceThreadId === threadId
        ? edge.targetThreadId
        : edge.targetThreadId === threadId
          ? edge.sourceThreadId
          : null;
    if (relatedId === null || visited.has(relatedId)) continue;
    visited.add(relatedId);
    rows.push({ threadId: relatedId, fromThreadId: threadId, depth: 1, edge });
  }

  return rows;
}

export function isParentThreadRelationship(
  edge: ThreadRelationshipEdge,
  currentThreadId: ThreadId,
): boolean {
  return (
    edge.kind !== "transfer" && edge.kind !== "opened" && edge.targetThreadId === currentThreadId
  );
}

export function threadRelationshipRowStatus(
  graph: ThreadRelationshipGraph,
  row: Pick<ThreadRelationshipWalkRow, "threadId" | "edge">,
): string | null {
  if (row.edge.kind === "transfer" || row.threadId === row.edge.targetThreadId) {
    return row.edge.status;
  }
  const thread = graph.nodes.get(row.threadId)?.thread;
  return thread?.activityRunStatus ?? thread?.status ?? null;
}

/** Past this depth from the root a family counts its rows, unless the current thread is deeper. */
export const THREAD_FAMILY_DEPTH_CAP = 8;

export interface ThreadFamilyNode {
  readonly thread: OrchestrationV2ThreadShell;
  readonly depth: number;
  readonly parentThreadId: ThreadId | null;
  readonly isCurrent: boolean;
  readonly isAncestor: boolean;
  /** Descendants past the cap under this row, the last one above them. */
  readonly deeperCount: number;
}

export interface ThreadFamilyTree {
  /** Root first, each thread before the threads it opened. */
  readonly nodes: ReadonlyArray<ThreadFamilyNode>;
  /** Every thread of the family, the ones past the cap too. */
  readonly memberIds: ReadonlySet<ThreadId>;
}

interface ThreadOpenerIndex {
  readonly threadsById: ReadonlyMap<ThreadId, OrchestrationV2ThreadShell>;
  readonly openedBy: ReadonlyMap<ThreadId, ReadonlyArray<OrchestrationV2ThreadShell>>;
}

const openerIndexes = new WeakMap<ReadonlyArray<OrchestrationV2ThreadShell>, ThreadOpenerIndex>();

function newestThreadFirst(
  left: OrchestrationV2ThreadShell,
  right: OrchestrationV2ThreadShell,
): number {
  const millis = (thread: OrchestrationV2ThreadShell) =>
    threadCreatedAtMillis({ threadId: thread.id, thread, missing: false }) ?? 0;
  return millis(right) - millis(left) || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0);
}

/** One pass per shell list, so a family's walk costs its own size on a long list. */
function threadOpenerIndexOf(shells: ReadonlyArray<OrchestrationV2ThreadShell>): ThreadOpenerIndex {
  const known = openerIndexes.get(shells);
  if (known !== undefined) return known;
  const seen = new Set<ThreadId>();
  const threadsById = new Map<ThreadId, OrchestrationV2ThreadShell>();
  const openedBy = new Map<ThreadId, OrchestrationV2ThreadShell[]>();
  for (const thread of shells) {
    // The first copy is the most authoritative, as in deriveThreadRelationshipGraph.
    if (seen.has(thread.id)) continue;
    seen.add(thread.id);
    if (thread.deletedAt != null) continue;
    threadsById.set(thread.id, thread);
    const openerId = thread.openedByThreadId;
    if (openerId === undefined) continue;
    const siblings = openedBy.get(openerId);
    if (siblings === undefined) openedBy.set(openerId, [thread]);
    else siblings.push(thread);
  }
  for (const siblings of openedBy.values()) siblings.sort(newestThreadFirst);
  const index = { threadsById, openedBy };
  openerIndexes.set(shells, index);
  return index;
}

/**
 * The shells, with the open thread's projection standing in when no shell carries it. A shell list
 * leaves out only idle threads, since it keeps every live one.
 */
export function withProjectedThread(
  shells: ReadonlyArray<OrchestrationV2ThreadShell>,
  projection: Pick<OrchestrationV2ThreadProjection, "thread"> | null,
): ReadonlyArray<OrchestrationV2ThreadShell> {
  if (projection === null || shells.some((thread) => thread.id === projection.thread.id)) {
    return shells;
  }
  return [
    ...shells,
    {
      ...projection.thread,
      activityRunStatus: null,
      status: "idle",
      latestRunId: null,
      activeRunId: null,
      pendingRuntimeRequest: null,
      latestVisibleMessage: null,
      latestUserMessageAt: null,
      hasActionableProposedPlan: false,
      pendingBackgroundTasks: [],
      providerInstanceHistory: [],
      itemCount: 0,
      visibleItemCount: 0,
    },
  ];
}

/**
 * The current thread's family by `openedByThreadId`: up to the root, then down through every
 * descendant. A thread whose opener is missing or deleted is a root, and a cycle ends where it
 * closes. The cap never hides the current thread or the threads it opened.
 */
export function deriveThreadFamilyTree(
  currentThreadId: ThreadId,
  shells: ReadonlyArray<OrchestrationV2ThreadShell>,
): ThreadFamilyTree {
  const { threadsById, openedBy } = threadOpenerIndexOf(shells);
  const current = threadsById.get(currentThreadId);
  if (current === undefined) return { nodes: [], memberIds: new Set() };

  const ancestorIds = new Set<ThreadId>();
  let root = current;
  while (root.openedByThreadId !== undefined) {
    const opener = threadsById.get(root.openedByThreadId);
    if (opener === undefined || opener.id === currentThreadId || ancestorIds.has(opener.id)) break;
    ancestorIds.add(opener.id);
    root = opener;
  }

  const cap = Math.max(THREAD_FAMILY_DEPTH_CAP, ancestorIds.size + 1);
  const memberIds = new Set<ThreadId>([root.id]);
  const shown: Array<Omit<ThreadFamilyNode, "deeperCount">> = [];
  const deeperCounts = new Map<ThreadId, number>();
  let lastAtCap: ThreadId | null = null;
  const stack: Array<Pick<ThreadFamilyNode, "thread" | "depth" | "parentThreadId">> = [
    { thread: root, depth: 0, parentThreadId: null },
  ];
  for (let entry = stack.pop(); entry !== undefined; entry = stack.pop()) {
    const { thread, depth } = entry;
    if (depth > cap && lastAtCap !== null) {
      deeperCounts.set(lastAtCap, (deeperCounts.get(lastAtCap) ?? 0) + 1);
    } else {
      if (depth === cap) lastAtCap = thread.id;
      shown.push({
        ...entry,
        isCurrent: thread.id === currentThreadId,
        isAncestor: ancestorIds.has(thread.id),
      });
    }
    const children = openedBy.get(thread.id) ?? [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index]!;
      if (memberIds.has(child.id)) continue;
      memberIds.add(child.id);
      stack.push({ thread: child, depth: depth + 1, parentThreadId: thread.id });
    }
  }
  return {
    nodes: shown.map((node) => ({
      ...node,
      deeperCount: deeperCounts.get(node.thread.id) ?? 0,
    })),
    memberIds,
  };
}

function threadCreatedAtMillis(node: ThreadRelationshipNode | undefined): number | null {
  const createdAt: unknown = node?.thread?.createdAt;
  if (!DateTime.isDateTime(createdAt)) return null;
  const millis = DateTime.toEpochMillis(createdAt);
  return Number.isFinite(millis) ? millis : null;
}

/**
 * Web pins the parent and distinct merge-back target before newest-created-first ordering.
 * Mobile does not share this exception; do not reuse it as the canonical relationship order.
 */
export function orderWebThreadLineageRows(input: {
  readonly graph: ThreadRelationshipGraph;
  readonly rows: ReadonlyArray<ThreadRelationshipWalkRow>;
  readonly currentThreadId: ThreadId;
  readonly mergeTargetThreadId: ThreadId | null;
}): ReadonlyArray<ThreadRelationshipWalkRow> {
  const pinRank = (row: ThreadRelationshipWalkRow): number => {
    if (isParentThreadRelationship(row.edge, input.currentThreadId)) return 0;
    if (row.threadId === input.mergeTargetThreadId) return 1;
    return 2;
  };

  return [...input.rows].sort((left, right) => {
    const rankDelta = pinRank(left) - pinRank(right);
    if (rankDelta !== 0) return rankDelta;
    const leftCreatedAt = threadCreatedAtMillis(input.graph.nodes.get(left.threadId));
    const rightCreatedAt = threadCreatedAtMillis(input.graph.nodes.get(right.threadId));
    if (leftCreatedAt !== rightCreatedAt) {
      if (leftCreatedAt === null) return 1;
      if (rightCreatedAt === null) return -1;
      return rightCreatedAt - leftCreatedAt;
    }
    return left.threadId < right.threadId ? -1 : left.threadId > right.threadId ? 1 : 0;
  });
}
