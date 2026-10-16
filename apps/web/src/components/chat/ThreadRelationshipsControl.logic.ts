import type { ThreadRelationshipEdge } from "@t3tools/client-runtime/state/thread-relationships";
import { subagentFallbackTitle } from "@t3tools/client-runtime/state/subagent-display";
import {
  isProviderNativeSubagentThread,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadShell,
  type ThreadId,
} from "@t3tools/contracts";

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
