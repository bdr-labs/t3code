import { describe, expect, it } from "vite-plus/test";

import { aboutPanelVersion } from "./DesktopAppIdentity.ts";

describe("aboutPanelVersion", () => {
  it("adds the t3code-customize recipe to the commit", () => {
    expect(aboutPanelVersion("9b150f791b8d", "28d39847f7bb 2026-10-16T11:34:34")).toBe(
      "9b150f791b8d, custom 28d3984",
    );
  });

  it("shows only the commit for a stock build", () => {
    expect(aboutPanelVersion("9b150f791b8d", "")).toBe("9b150f791b8d");
    expect(aboutPanelVersion("9b150f791b8d", "  ")).toBe("9b150f791b8d");
    expect(aboutPanelVersion("unknown", undefined)).toBe("unknown");
  });
});
