import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "@effect/vitest";
import { Atom } from "effect/reactivity";
import { appAtomRegistry } from "./rpc/atomRegistry";
import {
  activeTargetsAtom,
  activeThreadReferencesAtom,
  classifyThreadReferences,
  referenceActivitySignal,
  referenceHighlightRole,
  roleAtom,
  threadReferenceHighlight,
} from "./threadReferenceHighlight";

const ref = (threadId: string) => ({
  environmentId: EnvironmentId.make("environment-a"),
  threadId: ThreadId.make(threadId),
});
const a = ref("thread-a");
const b = ref("thread-b");
const active = () => appAtomRegistry.get(activeThreadReferencesAtom);

const highlight = threadReferenceHighlight;
const reset = (sessionKey: string | null) =>
  appAtomRegistry.set(activeThreadReferencesAtom, {
    hovered: null,
    sessionKey,
    pinnedBySession: new Map(),
  });
const sessionA = scopedThreadKey(ref("session-a"));
const sessionB = scopedThreadKey(ref("session-b"));
const pinned = () => {
  const state = active();
  return (state.sessionKey && state.pinnedBySession.get(state.sessionKey)) || [];
};

it("keeps pins per session: another session hides them and returning restores them", () => {
  reset(sessionA);
  const unmount = appAtomRegistry.mount(activeTargetsAtom);
  const targets = () => appAtomRegistry.get(activeTargetsAtom);
  try {
    highlight.togglePinned(a);
    highlight.togglePinned(b);
    expect(targets()).toEqual([a, b]);

    highlight.setSession(sessionB);
    expect(targets()).toEqual([]);
    highlight.togglePinned(b);
    expect(targets()).toEqual([b]);

    highlight.setSession(sessionA);
    expect(targets()).toEqual([a, b]);
    highlight.togglePinned(a);
    expect(targets()).toEqual([b]);
    highlight.unpin(b);
    expect(targets()).toEqual([]);
    expect([...active().pinnedBySession.keys()]).toEqual([sessionB]);

    highlight.setSession(null);
    highlight.togglePinned(a);
    expect(targets()).toEqual([]);
    expect([...active().pinnedBySession.keys()]).toEqual([sessionB]);
  } finally {
    unmount();
  }
});

it("clears only the current session's pins and leaves the hover alone", () => {
  reset(sessionA);
  highlight.togglePinned(a);
  highlight.togglePinned(b);
  highlight.setSession(sessionB);
  highlight.togglePinned(a);
  highlight.enter(b);

  highlight.clear();
  expect(pinned()).toEqual([]);
  expect(active().hovered).toEqual(b);
  highlight.setSession(sessionA);
  expect(pinned()).toEqual([a, b]);

  highlight.leave(a);
  expect(active().hovered).toEqual(b);
  highlight.leave(b);
  expect(active().hovered).toBeNull();
});

it("tells a row about a role change only when its own role changes", () => {
  reset(sessionA);
  const listener = vi.fn();
  const rowKey = scopedThreadKey(a);
  const unmount = appAtomRegistry.subscribe(roleAtom(rowKey), listener);
  try {
    highlight.togglePinned(b);
    highlight.setSession(sessionB);
    highlight.setSession(sessionA);
    expect(listener).not.toHaveBeenCalled();

    highlight.togglePinned(a);
    expect(appAtomRegistry.get(roleAtom(rowKey))).toBe("target");
    highlight.setSession(sessionB);
    expect(appAtomRegistry.get(roleAtom(rowKey))).toBeNull();
    expect(listener).toHaveBeenCalledTimes(2);
  } finally {
    unmount();
  }
});

it("activates a hover after it rests 200ms and ends it as soon as the pointer leaves", () => {
  vi.useFakeTimers();
  reset(sessionA);
  const unmount = appAtomRegistry.mount(activeTargetsAtom);
  const targets = () => appAtomRegistry.get(activeTargetsAtom);
  try {
    highlight.togglePinned(a);
    highlight.enter(b);
    vi.advanceTimersByTime(199);
    expect(targets()).toEqual([a]);
    vi.advanceTimersByTime(1);
    expect(targets()).toEqual([a, b]);

    highlight.leave(b);
    expect(targets()).toEqual([a]);

    highlight.enter(a);
    vi.advanceTimersByTime(200);
    expect(targets()).toEqual([a]);
  } finally {
    unmount();
    reset(null);
    vi.useRealTimers();
  }
});

it("classifies targets and the threads that mention or wait on any of them", () => {
  const matches = (mentions: ReadonlyArray<string>, waits: ReadonlyArray<string>) => ({
    mentions: new Set(mentions.map((id) => scopedThreadKey(ref(id)))),
    waits: new Set(waits.map((id) => scopedThreadKey(ref(id)))),
    unavailable: 0,
    pending: false,
  });
  const highlight = classifyThreadReferences([a, b], (target) =>
    target.threadId === a.threadId
      ? matches(["mentions-a", "thread-b"], [])
      : matches([], ["waits-on-b"]),
  );
  const role = (threadId: string) =>
    referenceHighlightRole(highlight, scopedThreadKey(ref(threadId)));

  expect(role("thread-a")).toBe("target");
  expect(role("thread-b")).toBe("target");
  expect(role("mentions-a")).toBe("related");
  expect(role("waits-on-b")).toBe("related");
  expect(role("unrelated")).toBeNull();
});

it("refreshes on any shell change and polls only while a thread is running", () => {
  vi.useFakeTimers();
  const shell = (status: "running" | "completed") => ({
    runtime: {
      status,
      activeRunId: null,
      providerInstanceId: ProviderInstanceId.make("codex"),
      providerName: null,
      lastError: null,
    },
  });
  const shells = Atom.make<ReadonlyArray<ReturnType<typeof shell>>>([]).pipe(Atom.keepAlive);
  const signal = referenceActivitySignal(shells);
  const unmount = appAtomRegistry.mount(signal);
  const read = () => appAtomRegistry.get(signal);
  try {
    const idle = read();
    vi.advanceTimersByTime(30_000);
    expect(read()).toBe(idle);

    appAtomRegistry.set(shells, [shell("running")]);
    const started = read();
    expect(started).not.toBe(idle);
    vi.advanceTimersByTime(9_999);
    expect(read()).toBe(started);
    vi.advanceTimersByTime(1);
    expect(read()).not.toBe(started);

    appAtomRegistry.set(shells, [shell("completed")]);
    const ended = read();
    vi.advanceTimersByTime(30_000);
    expect(read()).toBe(ended);
  } finally {
    unmount();
    vi.useRealTimers();
  }
});
