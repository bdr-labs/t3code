import { describe, expect, it } from "vite-plus/test";

import { resolveComposerMenuActiveItemId } from "./composerMenuHighlight";

describe("resolveComposerMenuActiveItemId", () => {
  it("clears the active result while async results are empty and resolves against restored results", () => {
    const search = {
      highlightedItemId: "second",
      currentSearchKey: "path:src",
      highlightedSearchKey: "path:src",
    };
    const cleared = resolveComposerMenuActiveItemId({ ...search, items: [] });
    expect(cleared).toBeNull();
    expect(
      resolveComposerMenuActiveItemId({
        ...search,
        highlightedItemId: cleared,
        items: [{ id: "new-result" }, { id: "second" }],
      }),
    ).toBe("new-result");
  });

  it("defaults past a disabled entry but keeps one the user moved to", () => {
    const items = [{ id: "compact", disabledReason: "Wait." }, { id: "review" }];
    const search = { currentSearchKey: "slash:c", highlightedSearchKey: "slash:c" };
    expect(resolveComposerMenuActiveItemId({ ...search, items, highlightedItemId: null })).toBe(
      "review",
    );
    expect(
      resolveComposerMenuActiveItemId({ ...search, items, highlightedItemId: "compact" }),
    ).toBe("compact");
    expect(
      resolveComposerMenuActiveItemId({
        ...search,
        items: [{ id: "compact", disabledReason: "Wait." }],
        highlightedItemId: null,
      }),
    ).toBe("compact");
  });
});
