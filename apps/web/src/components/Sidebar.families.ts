// A thread an agent opened through T3 tools nests under its opener, as deep as the chain goes,
// within one section. A settled child stays folded under an unsettled opener and moves to Settled
// with the family; otherwise each thread keeps its own section. A delegated task (`delegate_task`)
// always follows its delegator's section and hides while the delegator is not shown.

import type { SidebarThreadStatus } from "./Sidebar.logic";

/** Upper bound on opener chains, so corrupt data can never spin. */
const MAX_FAMILY_DEPTH = 32;

export interface SidebarThreadNode<T> {
  readonly thread: T;
  readonly children: readonly SidebarThreadNode<T>[];
  /** 1 right under the family's head. */
  readonly depth: number;
}

export interface SidebarThreadFamily<T> {
  readonly head: T;
  readonly children: readonly SidebarThreadNode<T>[];
}

/**
 * Group one section's threads, in display order, into families. Heads keep
 * their place; children follow their head in the order the section lists
 * them. `parentKeyOf` names the thread that opened a thread, or null.
 */
export function buildSidebarThreadFamilies<T>(
  threads: readonly T[],
  keyOf: (thread: T) => string,
  parentKeyOf: (thread: T) => string | null,
): SidebarThreadFamily<T>[] {
  const byKey = new Map(threads.map((thread) => [keyOf(thread), thread] as const));
  const headKeyOf = (thread: T): string => {
    const ownKey = keyOf(thread);
    const seen = new Set([ownKey]);
    let currentKey = ownKey;
    let current = thread;
    for (let depth = 0; depth < MAX_FAMILY_DEPTH; depth += 1) {
      const parentKey = parentKeyOf(current);
      const parent = parentKey === null ? undefined : byKey.get(parentKey);
      if (parentKey === null || parent === undefined) return currentKey;
      // A cycle has no head, so its threads stay on their own.
      if (seen.has(parentKey)) return ownKey;
      seen.add(parentKey);
      currentKey = parentKey;
      current = parent;
    }
    return ownKey;
  };

  const childrenByParent = new Map<string, T[]>();
  const heads: T[] = [];
  for (const thread of threads) {
    if (headKeyOf(thread) === keyOf(thread)) {
      heads.push(thread);
      continue;
    }
    // Only a thread whose walk reached a head gets here, so its opener is in the list.
    const parentKey = parentKeyOf(thread)!;
    const children = childrenByParent.get(parentKey);
    if (children === undefined) childrenByParent.set(parentKey, [thread]);
    else children.push(thread);
  }
  const nodesUnder = (parentKey: string, depth: number): SidebarThreadNode<T>[] =>
    (childrenByParent.get(parentKey) ?? []).map((thread) => ({
      thread,
      children: nodesUnder(keyOf(thread), depth + 1),
      depth,
    }));
  return heads.map((head) => ({ head, children: nodesUnder(keyOf(head), 1) }));
}

/**
 * Settled threads whose opener chain (through settled openers only) reaches an unsettled
 * thread move to that thread's section; the rest, including those with a missing opener,
 * stay in Settled. When the opener settles too, the whole family lands in Settled together.
 */
export function placeSettledChildThreads<T, S>(
  settled: readonly T[],
  keyOf: (thread: T) => string,
  parentKeyOf: (thread: T) => string | null,
  liveSectionOf: (key: string) => S | null,
): { readonly settled: T[]; readonly moved: { readonly thread: T; readonly section: S }[] } {
  const settledByKey = new Map(settled.map((thread) => [keyOf(thread), thread] as const));
  const stay: T[] = [];
  const moved: { thread: T; section: S }[] = [];
  for (const thread of settled) {
    let section: S | null = null;
    let current = thread;
    const seen = new Set([keyOf(thread)]);
    for (let depth = 0; depth < MAX_FAMILY_DEPTH; depth += 1) {
      const parentKey = parentKeyOf(current);
      if (parentKey === null || seen.has(parentKey)) break;
      section = liveSectionOf(parentKey);
      if (section !== null) break;
      const parent = settledByKey.get(parentKey);
      if (parent === undefined) break;
      seen.add(parentKey);
      current = parent;
    }
    if (section === null) stay.push(thread);
    else moved.push({ thread, section });
  }
  return { settled: stay, moved };
}

/**
 * The section each delegated child renders in: its delegator's, found through
 * delegated ancestors up to the first thread `sectionOf` places. A child whose
 * chain ends at a thread that is not shown stays hidden (`hidden`).
 */
export function placeDelegatedChildThreads<T, S>(
  delegated: readonly T[],
  keyOf: (thread: T) => string,
  delegatorKeyOf: (thread: T) => string,
  sectionOf: (key: string) => S | null,
): { readonly placed: { readonly thread: T; readonly section: S }[]; readonly hidden: T[] } {
  const delegatedByKey = new Map(delegated.map((thread) => [keyOf(thread), thread] as const));
  const placed: { thread: T; section: S }[] = [];
  const hidden: T[] = [];
  for (const thread of delegated) {
    let section: S | null = null;
    let current = thread;
    const seen = new Set([keyOf(thread)]);
    for (let depth = 0; depth < MAX_FAMILY_DEPTH; depth += 1) {
      const delegatorKey = delegatorKeyOf(current);
      if (seen.has(delegatorKey)) break;
      section = sectionOf(delegatorKey);
      if (section !== null) break;
      const delegator = delegatedByKey.get(delegatorKey);
      if (delegator === undefined) break;
      seen.add(delegatorKey);
      current = delegator;
    }
    if (section === null) hidden.push(thread);
    else placed.push({ thread, section });
  }
  return { placed, hidden };
}

/**
 * Puts delegated workers and settled children in the sections they render in
 * (the lists change in place). Workers come first, so a settled thread a
 * worker opened finds the worker wherever it renders and folds under it.
 * Returns the workers whose delegator is not shown.
 */
export function placeChildThreadSections<T>(input: {
  /** Pinned, active, working and snoozed, in any order. */
  readonly live: readonly T[][];
  readonly settled: T[];
  readonly delegated: readonly T[];
  readonly keyOf: (thread: T) => string;
  readonly openerKeyOf: (thread: T) => string | null;
  readonly delegatorKeyOf: (thread: T) => string;
}): { readonly hidden: T[] } {
  const sectionByKey = new Map<string, T[]>();
  for (const list of [...input.live, input.settled]) {
    for (const thread of list) sectionByKey.set(input.keyOf(thread), list);
  }
  const delegated = placeDelegatedChildThreads(
    input.delegated,
    input.keyOf,
    input.delegatorKeyOf,
    (key) => sectionByKey.get(key) ?? null,
  );
  for (const { thread, section } of delegated.placed) section.push(thread);
  const liveSectionByKey = new Map<string, T[]>();
  for (const list of input.live) {
    for (const thread of list) liveSectionByKey.set(input.keyOf(thread), list);
  }
  const placed = placeSettledChildThreads(
    input.settled,
    input.keyOf,
    input.openerKeyOf,
    (key) => liveSectionByKey.get(key) ?? null,
  );
  input.settled.splice(0, input.settled.length, ...placed.settled);
  for (const { thread, section } of placed.moved) section.push(thread);
  return { hidden: delegated.hidden };
}

/**
 * Pages a section by family, so a child never shows without its head; the family of
 * `keepKey` (the open thread) joins past the page. `hiddenCount` counts threads left out,
 * `nextPageCount` the threads the next `pageSize` families bring.
 */
export function pageSidebarThreadFamilies<T>(
  threads: readonly T[],
  keyOf: (thread: T) => string,
  parentKeyOf: (thread: T) => string | null,
  options: { readonly limit: number; readonly keepKey: string | null; readonly pageSize: number },
): { readonly visible: T[]; readonly hiddenCount: number; readonly nextPageCount: number } {
  const families = buildSidebarThreadFamilies(threads, keyOf, parentKeyOf);
  if (families.length <= options.limit) {
    return { visible: flattenSidebarThreadFamilies(families), hiddenCount: 0, nextPageCount: 0 };
  }
  const shown = families.slice(0, options.limit);
  const rest = families.slice(options.limit);
  const kept =
    options.keepKey === null
      ? undefined
      : rest.find((family) =>
          flattenSidebarThreadFamilies([family]).some(
            (thread) => keyOf(thread) === options.keepKey,
          ),
        );
  if (kept !== undefined) shown.push(kept);
  const hidden = rest.filter((family) => family !== kept);
  const sizeOf = (family: SidebarThreadFamily<T>) => flattenSidebarThreadFamilies([family]).length;
  return {
    visible: flattenSidebarThreadFamilies(shown),
    hiddenCount: hidden.reduce((count, family) => count + sizeOf(family), 0),
    nextPageCount: hidden
      .slice(0, options.pageSize)
      .reduce((count, family) => count + sizeOf(family), 0),
  };
}

/** Nodes and everything under them, in tree order. */
export function flattenSidebarThreadNodes<T>(nodes: readonly SidebarThreadNode<T>[]): T[] {
  return nodes.flatMap((node) => [node.thread, ...flattenSidebarThreadNodes(node.children)]);
}

/** Heads then their descendants, the order rows render and keys traverse. */
export function flattenSidebarThreadFamilies<T>(families: readonly SidebarThreadFamily<T>[]): T[] {
  return families.flatMap((family) => [family.head, ...flattenSidebarThreadNodes(family.children)]);
}

/**
 * Collapsed, a family still shows children that need the user and the open thread; working
 * ones show only on the disclosure row. Expanded, live children come first and settled ones
 * sit behind an "N settled" row, open while `settledShown`. A family in Settled passes no
 * `isSettled`, so all its children show.
 */
export function foldSidebarThreadFamily<T>(
  children: readonly T[],
  input: {
    readonly collapsed: boolean;
    readonly keepVisible: (thread: T) => boolean;
    readonly isSettled?: (thread: T) => boolean;
    readonly settledShown?: boolean;
  },
): {
  readonly shown: readonly T[];
  readonly hidden: readonly T[];
  /** Settled children behind the "N settled" row; empty while collapsed. */
  readonly settled: readonly T[];
} {
  const shown: T[] = [];
  const hidden: T[] = [];
  const settled: T[] = [];
  for (const child of children) {
    if (input.keepVisible(child)) shown.push(child);
    else if (input.collapsed) hidden.push(child);
    else if (input.isSettled?.(child) === true) {
      settled.push(child);
      if (input.settledShown !== true) hidden.push(child);
    } else shown.push(child);
  }
  return { shown, hidden, settled };
}

/**
 * Folds by head key. Outside Settled a family is expanded unless in `collapsed`; in Settled it
 * is collapsed unless expanded during this stay (`expandedInSettled`, keyed by head key and
 * `settledEntryOf`), so every entry into Settled starts collapsed. `pruneChildThreadFolds`
 * drops expansions of heads outside Settled and folds of threads that are gone.
 */
export interface ChildThreadFolds {
  readonly collapsed: readonly string[];
  readonly expandedInSettled: readonly string[];
}

/** Where a family's head renders: Settled carries the stay it belongs to. */
export type ChildThreadFoldPlace =
  | { readonly section: "live"; readonly headKey: string }
  | { readonly section: "settled"; readonly headKey: string; readonly entry: string };

/**
 * One stay of a head in Settled. A new settle changes `settledAt`; a snooze sets `snoozedAt`
 * (kept by a timed wake); a manual wake clears it and stamps `lastSnoozeWakeAt`. So a head that
 * wakes back into Settled starts a new stay, also on a device that never saw it snoozed.
 */
export function settledEntryOf(head: {
  readonly settledAt: string | null;
  readonly snoozedAt: string | null;
  readonly lastSnoozeWakeAt?: string | null | undefined;
}): string {
  return `${head.settledAt ?? ""}|${head.snoozedAt ?? ""}|${head.lastSnoozeWakeAt ?? ""}`;
}

const settledFoldKey = (headKey: string, entry: string) => `${headKey}@${entry}`;
const settledFoldHeadKey = (key: string) => key.slice(0, key.lastIndexOf("@"));

/**
 * Where a folded head is now: in Settled, elsewhere (live, snoozed,
 * archived), gone (its environment is loaded and has no such thread), or
 * unknown (its environment is not loaded yet).
 */
export type ChildThreadFoldHeadState = "settled" | "elsewhere" | "gone" | "unknown";

/**
 * Judges folded heads against the loaded threads for `pruneChildThreadFolds`. `isInSettled`
 * uses the thread's own state, or returns null while it cannot tell (no server config). Keys
 * (`<environmentId>:...`) of an environment with no loaded threads are not judged either.
 */
export function childThreadFoldHeadStateOf<T extends { readonly environmentId: string }>(
  threads: readonly T[],
  keyOf: (thread: T) => string,
  isInSettled: (thread: T) => boolean | null,
): (headKey: string) => ChildThreadFoldHeadState {
  const byKey = new Map(threads.map((thread) => [keyOf(thread), thread] as const));
  const environments = new Set(threads.map((thread) => thread.environmentId));
  return (headKey) => {
    const thread = byKey.get(headKey);
    if (thread !== undefined) {
      const inSettled = isInSettled(thread);
      return inSettled === null ? "unknown" : inSettled ? "settled" : "elsewhere";
    }
    return environments.has(headKey.slice(0, headKey.indexOf(":"))) ? "gone" : "unknown";
  };
}

/**
 * Drops folds that no longer apply: a Settled expansion once its head is
 * outside Settled (so the next entry starts collapsed), and any fold of a
 * thread that is gone. Returns `folds` itself when nothing changes, and each
 * list itself when only the other one changes.
 */
export function pruneChildThreadFolds(
  folds: ChildThreadFolds,
  stateOf: (headKey: string) => ChildThreadFoldHeadState,
): ChildThreadFolds {
  const collapsed = folds.collapsed.filter((key) => stateOf(key) !== "gone");
  const expandedInSettled = folds.expandedInSettled.filter((key) => {
    const state = stateOf(settledFoldHeadKey(key));
    return state === "settled" || state === "unknown";
  });
  const collapsedKept = collapsed.length === folds.collapsed.length;
  const expandedKept = expandedInSettled.length === folds.expandedInSettled.length;
  if (collapsedKept && expandedKept) return folds;
  // An untouched list keeps its identity, so a store only rewrites what changed.
  return {
    collapsed: collapsedKept ? folds.collapsed : collapsed,
    expandedInSettled: expandedKept ? folds.expandedInSettled : expandedInSettled,
  };
}

export function isChildThreadFamilyCollapsed(
  folds: ChildThreadFolds,
  place: ChildThreadFoldPlace,
): boolean {
  return place.section === "settled"
    ? !folds.expandedInSettled.includes(settledFoldKey(place.headKey, place.entry))
    : folds.collapsed.includes(place.headKey);
}

/** Flips one family; the chevron and the menu item both call this. */
export function toggleChildThreadFamily(
  folds: ChildThreadFolds,
  place: ChildThreadFoldPlace,
): ChildThreadFolds {
  if (place.section === "live") {
    return {
      ...folds,
      collapsed: folds.collapsed.includes(place.headKey)
        ? folds.collapsed.filter((key) => key !== place.headKey)
        : [...folds.collapsed, place.headKey],
    };
  }
  const key = settledFoldKey(place.headKey, place.entry);
  // An earlier stay's expansion no longer applies, so it goes either way.
  const others = folds.expandedInSettled.filter(
    (entry) => settledFoldHeadKey(entry) !== place.headKey,
  );
  return {
    ...folds,
    expandedInSettled: folds.expandedInSettled.includes(key) ? others : [...others, key],
  };
}

export function childThreadNeedsUser(status: SidebarThreadStatus): boolean {
  return status === "approval" || status === "input" || status === "request";
}

/** A child that is still working or waits on the user keeps its family. */
export function childThreadStillRuns(status: SidebarThreadStatus): boolean {
  return status === "preparing" || status === "working" || childThreadNeedsUser(status);
}

/**
 * A family's disclosure row: "6 child threads · 1 failed · 2 working · 3 settled".
 * A settled child counts as settled, whatever it last did.
 */
export function formatChildThreadsLabel(
  children: readonly {
    readonly status: SidebarThreadStatus;
    readonly isUnread: boolean;
    readonly settled?: boolean;
  }[],
): string {
  let failed = 0;
  let unread = 0;
  let working = 0;
  let settled = 0;
  for (const child of children) {
    if (child.settled === true) settled += 1;
    else if (child.status === "failed" || child.status === "limited") failed += 1;
    else if (child.isUnread) unread += 1;
    else if (
      child.status === "preparing" ||
      child.status === "working" ||
      child.status === "waiting"
    )
      working += 1;
  }
  return [
    `${children.length} ${children.length === 1 ? "child thread" : "child threads"}`,
    ...(failed > 0 ? [`${failed} failed`] : []),
    ...(unread > 0 ? [`${unread} new`] : []),
    ...(working > 0 ? [`${working} working`] : []),
    ...(settled > 0 ? [`${settled} settled`] : []),
  ].join(" · ");
}

/**
 * What a disclosure row does, for screen readers, which otherwise hear only
 * its summary: "Show 6 child threads of Release notes, 1 failed, 2 working".
 * `summary` is the row's `formatChildThreadsLabel`; the "settled" kind is the
 * family's "N settled" row.
 */
export function formatChildThreadsDisclosureLabel(input: {
  readonly kind: "family" | "settled";
  readonly expanded: boolean;
  readonly count: number;
  readonly headTitle: string;
  readonly summary?: string;
}): string {
  const noun =
    input.kind === "settled"
      ? `settled ${input.count === 1 ? "child thread" : "child threads"}`
      : input.count === 1
        ? "child thread"
        : "child threads";
  // The summary's first part repeats the count.
  const details = input.summary?.split(" · ").slice(1) ?? [];
  return [
    `${input.expanded ? "Hide" : "Show"} ${input.count} ${noun} of ${input.headTitle}`,
    ...details,
  ].join(", ");
}
