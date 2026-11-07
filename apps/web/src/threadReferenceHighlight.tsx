import { useAtomValue } from "@effect/atom-react";
import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { request } from "@t3tools/client-runtime/rpc";
import { createEnvironmentQueryAtomFamily } from "@t3tools/client-runtime/state/runtime";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/shell";
import {
  ORCHESTRATION_V2_WS_METHODS,
  type EnvironmentId,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { AsyncResult, Atom } from "effect/reactivity";
import { useLayoutEffect } from "react";
import { connectionAtomRuntime } from "./connection/runtime";
import { appAtomRegistry } from "./rpc/atomRegistry";
import { environmentPresentations } from "./state/presentation";
import { environmentThreadShells } from "./state/threads";

export type ThreadReferenceHighlightRole = "target" | "related" | null;
type ThreadRuntime = Parameters<typeof threadRuntimeIsActive>[0];

export interface ActiveThreadReferences {
  readonly hovered: ScopedThreadRef | null;
  /** The routed thread's key, or a draft's reserved one; null where no session is open. */
  readonly sessionKey: string | null;
  readonly pinnedBySession: ReadonlyMap<string, ReadonlyArray<ScopedThreadRef>>;
}

export interface ThreadReferenceMatches {
  readonly mentions: ReadonlySet<string>;
  readonly waits: ReadonlySet<string>;
  readonly unavailable: number;
  readonly pending: boolean;
}

export interface ThreadReferenceHighlight {
  readonly targetKeys: ReadonlySet<string>;
  readonly relatedKeys: ReadonlySet<string>;
  readonly matchesByTarget: ReadonlyMap<string, ThreadReferenceMatches>;
}

const key = (ref: ScopedThreadRef) => scopedThreadKey(ref);
const sameRef = (left: ScopedThreadRef, right: ScopedThreadRef) => key(left) === key(right);

export const activeThreadReferencesAtom = Atom.make<ActiveThreadReferences>({
  hovered: null,
  sessionKey: null,
  pinnedBySession: new Map(),
}).pipe(Atom.keepAlive, Atom.withLabel("thread-reference-highlight:active"));

const NO_PINS: ReadonlyArray<ScopedThreadRef> = [];
const sessionPins = (state: ActiveThreadReferences) =>
  (state.sessionKey !== null && state.pinnedBySession.get(state.sessionKey)) || NO_PINS;
const update = (next: (state: ActiveThreadReferences) => ActiveThreadReferences) =>
  appAtomRegistry.update(activeThreadReferencesAtom, next);
const updateSessionPins = (
  next: (pins: ReadonlyArray<ScopedThreadRef>) => ReadonlyArray<ScopedThreadRef>,
) =>
  update((state) => {
    if (state.sessionKey === null) return state;
    const pins = sessionPins(state);
    const nextPins = next(pins);
    if (nextPins === pins) return state;
    const pinnedBySession = new Map(state.pinnedBySession);
    if (nextPins.length === 0) pinnedBySession.delete(state.sessionKey);
    else pinnedBySession.set(state.sessionKey, nextPins);
    return { ...state, pinnedBySession };
  });

export const threadReferenceHighlight = {
  enter: (target: ScopedThreadRef) => update((state) => ({ ...state, hovered: target })),
  leave: (target: ScopedThreadRef) =>
    update((state) =>
      state.hovered && sameRef(state.hovered, target) ? { ...state, hovered: null } : state,
    ),
  setSession: (sessionKey: string | null) =>
    update((state) => (state.sessionKey === sessionKey ? state : { ...state, sessionKey })),
  unpin: (target: ScopedThreadRef) =>
    updateSessionPins((pins) =>
      pins.some((ref) => sameRef(ref, target)) ? pins.filter((ref) => !sameRef(ref, target)) : pins,
    ),
  togglePinned: (target: ScopedThreadRef) =>
    updateSessionPins((pins) =>
      pins.some((ref) => sameRef(ref, target))
        ? pins.filter((ref) => !sameRef(ref, target))
        : [...pins, target],
    ),
  clear: () => updateSessionPins(() => NO_PINS),
};

/** The one writer of the session. Unmounted, as in a closed phone sheet, it shows no session. */
export function useThreadReferenceSession(sessionKey: string | null) {
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes the route's session to the shared highlight store before paint
  useLayoutEffect(() => {
    threadReferenceHighlight.setSession(sessionKey);
    return () => threadReferenceHighlight.setSession(null);
  }, [sessionKey]);
}

const hoveredAtom = Atom.make((get) => get(activeThreadReferencesAtom).hovered);
const settledHoverAtom = hoveredAtom.pipe(Atom.debounce("200 millis"));

/** This session's pins plus a hover that has rested 200ms. Leaving a target ends its hover at once. */
export const activeTargetsAtom = Atom.make((get): ReadonlyArray<ScopedThreadRef> => {
  const settled = get(settledHoverAtom);
  const state = get(activeThreadReferencesAtom);
  const { hovered } = state;
  const pinned = sessionPins(state);
  return hovered && settled && sameRef(hovered, settled) && !pinned.some((r) => sameRef(r, hovered))
    ? [...pinned, hovered]
    : pinned;
});

/**
 * Changes whenever references may have changed. Quiet shells hold still through a run's streaming
 * ticks, so a mention added mid-run would wait for the run to end; a running thread polls instead.
 */
export const referenceActivitySignal = (
  shells: Atom.Atom<ReadonlyArray<{ readonly runtime: ThreadRuntime }>>,
) => {
  let revision = 0;
  return Atom.make((get) => {
    if (get(shells).some((thread) => threadRuntimeIsActive(thread.runtime))) {
      const timer = setTimeout(() => get.refreshSelf(), 10_000);
      get.addFinalizer(() => clearTimeout(timer));
    }
    return ++revision;
  });
};

const referenceActivityAtom = referenceActivitySignal(
  environmentThreadShells.quietThreadShellsAtom.pipe(Atom.debounce("500 millis")),
);

const references = createEnvironmentQueryAtomFamily(connectionAtomRuntime, {
  label: "thread-references",
  staleTimeMs: 10_000,
  idleTtlMs: 10_000,
  refreshTrigger: () => referenceActivityAtom,
  execute: Effect.fn("ThreadReferences.read")(function* (input: {
    sourceEnvironmentId: EnvironmentId;
    target: ScopedThreadRef;
  }) {
    return yield* request(ORCHESTRATION_V2_WS_METHODS.getThreadReferences, {
      ...input,
      knownThreads: appAtomRegistry.get(environmentThreadShells.threadRefsAtom),
    });
  }),
});

export function classifyThreadReferences(
  targets: ReadonlyArray<ScopedThreadRef>,
  matchesFor: (target: ScopedThreadRef) => ThreadReferenceMatches,
): ThreadReferenceHighlight {
  const targetKeys = new Set(targets.map(key));
  const relatedKeys = new Set<string>();
  const matchesByTarget = new Map<string, ThreadReferenceMatches>();
  for (const target of targets) {
    const matches = matchesFor(target);
    matchesByTarget.set(key(target), matches);
    for (const threadKey of [...matches.mentions, ...matches.waits]) {
      if (!targetKeys.has(threadKey)) relatedKeys.add(threadKey);
    }
  }
  return { targetKeys, relatedKeys, matchesByTarget };
}

export const referenceHighlightRole = (
  highlight: ThreadReferenceHighlight,
  threadKey: string,
): ThreadReferenceHighlightRole =>
  highlight.targetKeys.has(threadKey)
    ? "target"
    : highlight.relatedKeys.has(threadKey)
      ? "related"
      : null;

const NO_HIGHLIGHT: ThreadReferenceHighlight = {
  targetKeys: new Set(),
  relatedKeys: new Set(),
  matchesByTarget: new Map(),
};

const highlightAtom = Atom.make((get): ThreadReferenceHighlight => {
  const targets = get(activeTargetsAtom);
  if (targets.length === 0) return NO_HIGHLIGHT;
  const environmentIds = [...get(environmentPresentations.presentationsAtom).keys()];
  const shells = get(environmentThreadShells.quietThreadShellsAtom);
  return classifyThreadReferences(targets, (target) => {
    const mentions = new Set<string>();
    const waits = new Set<string>();
    let unavailable = 0;
    let pending = false;
    for (const environmentId of environmentIds) {
      const result = get(
        references({ environmentId, input: { sourceEnvironmentId: environmentId, target } }),
      );
      const data = AsyncResult.getOrElse(result, () => null);
      for (const threadId of data?.mentions ?? []) mentions.add(key({ environmentId, threadId }));
      for (const threadId of data?.waits ?? []) waits.add(key({ environmentId, threadId }));
      if (AsyncResult.isFailure(result)) unavailable++;
      if (result.waiting && !data) pending = true;
    }
    for (const thread of shells) {
      if (
        thread.environmentId === target.environmentId &&
        thread.pendingBackgroundTasks?.some(
          (task) => task.kind === "subagent" && task.childThreadId === target.threadId,
        )
      ) {
        waits.add(key({ environmentId: thread.environmentId, threadId: thread.id }));
      }
    }
    return { mentions, waits, unavailable, pending };
  });
}).pipe(Atom.withLabel("thread-reference-highlight:matches"));

// One atom per thread, so a highlight change re-renders only the rows and chips whose role changed.
export const roleAtom = Atom.family((threadKey: string) =>
  Atom.make((get) => referenceHighlightRole(get(highlightAtom), threadKey)),
);
const matchesAtom = Atom.family((threadKey: string) =>
  Atom.make((get) => get(highlightAtom).matchesByTarget.get(threadKey) ?? null),
);
const pinnedAtom = Atom.make((get) => sessionPins(get(activeThreadReferencesAtom)));
const isPinnedAtom = Atom.family((threadKey: string) =>
  Atom.make((get) => get(pinnedAtom).some((ref) => key(ref) === threadKey)),
);
const hasSessionAtom = Atom.make((get) => get(activeThreadReferencesAtom).sessionKey !== null);

export const usePinnedThreadReferences = () => useAtomValue(pinnedAtom);
export const useIsThreadReferencePinned = (threadKey: string) =>
  useAtomValue(isPinnedAtom(threadKey));
export const useHasThreadReferenceSession = () => useAtomValue(hasSessionAtom);
export const useReferenceHighlightRole = (threadKey: string) => useAtomValue(roleAtom(threadKey));
export const useReferenceMatches = (threadKey: string) => useAtomValue(matchesAtom(threadKey));
