import { describe, expect, it } from "vite-plus/test";

import { getMainWindowGlassOptions } from "./DesktopWindow.ts";

describe("getMainWindowGlassOptions", () => {
  it("gives the macOS main window HUD vibrancy behind a transparent page", () => {
    expect(getMainWindowGlassOptions("darwin")).toEqual({
      backgroundColor: "#00000000",
      vibrancy: "hud",
      visualEffectState: "followWindow",
    });
  });

  it("leaves other platforms untouched", () => {
    expect(getMainWindowGlassOptions("linux")).toEqual({});
    expect(getMainWindowGlassOptions("win32")).toEqual({});
  });
});
