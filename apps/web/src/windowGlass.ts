/**
 * Window glass for the macOS desktop app: the main window has native HUD
 * vibrancy behind a transparent page; this decides how strongly the window
 * tint, its shade and the main content card cover it.
 */

import { MAX_WINDOW_TRANSPARENCY } from "@t3tools/contracts/settings";

export type WindowGlassInput = Readonly<{
  /** True only in the Electron app on macOS, where the window has vibrancy. */
  macDesktop: boolean;
  enabled: boolean;
  /** 0 (opaque) to 100 (most glass). */
  transparency: number;
}>;

export type WindowGlass =
  | Readonly<{ active: false }>
  | Readonly<{ active: true; tintAlpha: number; shadeAlpha: number; cardAlpha: number }>;

const TINT_CURVE = Math.log(0.55) / Math.log(0.8);
const CARD_CURVE = Math.log(0.62) / Math.log(0.8);

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/**
 * Maps the transparency setting onto Rex's dark glass as measured next to it:
 * at the default (20) a 55% canvas tint under a 30% black shade, and a 62%
 * canvas card. Tints fall off along a power curve and clear at 100.
 */
export function resolveWindowGlass(input: WindowGlassInput): WindowGlass {
  if (!input.macDesktop || !input.enabled) return { active: false };
  const t = clamp01(input.transparency / MAX_WINDOW_TRANSPARENCY);
  if (t === 0) return { active: false };
  return {
    active: true,
    tintAlpha: round((1 - t) ** TINT_CURVE),
    shadeAlpha: round(0.375 * (1 - t)),
    cardAlpha: round((1 - t) ** CARD_CURVE),
  };
}

/**
 * The conversation card (gap, corners, rim, shadow) is a separate switch: it
 * frames the conversation with or without the glass behind it.
 */
export function resolveWindowCard(
  input: Readonly<{ macDesktop: boolean; enabled: boolean }>,
): boolean {
  return input.macDesktop && input.enabled;
}

export function applyWindowCard(root: HTMLElement, card: boolean): void {
  if (card) root.setAttribute("data-window-card", "");
  else root.removeAttribute("data-window-card");
}

export function applyWindowGlass(root: HTMLElement, glass: WindowGlass): void {
  if (!glass.active) {
    root.removeAttribute("data-window-glass");
    root.style.removeProperty("--window-glass-tint");
    root.style.removeProperty("--window-glass-shade");
    root.style.removeProperty("--window-glass-card");
    return;
  }
  root.setAttribute("data-window-glass", "");
  root.style.setProperty("--window-glass-tint", `${Math.round(glass.tintAlpha * 1000) / 10}%`);
  root.style.setProperty("--window-glass-shade", `${Math.round(glass.shadeAlpha * 1000) / 10}%`);
  root.style.setProperty("--window-glass-card", `${Math.round(glass.cardAlpha * 1000) / 10}%`);
}
