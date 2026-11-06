import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  decodeComposerContextFragment,
} from "@t3tools/shared/composerContextClipboard";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const clipboard = vi.hoisted(() => ({
  write: vi.fn<(value: string, target: string, extra?: Record<string, string>) => Promise<boolean>>(
    async () => true,
  ),
}));
vi.mock("../hooks/useCopyToClipboard", () => ({ writeTextToClipboard: clipboard.write }));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: vi.fn() },
}));

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import { copyDraftThreadReference } from "./copyThreadReference";

const environmentId = EnvironmentId.make("env-draft");
const threadId = ThreadId.make("thread-reserved");
const draftId = DraftId.make("draft-reserved");

function openDraft() {
  useComposerDraftStore
    .getState()
    .setLogicalProjectDraftThreadId(
      "logical-project",
      scopeProjectRef(environmentId, ProjectId.make("project")),
      draftId,
      { threadId, environmentSelection: "auto", loadBalancedEnvironmentId: null },
    );
}

describe("copyDraftThreadReference", () => {
  beforeEach(() => {
    clipboard.write.mockClear();
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    });
    openDraft();
  });

  it("copies a link and a chip that name the id the draft keeps", async () => {
    await copyDraftThreadReference(draftId);

    const [value, , extra] = clipboard.write.mock.calls[0]!;
    expect(parseThreadLinkHref(value)).toEqual({ environmentId, threadId });
    const fragment = decodeComposerContextFragment(extra![COMPOSER_CONTEXT_CLIPBOARD_MIME]!);
    expect(fragment?.records).toMatchObject([
      { kind: "thread", environmentId, threadId, title: "New thread" },
    ]);
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.threadId).toBe(threadId);
  });

  it("stops automatic routing from moving the draft off the machine the copy names", async () => {
    await copyDraftThreadReference(draftId);

    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
      environmentId,
      environmentSelection: "manual",
      loadBalancedEnvironmentId: null,
    });
  });

  it("copies nothing for a draft already on its way to being a thread", async () => {
    useComposerDraftStore.getState().markDraftThreadPromoting(draftId);

    await copyDraftThreadReference(draftId);

    expect(clipboard.write).not.toHaveBeenCalled();
  });
});
