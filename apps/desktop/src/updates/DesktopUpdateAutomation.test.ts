import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as DesktopUpdateAutomation from "./DesktopUpdateAutomation.ts";
import * as DesktopUpdates from "./DesktopUpdates.ts";
import { flushCallbacks, makeHarness } from "./updatesTestHarness.ts";

const CUSTOMIZED = DesktopUpdateAutomation.resolveDesktopUpdateAutomation("0123456789ab 2026-10-16T21:00:00");

// A check that finds a release, as electron-updater reports it while checkForUpdates runs.
const harnessFindingUpdate = (automation: DesktopUpdateAutomation.DesktopUpdateAutomationPolicy) => {
  let emit: (eventName: string, payload?: unknown) => void = () => {};
  const harness = makeHarness({
    automation,
    checkForUpdates: Effect.sync(() => emit("update-available", { version: "1.2.4" })),
  });
  emit = harness.emit;
  return harness;
};

describe("DesktopUpdateAutomation", () => {
  it("automates updates only in a build stamped by t3code-customize", () => {
    assert.deepEqual(CUSTOMIZED, { autoDownload: true, installOnQuit: true });
    for (const stamp of [undefined, "", "   "]) {
      assert.deepEqual(
        DesktopUpdateAutomation.resolveDesktopUpdateAutomation(stamp),
        DesktopUpdateAutomation.STOCK_UPDATE_AUTOMATION,
      );
    }
  });

  it.effect("a customized build downloads what a check finds and installs it on quit only", () => {
    const harness = harnessFindingUpdate(CUSTOMIZED);

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        assert.equal(harness.autoDownload(), false);
        assert.equal(harness.autoInstallOnAppQuit(), true);

        const result = yield* updates.check("manual");
        assert.equal(result.checked, true);
        yield* flushCallbacks;
        yield* flushCallbacks;

        assert.equal(harness.downloadCount(), 1);
        harness.emit("update-downloaded", { version: "1.2.4" });
        yield* flushCallbacks;
        assert.equal((yield* updates.getState).status, "downloaded");
        // Installing waits for the user to quit; nothing restarts the app.
        assert.equal(harness.quitAndInstalls(), 0);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });

  it.effect("a stock build leaves the download and the install to the user", () => {
    const harness = harnessFindingUpdate(DesktopUpdateAutomation.STOCK_UPDATE_AUTOMATION);

    return Effect.scoped(
      Effect.gen(function* () {
        const updates = yield* DesktopUpdates.DesktopUpdates;
        yield* updates.configure;
        assert.equal(harness.autoInstallOnAppQuit(), false);

        yield* updates.check("manual");
        yield* flushCallbacks;
        yield* flushCallbacks;

        assert.equal((yield* updates.getState).status, "available");
        assert.equal(harness.downloadCount(), 0);
        assert.equal(harness.quitAndInstalls(), 0);
      }),
    ).pipe(Effect.provide(Layer.merge(TestClock.layer(), harness.layer)));
  });
});
