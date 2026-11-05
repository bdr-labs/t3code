import { presentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  childThreadKindOf,
  foldChildThreadFamily,
  type ChildThreadFamilyFold,
  type ChildThreadKind,
} from "@t3tools/client-runtime/state/thread-family-summary";
import { threadGroupOf } from "@t3tools/client-runtime/state/thread-groups";
import type { ThreadRelationshipEdge } from "@t3tools/client-runtime/state/thread-relationships";
import { subagentFallbackTitle } from "@t3tools/client-runtime/state/subagent-display";
import {
  isProviderNativeSubagentThread,
  type EnvironmentId,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";

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
  if (edge.kind === "opened") {
    return edge.sourceThreadId === currentThreadId ? "Opened thread" : "Opener";
  }
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
export function foldLineageRows<Row>(
  rows: ReadonlyArray<Row>,
  kindOf: (row: Row) => ChildThreadKind,
): Pick<ChildThreadFamilyFold<Row>, "shown" | "settled"> {
  return foldChildThreadFamily(rows, {
    kindOf,
    isOpen: () => false,
    collapsed: false,
    settledOpen: false,
  });
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
