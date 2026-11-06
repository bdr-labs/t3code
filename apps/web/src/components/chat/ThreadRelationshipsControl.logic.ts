import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  childThreadKindOf,
  foldChildThreadFamily,
  type ChildThreadFamilyFold,
  type ChildThreadKind,
} from "@t3tools/client-runtime/state/thread-family-summary";
import { threadGroupOf } from "@t3tools/client-runtime/state/thread-groups";
import type {
  ThreadFamilyNode,
  ThreadFamilyTree,
  ThreadRelationshipEdge,
} from "@t3tools/client-runtime/state/thread-relationships";
import { subagentFallbackTitle } from "@t3tools/client-runtime/state/subagent-display";
import {
  isProviderNativeSubagentThread,
  type EnvironmentId,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";
import { create } from "zustand";

import { hasUnseenCompletion, resolveSidebarThreadStatus } from "../Sidebar.logic";

/**
 * Names a related thread from the current thread's side. A child names its kind: "agent" for
 * a T3 delegate_task worker, "subagent" for a provider-native one, taken from the projected
 * subagent and else from how the child thread was created.
 */
export function relationshipLabel(
  edge: ThreadRelationshipEdge,
  currentThreadId: ThreadId,
  child?: {
    readonly origin?: OrchestrationV2Subagent["origin"] | undefined;
    readonly thread?:
      | Pick<OrchestrationV2ThreadShell, "lineage" | "creationSource">
      | null
      | undefined;
  },
): string {
  if (edge.kind === "transfer") return "Context transfer";
  if (edge.kind === "subagent") {
    if (edge.sourceThreadId !== currentThreadId) return "parent agent";
    const origin =
      child?.origin ??
      (child?.thread
        ? isProviderNativeSubagentThread(child.thread)
          ? "provider_native"
          : "app_owned"
        : undefined);
    return subagentFallbackTitle(origin);
  }
  return edge.sourceThreadId === currentThreadId ? "Fork" : "Parent thread";
}

/** What the sidebar would call this thread; an archived thread counts as settled. */
export function lineageThreadKindOf(
  environmentId: EnvironmentId,
  thread: OrchestrationV2ThreadShell,
): ChildThreadKind {
  const shell = presentThreadShell(environmentId, thread);
  return childThreadKindOf({
    status: resolveSidebarThreadStatus(shell),
    isUnread: hasUnseenCompletion(shell),
    settled: thread.settledOverride === "settled" || thread.archivedAt !== null,
  });
}

/** Live rows by kind, needs-you and working first, and the settled rows behind one fold. */
function foldLineageRows<Row>(
  rows: ReadonlyArray<Row>,
  kindOf: (row: Row) => ChildThreadKind,
  staysShown: (row: Row) => boolean = () => false,
): Pick<ChildThreadFamilyFold<Row>, "shown" | "settled"> {
  return foldChildThreadFamily(rows, {
    kindOf,
    isOpen: staysShown,
    collapsed: false,
    settledOpen: false,
  });
}

export interface LineageFamilyBranch extends LineageFamilyFold {
  readonly node: ThreadFamilyNode;
}

export interface LineageFamilyFold {
  readonly shown: ReadonlyArray<LineageFamilyBranch>;
  readonly settled: ReadonlyArray<LineageFamilyBranch>;
  readonly deeperCount: number;
}

export interface LineageFamily extends LineageFamilyFold {
  readonly rowIds: ReadonlySet<ThreadId>;
}

/**
 * The family as rows. A thread with a row of its own elsewhere in the panel is left out and the
 * threads it opened take its place. A settled branch folds per parent unless it holds the current
 * thread or something live. Null when nothing but the current thread would show.
 */
export function deriveLineageFamily(input: {
  readonly tree: ThreadFamilyTree;
  readonly isLeftOut: (threadId: ThreadId) => boolean;
  readonly kindOf: (thread: OrchestrationV2ThreadShell) => ChildThreadKind;
}): LineageFamily | null {
  const childrenOf = new Map<ThreadId | null, ThreadFamilyNode[]>();
  for (const node of input.tree.nodes) {
    const siblings = childrenOf.get(node.parentThreadId);
    if (siblings === undefined) childrenOf.set(node.parentThreadId, [node]);
    else siblings.push(node);
  }
  const rowIds = new Set<ThreadId>();
  const fold = (branches: ReadonlyArray<LineageFamilyBranch>) =>
    foldLineageRows(
      branches,
      (branch) => input.kindOf(branch.node.thread),
      (branch) => branch.node.isCurrent || branch.node.isAncestor || branch.shown.length > 0,
    );
  const walk = (
    parentThreadId: ThreadId | null,
  ): { readonly branches: LineageFamilyBranch[]; readonly deeperCount: number } => {
    const branches: LineageFamilyBranch[] = [];
    let deeperCount = 0;
    for (const node of childrenOf.get(parentThreadId) ?? []) {
      const below = walk(node.thread.id);
      const nodeDeeper = node.deeperCount + below.deeperCount;
      if (!node.isCurrent && input.isLeftOut(node.thread.id)) {
        branches.push(...below.branches);
        deeperCount += nodeDeeper;
        continue;
      }
      rowIds.add(node.thread.id);
      branches.push({ node, ...fold(below.branches), deeperCount: nodeDeeper });
    }
    return { branches, deeperCount };
  };
  const top = walk(null);
  const hasOtherThread = input.tree.nodes.some(
    ({ thread, isCurrent }) => !isCurrent && rowIds.has(thread.id),
  );
  return hasOtherThread ? { ...fold(top.branches), deeperCount: top.deeperCount, rowIds } : null;
}

interface LineageFoldState {
  /** A row folded this session, and the thread open when it was. */
  readonly folded: ReadonlyMap<string, ThreadId>;
  readonly settledOpen: ReadonlySet<string>;
  readonly setRowFolded: (rowKey: string, foldedOn: ThreadId | null) => void;
  readonly setSettledOpen: (rowKey: string, open: boolean) => void;
}

export const useLineageFoldStore = create<LineageFoldState>()((set) => ({
  folded: new Map(),
  settledOpen: new Set(),
  setRowFolded: (rowKey, foldedOn) =>
    set(({ folded }) => {
      const next = new Map(folded);
      if (foldedOn === null) next.delete(rowKey);
      else next.set(rowKey, foldedOn);
      return { folded: next };
    }),
  setSettledOpen: (rowKey, open) =>
    set(({ settledOpen }) => {
      const next = new Set(settledOpen);
      if (open) next.add(rowKey);
      else next.delete(rowKey);
      return { settledOpen: next };
    }),
}));

/** A fold lasts the session, but the path to the open thread opens unless folded from that thread. */
export function isLineageRowFolded(
  foldedOn: ThreadId | undefined,
  node: Pick<ThreadFamilyNode, "isAncestor">,
  currentThreadId: ThreadId,
): boolean {
  if (foldedOn === undefined) return false;
  return !node.isAncestor || foldedOn === currentThreadId;
}

export interface LineageGroup {
  readonly name: string;
  readonly members: ReadonlyArray<OrchestrationV2ThreadShell>;
  readonly settledCount: number;
}

/**
 * The current thread's group: its other members not settled, and how many are. A member already
 * on a row of its own stays on that row and out of both. Null for a thread alone in its group.
 */
export function deriveLineageGroup(input: {
  readonly currentThread: Pick<OrchestrationV2ThreadShell, "id" | "tags"> | undefined;
  readonly nodes: Iterable<{ readonly thread: OrchestrationV2ThreadShell | null }>;
  readonly listedThreadIds: ReadonlySet<ThreadId>;
  readonly isHidden: (threadId: ThreadId) => boolean;
  readonly kindOf: (thread: OrchestrationV2ThreadShell) => ChildThreadKind;
}): LineageGroup | null {
  const name = threadGroupOf(input.currentThread?.tags);
  if (name === null) return null;
  const others = [...input.nodes].flatMap(({ thread }) =>
    thread !== null &&
    thread.id !== input.currentThread?.id &&
    thread.deletedAt == null &&
    threadGroupOf(thread.tags) === name &&
    !input.isHidden(thread.id)
      ? [thread]
      : [],
  );
  if (others.length === 0) return null;
  const fold = foldLineageRows(
    others.filter((thread) => !input.listedThreadIds.has(thread.id)),
    input.kindOf,
  );
  return { name, members: fold.shown, settledCount: fold.settled.length };
}
