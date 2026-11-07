import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  runAtomCommand,
} from "@t3tools/client-runtime/state/runtime";
import {
  threadChipCopyTarget,
  type ThreadReferenceCopyTarget,
} from "@t3tools/client-runtime/thread-reference";
import {
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  encodeComposerContextFragment,
} from "@t3tools/shared/composerContextClipboard";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import {
  DRAFT_THREAD_TITLE,
  type DraftId,
  draftThreadTitle,
  useComposerDraftStore,
} from "../composerDraftStore";
import { connectionAtomRuntime } from "../connection/runtime";
import { configuredHostedAppUrl } from "../hostedPairing";
import { writeTextToClipboard } from "../hooks/useCopyToClipboard";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { readProject } from "../state/entities";

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
  const ref = scopeThreadRef(draft.environmentId, draft.threadId);
  return threadChipCopyTarget(
    ref,
    useComposerDraftStore.getState().getDraftTitleByRef(ref) ?? DRAFT_THREAD_TITLE,
    configuredHostedAppUrl(),
  );
}

/**
 * A draft's thread id is picked when the draft opens and kept through the first send, so this
 * reference resolves the moment the thread starts.
 */
export async function copyDraftThreadReference(draftId: DraftId): Promise<void> {
  const draft = useComposerDraftStore.getState().getDraftSession(draftId);
  if (draft === null || draft.promotedTo) return;
  shareDraftThreadReference(draftId);
  await copyThreadReference(draftThreadCopyTarget(draft));
}

// A reserve and a release of one thread go out in order, so a quick discard cannot land first.
const reservationLanes = createAtomCommandScheduler();
const oneLanePerThread = {
  mode: "serial",
  key: (target: {
    readonly environmentId: EnvironmentId;
    readonly input: { readonly threadId: ThreadId };
  }) => `${target.environmentId}\u0000${target.input.threadId}`,
} as const;
const draftReservation = {
  reserve: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "draft thread reservation",
    tag: ORCHESTRATION_V2_WS_METHODS.reserveDraftThread,
    scheduler: reservationLanes,
    concurrency: oneLanePerThread,
  }),
  release: createEnvironmentRpcCommand(connectionAtomRuntime, {
    label: "draft thread release",
    tag: ORCHESTRATION_V2_WS_METHODS.releaseDraftThread,
    scheduler: reservationLanes,
    concurrency: oneLanePerThread,
  }),
};

interface DraftReservation {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly title: string;
  readonly projectTitle: string | null;
}

const TITLE_RESERVE_INTERVAL_MS = 2_000;
/** What each shared draft's server last heard from this client. */
const reserved = new Map<DraftId, DraftReservation>();
const titleTimers = new Map<DraftId, ReturnType<typeof setTimeout>>();

type DraftStoreState = ReturnType<typeof useComposerDraftStore.getState>;

function sharedReservation(state: DraftStoreState, draftId: DraftId): DraftReservation | null {
  const draft = state.draftThreadsByThreadKey[draftId];
  if (!draft?.referenceShared || draft.promotedTo) return null;
  const project = readProject(scopeProjectRef(draft.environmentId, draft.projectId));
  return {
    environmentId: draft.environmentId,
    threadId: draft.threadId,
    title: (draftThreadTitle(state.draftsByThreadKey[draftId]) ?? DRAFT_THREAD_TITLE).slice(0, 200),
    projectTitle: project && !project.isScratch ? project.title.slice(0, 200) : null,
  };
}

const sameReservation = (left: DraftReservation, right: DraftReservation) =>
  left.environmentId === right.environmentId &&
  left.threadId === right.threadId &&
  left.title === right.title &&
  left.projectTitle === right.projectTitle;

// Best effort: a failed call logs, and an agent then gets the wording for an unknown id.
function reserve(draftId: DraftId, reservation: DraftReservation) {
  clearTimeout(titleTimers.get(draftId));
  titleTimers.delete(draftId);
  reserved.set(draftId, reservation);
  const { environmentId, ...input } = reservation;
  void runAtomCommand(appAtomRegistry, draftReservation.reserve, { environmentId, input });
}

function release(draftId: DraftId) {
  const reservation = reserved.get(draftId);
  clearTimeout(titleTimers.get(draftId));
  titleTimers.delete(draftId);
  reserved.delete(draftId);
  if (reservation === undefined) return;
  void runAtomCommand(appAtomRegistry, draftReservation.release, {
    environmentId: reservation.environmentId,
    input: { threadId: reservation.threadId },
  });
}

/**
 * The draft's reference left this client. It names a machine, so automatic routing stops moving
 * the draft from here on, and that machine keeps the draft's title for agents.
 */
export function shareDraftThreadReference(draftId: DraftId): void {
  const store = useComposerDraftStore.getState();
  const draft = store.getDraftSession(draftId);
  if (draft !== null && !draft.promotedTo && draft.environmentSelection !== "manual") {
    store.setDraftThreadContext(draftId, {
      environmentSelection: "manual",
      loadBalancedEnvironmentId: null,
    });
  }
  store.markDraftReferenceShared(draftId);
  const reservation = sharedReservation(useComposerDraftStore.getState(), draftId);
  if (reservation !== null) reserve(draftId, reservation);
}

/** A thread picked into a message: shares it when it is a draft on this client. */
export function shareThreadReference(ref: ScopedThreadRef): void {
  const draftId = useComposerDraftStore.getState().getDraftIdByRef(ref);
  if (draftId !== null) shareDraftThreadReference(draftId);
}

/**
 * Keeps each shared draft's reservation current for the life of the page: a new title at most
 * every 2 seconds, and a release when the draft is discarded, sent or moved to another machine.
 * Drafts shared before this page loaded write themselves back at their next title change.
 */
export function startDraftThreadReservations(): () => void {
  const initial = useComposerDraftStore.getState();
  for (const draftId of Object.keys(initial.draftThreadsByThreadKey) as DraftId[]) {
    const reservation = sharedReservation(initial, draftId);
    if (reservation !== null) reserved.set(draftId, reservation);
  }
  const reserveTitleLater = (draftId: DraftId) => {
    if (titleTimers.has(draftId)) return;
    titleTimers.set(
      draftId,
      setTimeout(() => {
        titleTimers.delete(draftId);
        const reservation = sharedReservation(useComposerDraftStore.getState(), draftId);
        const previous = reserved.get(draftId);
        if (reservation === null || (previous && sameReservation(reservation, previous))) return;
        reserve(draftId, reservation);
      }, TITLE_RESERVE_INTERVAL_MS),
    );
  };
  const unsubscribe = useComposerDraftStore.subscribe((state, previous) => {
    if (
      state.draftThreadsByThreadKey === previous.draftThreadsByThreadKey &&
      state.draftsByThreadKey === previous.draftsByThreadKey
    ) {
      return;
    }
    for (const [draftId, sent] of reserved) {
      const draft = state.draftThreadsByThreadKey[draftId];
      // A starting thread outlives its reservation; it is released once the draft is gone.
      if (draft?.promotedTo) continue;
      if (
        !draft?.referenceShared ||
        draft.environmentId !== sent.environmentId ||
        draft.threadId !== sent.threadId
      ) {
        release(draftId);
      }
    }
    for (const [key, draft] of Object.entries(state.draftThreadsByThreadKey)) {
      const draftId = key as DraftId;
      if (!draft.referenceShared || draft.promotedTo) continue;
      if (
        reserved.has(draftId) &&
        draft === previous.draftThreadsByThreadKey[draftId] &&
        state.draftsByThreadKey[draftId] === previous.draftsByThreadKey[draftId]
      ) {
        continue;
      }
      const reservation = sharedReservation(state, draftId);
      const sent = reserved.get(draftId);
      if (reservation !== null && !(sent && sameReservation(reservation, sent))) {
        reserveTitleLater(draftId);
      }
    }
  });
  return () => {
    unsubscribe();
    for (const timer of titleTimers.values()) clearTimeout(timer);
    titleTimers.clear();
    reserved.clear();
  };
}
