import { describe, expect, it } from "vite-plus/test";

import type { GhosttyCell, GhosttyColor, GhosttySnapshot } from "./core";
import { renderGhosttySnapshot } from "./renderer";

const BACKGROUND: GhosttyColor = { r: 13, g: 17, b: 23 };
const RED: GhosttyColor = { r: 200, g: 40, b: 40 };

function cell(background: GhosttyColor): GhosttyCell {
  return {
    text: "",
    wide: 0,
    foreground: { r: 230, g: 237, b: 243 },
    background,
    bold: false,
    italic: false,
    invisible: false,
    strikethrough: false,
    overline: false,
    underline: false,
    selected: false,
  };
}

function render(transparentBackground: boolean) {
  const calls: { op: string; fill: string; args: number[] }[] = [];
  const context = {
    canvas: { width: 40, height: 20 },
    fillStyle: "",
    save() {},
    restore() {},
    resetTransform() {},
    fillRect(...args: number[]) {
      calls.push({ op: "fillRect", fill: String(this.fillStyle), args });
    },
    clearRect(...args: number[]) {
      calls.push({ op: "clearRect", fill: "", args });
    },
  };
  const snapshot: GhosttySnapshot = {
    cols: 2,
    rows: 1,
    foreground: { r: 230, g: 237, b: 243 },
    background: BACKGROUND,
    cursor: { r: 180, g: 203, b: 255 },
    cursorX: 0,
    cursorY: 0,
    cursorVisible: false,
    cursorBlinking: false,
    cursorStyle: 1,
    dirtyRows: new Set([0]),
    rowData: [
      {
        cells: [cell(BACKGROUND), cell(RED)],
        text: "",
        isWrapContinuation: false,
        wrapsToNext: false,
      },
    ],
  };
  renderGhosttySnapshot({
    context: context as unknown as CanvasRenderingContext2D,
    snapshot,
    metrics: { width: 8, height: 16, baseline: 12 },
    fontSize: 12,
    fontFamily: "monospace",
    padding: 4,
    forceFull: true,
    cursorOn: false,
    transparentBackground,
  });
  return calls;
}

describe("renderGhosttySnapshot background", () => {
  it("paints the default background opaque by default", () => {
    const calls = render(false);
    expect(calls.some((call) => call.op === "clearRect")).toBe(false);
    expect(calls[0]).toEqual({ op: "fillRect", fill: "rgb(13, 17, 23)", args: [0, 0, 40, 20] });
  });

  it("clears the default background and keeps colored cells in glass mode", () => {
    const calls = render(true);
    expect(calls.filter((call) => call.op === "fillRect")).toEqual([
      { op: "fillRect", fill: "rgb(200, 40, 40)", args: [12, 4, 8, 16] },
    ]);
    expect(calls.filter((call) => call.op === "clearRect").map((call) => call.args)).toEqual([
      [0, 0, 40, 20],
      [4, 4, 16, 16],
    ]);
  });
});
