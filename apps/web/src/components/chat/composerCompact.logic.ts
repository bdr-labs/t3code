import type { ComposerTrigger } from "../../composer-logic";

export const COMPACT_DISABLED_REASONS = {
  cannotOperate: "This connection cannot change threads.",
  noProject: "Choose a project before compacting",
  pendingApproval: "Resolve the pending approval first.",
  pendingInput: "Answer the pending question first.",
  working: "Wait for the current turn to finish.",
  composerAttachments: "Remove attachments to compact.",
  unavailable: "Compacting is unavailable right now",
} as const;

export type CompactSlashEntry = "hidden" | "enabled" | { readonly disabledReason: string };

// One object per reason: a fresh one every render would rebuild the menu's memoized items.
const DISABLED_ENTRIES = new Map<string, { readonly disabledReason: string }>(
  Object.values(COMPACT_DISABLED_REASONS).map((disabledReason) => [
    disabledReason,
    { disabledReason },
  ]),
);

export function compactSlashEntry(state: {
  readonly providerListsCompact: boolean;
  readonly manualCompactionProviderAvailable: boolean;
  readonly hasActiveThread: boolean;
  readonly isServerThread: boolean;
  readonly hasCompactableConversation: boolean;
  readonly canOperateThread: boolean;
  readonly hasActiveProject: boolean;
  readonly hasPendingApproval: boolean;
  readonly hasPendingUserInput: boolean;
  readonly isWorking: boolean;
  readonly hasComposerAttachments: boolean;
  readonly compactThreadUnavailable: boolean;
  readonly prompt: string;
  readonly trigger: ComposerTrigger | null;
}): CompactSlashEntry {
  if (
    !state.providerListsCompact ||
    !state.manualCompactionProviderAvailable ||
    !state.hasActiveThread ||
    !state.isServerThread ||
    !state.hasCompactableConversation ||
    state.trigger?.kind !== "slash-command" ||
    state.prompt.slice(0, state.trigger.rangeStart).trim() !== "" ||
    state.prompt.slice(state.trigger.rangeEnd).trim() !== ""
  ) {
    return "hidden";
  }
  const disabledReason = !state.canOperateThread
    ? COMPACT_DISABLED_REASONS.cannotOperate
    : !state.hasActiveProject
      ? COMPACT_DISABLED_REASONS.noProject
      : state.hasPendingApproval
        ? COMPACT_DISABLED_REASONS.pendingApproval
        : state.hasPendingUserInput
          ? COMPACT_DISABLED_REASONS.pendingInput
          : state.isWorking
            ? COMPACT_DISABLED_REASONS.working
            : state.hasComposerAttachments
              ? COMPACT_DISABLED_REASONS.composerAttachments
              : state.compactThreadUnavailable
                ? COMPACT_DISABLED_REASONS.unavailable
                : null;
  return disabledReason === null ? "enabled" : DISABLED_ENTRIES.get(disabledReason)!;
}

/** Applies the entry to `/compact` alone; every other command passes through untouched. */
export function applyCompactSlashEntry<
  Item extends { readonly command: { readonly name: string } },
>(items: ReadonlyArray<Item>, entry: CompactSlashEntry): Array<Item & { disabledReason?: string }> {
  if (entry === "enabled") return [...items];
  return items.flatMap((item) => {
    if (item.command.name !== "compact") return [item];
    return entry === "hidden" ? [] : [{ ...item, disabledReason: entry.disabledReason }];
  });
}
