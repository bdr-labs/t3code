import { describe, expect, it } from "vite-plus/test";

import {
  applyCompactSlashEntry,
  COMPACT_DISABLED_REASONS,
  compactSlashEntry,
} from "./composerCompact.logic";

const idle = {
  providerListsCompact: true,
  manualCompactionProviderAvailable: true,
  hasActiveThread: true,
  isServerThread: true,
  hasCompactableConversation: true,
  canOperateThread: true,
  hasActiveProject: true,
  hasPendingApproval: false,
  hasPendingUserInput: false,
  isWorking: false,
  hasComposerAttachments: false,
  compactThreadUnavailable: false,
  prompt: "/comp",
  trigger: { kind: "slash-command", query: "comp", rangeStart: 0, rangeEnd: 5 },
} as const;

const R = COMPACT_DISABLED_REASONS;

describe("compactSlashEntry", () => {
  it("is enabled for an idle thread with only the trigger in the prompt", () => {
    expect(compactSlashEntry(idle)).toBe("enabled");
    expect(compactSlashEntry({ ...idle, prompt: "/comp  \n" })).toBe("enabled");
  });

  it("returns the same object for the same reason, so the menu's items stay memoized", () => {
    const working = { ...idle, isWorking: true };
    expect(compactSlashEntry(working)).toBe(compactSlashEntry(working));
  });

  it.each([
    ["the provider does not list compact", { providerListsCompact: false }],
    ["no provider can compact", { manualCompactionProviderAvailable: false }],
    ["there is no thread", { hasActiveThread: false }],
    ["the thread is a draft", { isServerThread: false }],
    ["the thread has no conversation", { hasCompactableConversation: false }],
    ["no slash trigger is open", { trigger: null }],
    [
      "text comes before the trigger",
      {
        prompt: "hello /comp",
        trigger: { kind: "slash-command", query: "comp", rangeStart: 6, rangeEnd: 11 },
      },
    ],
    ["text comes after the trigger", { prompt: "/comp and more" }],
  ] as const)("is hidden when %s", (_name, change) => {
    expect(compactSlashEntry({ ...idle, ...change })).toBe("hidden");
  });

  it("stays hidden whatever would disable it", () => {
    expect(
      compactSlashEntry({
        ...idle,
        hasCompactableConversation: false,
        isWorking: true,
        hasPendingApproval: true,
        hasComposerAttachments: true,
      }),
    ).toBe("hidden");
  });

  // Each row keeps every later blocker on, so it also proves it wins over them.
  it.each([
    ["canOperateThread", { canOperateThread: false }, R.cannotOperate],
    ["hasActiveProject", { hasActiveProject: false }, R.noProject],
    ["hasPendingApproval", {}, R.pendingApproval],
    ["hasPendingUserInput", { hasPendingApproval: false }, R.pendingInput],
    ["isWorking", { hasPendingApproval: false, hasPendingUserInput: false }, R.working],
    [
      "hasComposerAttachments",
      { hasPendingApproval: false, hasPendingUserInput: false, isWorking: false },
      R.composerAttachments,
    ],
    [
      "compactThreadUnavailable",
      {
        hasPendingApproval: false,
        hasPendingUserInput: false,
        isWorking: false,
        hasComposerAttachments: false,
      },
      R.unavailable,
    ],
  ] as const)("disables on %s, first match winning", (_name, change, disabledReason) => {
    expect(
      compactSlashEntry({
        ...idle,
        hasPendingApproval: true,
        hasPendingUserInput: true,
        isWorking: true,
        hasComposerAttachments: true,
        compactThreadUnavailable: true,
        ...change,
      }),
    ).toEqual({ disabledReason });
  });
});

describe("applyCompactSlashEntry", () => {
  const compact = { id: "compact", command: { name: "compact" } };
  const review = { id: "review", command: { name: "review" } };

  it("changes /compact alone, leaving every other command the same object", () => {
    const hidden = applyCompactSlashEntry([compact, review], "hidden");
    expect(hidden).toEqual([review]);
    expect(hidden[0]).toBe(review);

    const disabled = applyCompactSlashEntry([compact, review], { disabledReason: "Wait." });
    expect(disabled).toEqual([{ ...compact, disabledReason: "Wait." }, review]);
    expect(disabled[1]).toBe(review);

    expect(applyCompactSlashEntry([compact, review], "enabled")).toEqual([compact, review]);
  });
});
