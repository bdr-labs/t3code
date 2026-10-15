// What a family's children are doing (patches-tt/0003), shared by the web sidebar and the
// mobile thread list: one kind per child, the chips a family's disclosure row shows, the order
// its live children list in, the fold that keeps settled children behind one "+N settled" row,
// and the role an agent gave a child in its title.

/** The thread statuses a family cares about (the sidebar's inbox statuses). */
export type ChildThreadStatus =
  | "approval"
  | "input"
  | "request"
  | "preparing"
  | "working"
  | "waiting"
  | "failed"
  | "limited"
  | "ready";

/**
 * One child, in the order chips and live rows list: what needs the user first, settled last.
 * "done" finished and was seen but is not settled; "new" finished and was not seen yet.
 */
export type ChildThreadKind = "needs-you" | "failed" | "new" | "working" | "done" | "settled";

export const CHILD_THREAD_KINDS: readonly ChildThreadKind[] = [
  "needs-you",
  "failed",
  "new",
  "working",
  "done",
  "settled",
];

export const CHILD_THREAD_KIND_LABEL: Readonly<Record<ChildThreadKind, string>> = {
  "needs-you": "needs you",
  failed: "failed",
  new: "new",
  working: "working",
  done: "done",
  settled: "settled",
};

/**
 * A child that waits on the user or still works is never settled; a settled child counts as
 * settled whatever it last did.
 */
export function childThreadKindOf(input: {
  readonly status: ChildThreadStatus;
  readonly isUnread: boolean;
  readonly settled: boolean;
}): ChildThreadKind {
  const { status } = input;
  if (status === "approval" || status === "input" || status === "request") return "needs-you";
  if (status === "preparing" || status === "working") return "working";
  if (input.settled) return "settled";
  if (status === "failed" || status === "limited") return "failed";
  if (status === "waiting") return "working";
  return input.isUnread ? "new" : "done";
}

export interface ChildThreadChip {
  readonly kind: ChildThreadKind;
  readonly count: number;
}

/**
 * The disclosure row's chips, in kind order. Expanded, the "+N settled" row already counts the
 * settled children, so their chip shows only while the family is collapsed.
 */
export function childThreadChipsOf(
  kinds: readonly ChildThreadKind[],
  input: { readonly collapsed: boolean },
): readonly ChildThreadChip[] {
  const counts = new Map<ChildThreadKind, number>();
  for (const kind of kinds) counts.set(kind, (counts.get(kind) ?? 0) + 1);
  return CHILD_THREAD_KINDS.flatMap((kind) => {
    const count = counts.get(kind) ?? 0;
    if (count === 0 || (kind === "settled" && !input.collapsed)) return [];
    return [{ kind, count }];
  });
}

/** "1 needs you", for a chip's tooltip and accessible name. */
export function formatChildThreadChipLabel(chip: ChildThreadChip): string {
  return `${chip.count} ${CHILD_THREAD_KIND_LABEL[chip.kind]}`;
}

/**
 * A family's summary for screen readers and tooltips: "12 child threads · 1 working · 11
 * settled". Every kind counts, whatever the fold shows.
 */
export function formatChildThreadKindsLabel(kinds: readonly ChildThreadKind[]): string {
  return [
    `${kinds.length} ${kinds.length === 1 ? "child thread" : "child threads"}`,
    ...childThreadChipsOf(kinds, { collapsed: true }).map(formatChildThreadChipLabel),
  ].join(" · ");
}

export interface ChildThreadFamilyFold<T> {
  /** Rows under the disclosure, in order: live children by kind, then a settled open thread. */
  readonly shown: readonly T[];
  /** Settled children behind the "+N settled" row; the open thread is never among them. */
  readonly settled: readonly T[];
  /** Whether the "+N settled" row renders. */
  readonly settledRow: boolean;
  /** Whether the settled children render, above the "+N settled" row. */
  readonly settledShown: boolean;
  /** Whether the chip row renders: false when every child is settled. */
  readonly disclosure: boolean;
  readonly chips: readonly ChildThreadChip[];
  /** Children that render nowhere right now. */
  readonly hidden: readonly T[];
  /** `formatChildThreadKindsLabel` of every child. */
  readonly summary: string;
}

/**
 * Every child that is not settled shows, needs-you first; all settled children sit behind one
 * "+N settled" row, open while `settledOpen`. Collapsed, only the chips show, plus children
 * that wait on the user or failed and the open thread, which shows wherever it is. A family
 * whose children are all settled has no chip row, just the "+N settled" row.
 */
export function foldChildThreadFamily<T>(
  children: readonly T[],
  input: {
    readonly kindOf: (child: T) => ChildThreadKind;
    readonly isOpen: (child: T) => boolean;
    readonly collapsed: boolean;
    readonly settledOpen: boolean;
  },
): ChildThreadFamilyFold<T> {
  const kinds = new Map<T, ChildThreadKind>(children.map((child) => [child, input.kindOf(child)]));
  const kindOf = (child: T) => kinds.get(child)!;
  const rank = (child: T) => CHILD_THREAD_KINDS.indexOf(kindOf(child));
  // Array#sort is stable, so children of one kind keep the section's order.
  const live = children
    .filter((child) => kindOf(child) !== "settled")
    .sort((left, right) => rank(left) - rank(right));
  const openSettled = children.filter(
    (child) => kindOf(child) === "settled" && input.isOpen(child),
  );
  const settled = children.filter((child) => kindOf(child) === "settled" && !input.isOpen(child));
  const disclosure = live.length > 0;
  const collapsed = disclosure && input.collapsed;
  const shownLive = collapsed
    ? live.filter(
        (child) =>
          input.isOpen(child) || kindOf(child) === "needs-you" || kindOf(child) === "failed",
      )
    : live;
  const settledRow = settled.length > 0 && !collapsed;
  const settledShown = settledRow && input.settledOpen;
  const shown = [...shownLive, ...openSettled];
  const visible = new Set<T>([...shown, ...(settledShown ? settled : [])]);
  return {
    shown,
    settled,
    settledRow,
    settledShown,
    disclosure,
    chips: disclosure ? childThreadChipsOf([...kinds.values()], { collapsed }) : [],
    hidden: children.filter((child) => !visible.has(child)),
    summary: formatChildThreadKindsLabel([...kinds.values()]),
  };
}

/** What an agent opened a child for, read from the title prefix its opener gave it. */
export type ChildThreadRole = "review" | "fix" | "worker" | "step" | "build";

export const CHILD_THREAD_ROLE_LABEL: Readonly<Record<ChildThreadRole, string>> = {
  review: "Review",
  fix: "Fix",
  worker: "Worker",
  step: "Step",
  build: "Build",
};

/**
 * "Rev #12 herstel" is a fix, "Rev #12" a review, "W: e2e" a worker, "S2: migration" a plan
 * step; anything else builds. Until threads carry a role, the title is all there is.
 */
export function childThreadRoleOf(title: string): ChildThreadRole {
  const trimmed = title.trim();
  if (/\bherstel\b|^fix\b/i.test(trimmed)) return "fix";
  if (/^rev(iew)?\b/i.test(trimmed)) return "review";
  if (/^W:/.test(trimmed)) return "worker";
  if (/^S\d+:/.test(trimmed)) return "step";
  return "build";
}

/** The distinct roles among `titles`, in role order, for the "+N settled" row's icons. */
export function childThreadRolesOf(titles: readonly string[]): readonly ChildThreadRole[] {
  const roles = new Set(titles.map(childThreadRoleOf));
  return (Object.keys(CHILD_THREAD_ROLE_LABEL) as ChildThreadRole[]).filter((role) =>
    roles.has(role),
  );
}
