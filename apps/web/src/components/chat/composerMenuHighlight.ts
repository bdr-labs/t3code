export function resolveComposerMenuActiveItemId(input: {
  items: ReadonlyArray<{ id: string; disabledReason?: string }>;
  highlightedItemId: string | null;
  currentSearchKey: string | null;
  highlightedSearchKey: string | null;
}): string | null {
  if (input.items.length === 0) {
    return null;
  }

  if (
    input.currentSearchKey === input.highlightedSearchKey &&
    input.highlightedItemId &&
    input.items.some((item) => item.id === input.highlightedItemId)
  ) {
    return input.highlightedItemId;
  }

  // Arrows can reach a disabled entry; it never takes the default from a usable one.
  return (input.items.find((item) => !item.disabledReason) ?? input.items[0])?.id ?? null;
}
