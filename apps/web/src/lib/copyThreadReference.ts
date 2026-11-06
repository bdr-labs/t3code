import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  threadChipCopyTarget,
  type ThreadReferenceCopyTarget,
} from "@t3tools/client-runtime/thread-reference";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextFragment,
} from "@t3tools/shared/composerContextClipboard";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { DRAFT_THREAD_TITLE, type DraftId, useComposerDraftStore } from "../composerDraftStore";
import { configuredHostedAppUrl } from "../hostedPairing";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";

export async function copyThreadReference(target: ThreadReferenceCopyTarget): Promise<void> {
  const fragment = target.fragment ? encodeComposerContextFragment(target.fragment) : null;
  try {
    const didCopy = await writeTextToClipboard(
      target.value,
      target.clipboardTarget,
      fragment ? { [COMPOSER_CONTEXT_CLIPBOARD_MIME]: fragment } : undefined,
    );
    if (!didCopy) return;
    toastManager.add({
      type: "success",
      title: target.successTitle,
      description: target.description,
    });
  } catch (error) {
    console.error(error);
    toastManager.add(
      stackedThreadToast({
        type: "error",
        title: target.failureTitle,
        description: error instanceof Error ? error.message : "An error occurred.",
      }),
    );
  }
}

/** What copying a draft copies: the thread it will become, on the machine it is on now. */
export function draftThreadCopyTarget(draft: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}): ThreadReferenceCopyTarget {
  return threadChipCopyTarget(
    scopeThreadRef(draft.environmentId, draft.threadId),
    DRAFT_THREAD_TITLE,
    configuredHostedAppUrl(),
  );
}

/**
 * A draft's thread id is picked when the draft opens and kept through the first send, so this
 * reference resolves the moment the thread starts. It also names a machine, so automatic routing
 * stops moving the draft from here on.
 */
export async function copyDraftThreadReference(draftId: DraftId): Promise<void> {
  const store = useComposerDraftStore.getState();
  const draft = store.getDraftSession(draftId);
  if (draft === null || draft.promotedTo) return;
  if (draft.environmentSelection !== "manual") {
    store.setDraftThreadContext(draftId, {
      environmentSelection: "manual",
      loadBalancedEnvironmentId: null,
    });
  }
  await copyThreadReference(draftThreadCopyTarget(draft));
}
