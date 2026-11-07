import { threadChipCopyTarget } from "@t3tools/client-runtime/thread-reference";
import { type ComposerContextClipboardFragment, EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextFragment,
} from "@t3tools/shared/composerContextClipboard";
import { threadContextRecord } from "@t3tools/shared/composerContextReferences";
import { describe, expect, it } from "vite-plus/test";

import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { ProjectId } from "@t3tools/contracts";

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { composerThreadTitle, readPastedComposerContext } from "./composerInlineTokenPaste";
import { importPastedComposerText } from "./composerInlineTokenPaste";

const thread = {
  environmentId: EnvironmentId.make("env-1"),
  threadId: ThreadId.make("thread-1"),
};
const clipboard = (data: Record<string, string>) => ({
  getData: (type: string) => data[type] ?? "",
});
const chip = (title: string) =>
  `[${title}](t3-context://v1/thread/${threadContextRecord(thread, title).contextId})`;

/** Imports every record it is offered, as the composer does for a thread its agent can read. */
const importAll =
  (imported: Array<ComposerContextClipboardFragment>) =>
  (fragment: ComposerContextClipboardFragment) => {
    imported.push(fragment);
    return new Map(fragment.records.map((record) => [record.contextId, record.contextId]));
  };

describe("importPastedComposerText", () => {
  it("pastes a copied thread link back as the chip it was copied from", () => {
    const target = threadChipCopyTarget(thread, "Fix the login flow");
    const imported: Array<ComposerContextClipboardFragment> = [];
    const text = importPastedComposerText(
      clipboard({
        "text/plain": `See ${target.value}`,
        [COMPOSER_CONTEXT_CLIPBOARD_MIME]: encodeComposerContextFragment(target.fragment!)!,
      }),
      importAll(imported),
    );
    expect(text).toBe(`See ${chip("Fix the login flow")}`);
    expect(imported.map((fragment) => fragment.records)).toEqual([target.fragment!.records]);
  });

  it("makes a chip of a v2 link pasted without T3's clipboard format", () => {
    const text = importPastedComposerText(
      clipboard({ "text/plain": "[Login](t3-thread://v2/env-1/thread-1)" }),
      importAll([]),
    );
    expect(text).toBe(chip("Login"));
  });

  it("keeps the link when the composer cannot take the thread", () => {
    const pasted = "https://app.t3.codes/threads/env-1/thread-1";
    expect(importPastedComposerText(clipboard({ "text/plain": pasted }), () => new Map())).toBe(
      pasted,
    );
  });
});

describe("composerThreadTitle", () => {
  const openDraft = () =>
    useComposerDraftStore
      .getState()
      .setLogicalProjectDraftThreadId(
        "logical-project",
        scopeProjectRef(thread.environmentId, ProjectId.make("project")),
        DraftId.make("draft-1"),
        { threadId: thread.threadId },
      );
  const closeDraft = () =>
    useComposerDraftStore.getState().clearDraftThread(DraftId.make("draft-1"));

  it("names nothing for a thread that is gone, so a stale mention attaches no chip", () => {
    closeDraft();
    expect(composerThreadTitle(thread)).toBeUndefined();
  });

  it("names a draft that holds the id, and a plain pasted link to it", () => {
    openDraft();
    expect(composerThreadTitle(thread)).toBe("New thread");
    const fragment = readPastedComposerContext(
      clipboard({ "text/plain": threadChipCopyTarget(thread, "ignored").value }),
    );
    expect(fragment?.records).toMatchObject([{ kind: "thread", title: "New thread" }]);
    useComposerDraftStore.getState().setPrompt(DraftId.make("draft-1"), "Fix the login form");
    expect(composerThreadTitle(thread)).toBe("Fix the login form");
    closeDraft();
  });
});
