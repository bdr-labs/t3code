import { describe, expect, it } from "vite-plus/test";

import {
  applyWindowCard,
  applyWindowGlass,
  resolveWindowCard,
  resolveWindowGlass,
} from "./windowGlass";

describe("resolveWindowGlass", () => {
  it("stays off outside the macOS desktop app", () => {
    expect(resolveWindowGlass({ macDesktop: false, enabled: true, transparency: 50 })).toEqual({
      active: false,
    });
  });

  it("stays off when disabled or fully opaque", () => {
    expect(resolveWindowGlass({ macDesktop: true, enabled: false, transparency: 50 })).toEqual({
      active: false,
    });
    expect(resolveWindowGlass({ macDesktop: true, enabled: true, transparency: 0 })).toEqual({
      active: false,
    });
  });

  it("maps the default onto Rex's blend theme material", () => {
    expect(resolveWindowGlass({ macDesktop: true, enabled: true, transparency: 20 })).toEqual({
      active: true,
      tintAlpha: 0.55,
      shadeAlpha: 0.3,
      cardAlpha: 0.62,
    });
    expect(resolveWindowGlass({ macDesktop: true, enabled: true, transparency: 50 })).toEqual({
      active: true,
      tintAlpha: 0.156,
      shadeAlpha: 0.188,
      cardAlpha: 0.227,
    });
  });

  it("clears both layers at the top and clamps at the ends", () => {
    expect(resolveWindowGlass({ macDesktop: true, enabled: true, transparency: 100 })).toEqual({
      active: true,
      tintAlpha: 0,
      shadeAlpha: 0,
      cardAlpha: 0,
    });
    expect(resolveWindowGlass({ macDesktop: true, enabled: true, transparency: 250 })).toEqual({
      active: true,
      tintAlpha: 0,
      shadeAlpha: 0,
      cardAlpha: 0,
    });
  });
});

describe("resolveWindowCard", () => {
  it("frames the conversation only in the macOS desktop app, with or without glass", () => {
    expect(resolveWindowCard({ macDesktop: true, enabled: true })).toBe(true);
    expect(resolveWindowCard({ macDesktop: true, enabled: false })).toBe(false);
    expect(resolveWindowCard({ macDesktop: false, enabled: true })).toBe(false);
  });
});

describe("applyWindowGlass", () => {
  function fakeRoot() {
    const attributes = new Map<string, string>();
    const properties = new Map<string, string>();
    return {
      attributes,
      properties,
      root: {
        setAttribute: (name: string, value: string) => void attributes.set(name, value),
        removeAttribute: (name: string) => void attributes.delete(name),
        style: {
          setProperty: (name: string, value: string) => void properties.set(name, value),
          removeProperty: (name: string) => void properties.delete(name),
        },
      } as unknown as HTMLElement,
    };
  }

  it("writes the tints and removes them again", () => {
    const { attributes, properties, root } = fakeRoot();
    applyWindowGlass(root, { active: true, tintAlpha: 0.4, shadeAlpha: 0.3, cardAlpha: 0.52 });
    expect(attributes.has("data-window-glass")).toBe(true);
    expect(properties.get("--window-glass-tint")).toBe("40%");
    expect(properties.get("--window-glass-shade")).toBe("30%");
    expect(properties.get("--window-glass-card")).toBe("52%");

    applyWindowGlass(root, { active: false });
    expect(attributes.size).toBe(0);
    expect(properties.size).toBe(0);
  });

  it("sets the card apart from the glass", () => {
    const { attributes, root } = fakeRoot();
    applyWindowCard(root, true);
    applyWindowGlass(root, { active: false });
    expect(attributes.has("data-window-card")).toBe(true);
    expect(attributes.has("data-window-glass")).toBe(false);

    applyWindowCard(root, false);
    expect(attributes.size).toBe(0);
  });
});
