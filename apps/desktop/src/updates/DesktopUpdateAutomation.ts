import * as Context from "effect/Context";

declare const __T3CODE_CUSTOMIZED_BUILD__: string | undefined;

/**
 * How much of an update the app does without being asked. Stock builds only check and
 * wait for the user to download and restart. A t3code-customize build downloads a new
 * release as soon as the check finds it and lets Squirrel install it when the user quits
 * the app normally; it never restarts the app for an update on its own.
 */
export interface DesktopUpdateAutomationPolicy {
  readonly autoDownload: boolean;
  readonly installOnQuit: boolean;
}

export const STOCK_UPDATE_AUTOMATION: DesktopUpdateAutomationPolicy = {
  autoDownload: false,
  installOnQuit: false,
};

/** The policy for a build stamped with T3CODE_CUSTOMIZED_BUILD ("<recipe> <build time>"). */
export const resolveDesktopUpdateAutomation = (
  customizedBuild: string | undefined = typeof __T3CODE_CUSTOMIZED_BUILD__ === "undefined"
    ? undefined
    : __T3CODE_CUSTOMIZED_BUILD__,
): DesktopUpdateAutomationPolicy =>
  customizedBuild?.trim()
    ? { autoDownload: true, installOnQuit: true }
    : STOCK_UPDATE_AUTOMATION;

export const DesktopUpdateAutomation = Context.Reference<DesktopUpdateAutomationPolicy>(
  "@t3tools/desktop/updates/DesktopUpdateAutomation",
  { defaultValue: () => resolveDesktopUpdateAutomation() },
);
