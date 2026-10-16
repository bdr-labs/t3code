import { describe, expect, it } from "vite-plus/test";
import { parseCustomizedBuild } from "./branding.logic";

describe("parseCustomizedBuild", () => {
  it("is null in stock builds", () => {
    expect(parseCustomizedBuild("")).toBeNull();
    expect(parseCustomizedBuild("   ")).toBeNull();
    expect(parseCustomizedBuild(undefined)).toBeNull();
  });

  it("reads the recipe and build time t3code-customize stamps", () => {
    const build = parseCustomizedBuild("1a62bc9025c3 2026-10-16T10:56:43");
    expect(build?.recipe).toBe("1a62bc9025c3");
    expect(build?.shortRecipe).toBe("1a62bc9");
    expect(build?.builtAt?.getFullYear()).toBe(2026);
    expect(build?.builtAt?.getMinutes()).toBe(56);
  });

  it("keeps the recipe when the time is missing or unreadable", () => {
    expect(parseCustomizedBuild("1a62bc9025c3")).toEqual({
      recipe: "1a62bc9025c3",
      shortRecipe: "1a62bc9",
      builtAt: null,
    });
    expect(parseCustomizedBuild("1a62bc9025c3 not-a-date")).toEqual({
      recipe: "1a62bc9025c3",
      shortRecipe: "1a62bc9",
      builtAt: null,
    });
  });
});
