// Child threads in the sidebar (patches-tt/0003). Family rules live in Sidebar.families.ts;
// this module holds the sidebar's state and rendering so Sidebar.tsx only calls into it.
import type { EnvironmentServerConfig } from "@t3tools/client-runtime/connection";
import { scopeThreadRef, scopedThreadKey } from "@t3tools/client-runtime/environment";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/models";
import {
  childThreadKindOf,
  childThreadRolesOf,
  foldChildThreadFamily,
  type ChildThreadChip,
  type ChildThreadKind,
  type ChildThreadRole,
} from "@t3tools/client-runtime/state/thread-family-summary";
import { effectiveSnoozed } from "@t3tools/client-runtime/state/thread-settled";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  ChevronRightIcon,
  CircleAlertIcon,
  CircleCheckIcon,
  CircleDashedIcon,
  CircleDotDashedIcon,
  CircleIcon,
  CodeIcon,
  EyeIcon,
  HammerIcon,
  ListChecksIcon,
  MessageCircleQuestionIcon,
  ShieldQuestionIcon,
  UserRoundIcon,
  WrenchIcon,
} from "lucide-react";
import { useEffect, useState, type ComponentType, type ReactElement, type ReactNode } from "react";

import { useLocalStorage } from "../hooks/useLocalStorage";
import { cn } from "~/lib/utils";
import { useUiStateStore } from "../uiStateStore";
import {
  buildSidebarThreadFamilies,
  childThreadFoldHeadStateOf,
  childThreadStillRuns,
  flattenSidebarThreadFamilies,
  formatChildThreadsDisclosureLabel,
  isChildThreadFamilyCollapsed,
  pageSidebarThreadFamilies,
  placeChildThreadSections,
  pruneChildThreadFolds,
  settledEntryOf,
  toggleChildThreadFamily,
  type ChildThreadFoldPlace,
  type ChildThreadFolds,
  type SidebarThreadFamily,
} from "./Sidebar.families";
import {
  hasUnseenCompletion,
  resolveSidebarThreadStatus,
  resolveThreadLastVisitedAt,
  type SidebarSection,
} from "./Sidebar.logic";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

// Folded families (ChildThreadFolds in Sidebar.families.ts): heads the user
// collapsed outside Settled, and `<head key>@<settled entry>` for families the
// user expanded during their current stay in Settled, where they start
// collapsed.
const COLLAPSED_CHILD_THREADS_KEY = "t3code:sidebar:collapsed-child-threads";
const EXPANDED_SETTLED_CHILD_THREADS_KEY = "t3code:sidebar:expanded-settled-child-threads";
const ChildThreadFoldKeys = Schema.Array(Schema.String);
const EMPTY_KEYS: readonly string[] = [];
const EMPTY_THREADS: readonly EnvironmentThreadShell[] = [];

/**
 * A family as rendered (foldChildThreadFamily in childThreadSummary.ts): `children` are the
 * rows under the chip row, live ones by kind; settled ones sit behind one "+N settled" row.
 */
export interface RenderedChildThreadFamily extends SidebarThreadFamily<EnvironmentThreadShell> {
  readonly hidden: readonly EnvironmentThreadShell[];
  readonly hasChildren: boolean;
  readonly collapsed: boolean;
  readonly place: ChildThreadFoldPlace;
  /** Settled children behind the family's "+N settled" row. */
  readonly settled: readonly EnvironmentThreadShell[];
  readonly settledRow: boolean;
  readonly settledShown: boolean;
  /** False when every child is settled: then the "+N settled" row is the whole family. */
  readonly disclosure: boolean;
  readonly chips: readonly ChildThreadChip[];
  /** Every child's kind, for the disclosure's accessible name. */
  readonly summary: string;
  /** Every child. */
  readonly all: readonly EnvironmentThreadShell[];
}

const threadShellKey = (thread: Pick<EnvironmentThreadShell, "environmentId" | "id">) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.id));

// A settled child under an opener that is not settled folds behind its
// family's "+N settled" row until it runs or waits on the user again.
const isFoldedSettledChild = (
  thread: Parameters<typeof resolveSidebarThreadStatus>[0] &
    Pick<EnvironmentThreadShell, "settledOverride">,
) =>
  thread.settledOverride === "settled" && !childThreadStillRuns(resolveSidebarThreadStatus(thread));

/**
 * What a child is doing, for its family's chips, order and status icon. In Settled every child
 * that no longer runs counts as settled; elsewhere a child counts as settled once folded.
 */
export function sidebarChildThreadKindOf(
  thread: Parameters<typeof resolveSidebarThreadStatus>[0] &
    Pick<EnvironmentThreadShell, "settledOverride">,
  section: SidebarSection,
  isUnread: boolean,
): ChildThreadKind {
  const status = resolveSidebarThreadStatus(thread);
  return childThreadKindOf({
    status,
    isUnread,
    settled: section === "settled" ? !childThreadStillRuns(status) : isFoldedSettledChild(thread),
  });
}

const openerKeyOf = (thread: EnvironmentThreadShell) => {
  const openerId = thread.openedByThreadId ?? thread.delegatedByThreadId;
  return openerId === undefined
    ? null
    : scopedThreadKey(scopeThreadRef(thread.environmentId, openerId));
};
// Only called for delegated children; without a delegator a thread names
// itself, which ends the walk and keeps it hidden.
const delegatorKeyOf = (thread: EnvironmentThreadShell) =>
  scopedThreadKey(scopeThreadRef(thread.environmentId, thread.delegatedByThreadId ?? thread.id));

/**
 * Delegated tasks render under the thread that delegated them, in its
 * section; other subagents stay out of the roster. A settled child stays with
 * an opener that is not settled, folded away in its family, and reaches
 * Settled with the opener (Sidebar.families.ts). The lists change in place.
 */
export function placeSidebarChildThreads(input: {
  readonly live: readonly EnvironmentThreadShell[][];
  readonly settled: EnvironmentThreadShell[];
  readonly threads: readonly EnvironmentThreadShell[];
  readonly scopedProjectKeys: ReadonlySet<string> | null;
}): void {
  const { scopedProjectKeys } = input;
  placeChildThreadSections({
    live: input.live,
    settled: input.settled,
    delegated: input.threads.filter(
      (thread) =>
        thread.archivedAt === null &&
        thread.delegatedByThreadId !== undefined &&
        (scopedProjectKeys === null ||
          scopedProjectKeys.has(`${thread.environmentId}:${thread.projectId}`)),
    ),
    keyOf: threadShellKey,
    openerKeyOf,
    delegatorKeyOf,
  });
}

/**
 * The sidebar's sections as families, with each family's fold state. Families start expanded,
 * except in Settled, where each settle starts collapsed and the "+N settled" row is the fold.
 * Collapsed, a family keeps children that need the user or failed, plus the open thread.
 */
export function buildSidebarChildThreadSections(input: {
  readonly pinned: readonly EnvironmentThreadShell[];
  readonly active: readonly EnvironmentThreadShell[];
  readonly working: readonly EnvironmentThreadShell[];
  readonly snoozed: readonly EnvironmentThreadShell[];
  readonly settled: readonly EnvironmentThreadShell[];
  readonly folds: ChildThreadFolds;
  readonly shownSettledKeys: ReadonlySet<string>;
  readonly routeThreadKey: string | null;
  /** Whether a finished child was not seen yet; defaults to the shell's own visit. */
  readonly isUnread?: (thread: EnvironmentThreadShell) => boolean;
}) {
  const isUnread = input.isUnread ?? hasUnseenCompletion;
  const familiesOf = (
    list: readonly EnvironmentThreadShell[],
    section: SidebarSection,
  ): readonly RenderedChildThreadFamily[] =>
    buildSidebarThreadFamilies(list, threadShellKey, openerKeyOf).map((family) => {
      const headKey = threadShellKey(family.head);
      const place: ChildThreadFoldPlace =
        section === "settled"
          ? { section: "settled", headKey, entry: settledEntryOf(family.head) }
          : { section: "live", headKey };
      const collapsed = isChildThreadFamilyCollapsed(input.folds, place);
      const fold = foldChildThreadFamily(family.children, {
        kindOf: (child) => sidebarChildThreadKindOf(child, section, isUnread(child)),
        isOpen: (child) => threadShellKey(child) === input.routeThreadKey,
        collapsed,
        // In Settled every child is settled, so the "+N settled" row is the family's fold.
        settledOpen: section === "settled" ? !collapsed : input.shownSettledKeys.has(headKey),
      });
      return {
        head: family.head,
        children: fold.shown,
        hidden: fold.hidden,
        hasChildren: family.children.length > 0,
        collapsed,
        place,
        settled: fold.settled,
        settledRow: fold.settledRow,
        settledShown: fold.settledShown,
        disclosure: fold.disclosure,
        chips: fold.chips,
        summary: fold.summary,
        all: family.children,
      };
    });
  const sectionFamilies = {
    pinned: familiesOf(input.pinned, "pinned"),
    active: familiesOf(input.active, "active"),
    working: familiesOf(input.working, "working"),
    snoozed: familiesOf(input.snoozed, "snoozed"),
    settled: familiesOf(input.settled, "settled"),
  };
  const orderedThreads = [
    sectionFamilies.pinned,
    sectionFamilies.active,
    sectionFamilies.working,
    sectionFamilies.snoozed,
    sectionFamilies.settled,
  ].flatMap((families) =>
    // An opened "+N settled" row renders its children after the live ones.
    families.flatMap((family) => [
      ...flattenSidebarThreadFamilies([family]),
      ...(family.settledShown ? family.settled : []),
    ]),
  );
  return { sectionFamilies, orderedThreads };
}

/**
 * Settled pages a family at a time. The open thread never hides under "Show more": a deep
 * link or search into a settled thread pulls its family into the visible tail, and a
 * collapsed shelf keeps that family folded down to its head and the open thread.
 */
export function pageSidebarSettledFamilies(input: {
  readonly settledThreads: readonly EnvironmentThreadShell[];
  readonly limit: number;
  readonly pageSize: number;
  readonly shelfExpanded: boolean;
  readonly routeThreadKey: string | null;
}) {
  const page = pageSidebarThreadFamilies(input.settledThreads, threadShellKey, openerKeyOf, {
    limit: input.limit,
    keepKey: input.routeThreadKey,
    pageSize: input.pageSize,
  });
  const renderedSettledThreads = (() => {
    if (input.shelfExpanded) return page.visible;
    if (input.routeThreadKey === null) return EMPTY_THREADS;
    const routeFamily = buildSidebarThreadFamilies(page.visible, threadShellKey, openerKeyOf).find(
      (family) =>
        [family.head, ...family.children].some(
          (thread) => threadShellKey(thread) === input.routeThreadKey,
        ),
    );
    return routeFamily === undefined ? EMPTY_THREADS : flattenSidebarThreadFamilies([routeFamily]);
  })();
  return {
    renderedSettledThreads,
    hiddenSettledCount: page.hiddenCount,
    nextSettledPageCount: page.nextPageCount,
  };
}

/** The sidebar's child-thread state: folds, families, settled paging, toggles. */
export function useSidebarChildThreads(input: {
  readonly threads: readonly EnvironmentThreadShell[];
  readonly serverConfigs: ReadonlyMap<EnvironmentId, EnvironmentServerConfig>;
  readonly snoozeNow: string;
  readonly routeThreadKey: string | null;
  readonly pinnedThreads: readonly EnvironmentThreadShell[];
  readonly activeThreads: readonly EnvironmentThreadShell[];
  readonly visibleWorkingThreads: readonly EnvironmentThreadShell[];
  readonly visibleSnoozedThreads: readonly EnvironmentThreadShell[];
  readonly settledThreads: readonly EnvironmentThreadShell[];
  readonly settledVisibleCount: number;
  readonly settledPageSize: number;
  readonly settledShelfExpanded: boolean;
}) {
  const { threads, serverConfigs, snoozeNow: foldNow, routeThreadKey } = input;
  const [collapsedChildThreadKeys, setCollapsedChildThreadKeys] = useLocalStorage(
    COLLAPSED_CHILD_THREADS_KEY,
    EMPTY_KEYS,
    ChildThreadFoldKeys,
  );
  const [expandedSettledChildThreadKeys, setExpandedSettledChildThreadKeys] = useLocalStorage(
    EXPANDED_SETTLED_CHILD_THREADS_KEY,
    EMPTY_KEYS,
    ChildThreadFoldKeys,
  );
  // Opened "N settled" rows, by head key; they start closed each session.
  const [shownSettledChildThreadKeys, setShownSettledChildThreadKeys] = useState<
    ReadonlySet<string>
  >(() => new Set());
  // Drops folds of families that left Settled or are gone (Sidebar.families.ts),
  // so a family that comes back to Settled starts collapsed again.
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- prunes persisted fold state as threads and the clock change.
  useEffect(() => {
    const stateOf = childThreadFoldHeadStateOf(threads, threadShellKey, (thread) => {
      const capabilities = serverConfigs.get(thread.environmentId)?.environment.capabilities;
      if (capabilities === undefined) return null;
      return (
        thread.archivedAt === null &&
        capabilities.threadSettlement === true &&
        thread.settledOverride === "settled" &&
        !(capabilities.threadSnooze === true && effectiveSnoozed(thread, { now: foldNow }))
      );
    });
    const folds = {
      collapsed: collapsedChildThreadKeys,
      expandedInSettled: expandedSettledChildThreadKeys,
    };
    const pruned = pruneChildThreadFolds(folds, stateOf);
    if (pruned.collapsed !== folds.collapsed) setCollapsedChildThreadKeys(pruned.collapsed);
    if (pruned.expandedInSettled !== folds.expandedInSettled) {
      setExpandedSettledChildThreadKeys(pruned.expandedInSettled);
    }
  }, [
    collapsedChildThreadKeys,
    expandedSettledChildThreadKeys,
    foldNow,
    serverConfigs,
    setCollapsedChildThreadKeys,
    setExpandedSettledChildThreadKeys,
    threads,
  ]);
  const settledPage = pageSidebarSettledFamilies({
    settledThreads: input.settledThreads,
    limit: input.settledVisibleCount,
    pageSize: input.settledPageSize,
    shelfExpanded: input.settledShelfExpanded,
    routeThreadKey,
  });
  const lastVisitedAtById = useUiStateStore((state) => state.threadLastVisitedAtById);
  const { sectionFamilies, orderedThreads } = buildSidebarChildThreadSections({
    pinned: input.pinnedThreads,
    active: input.activeThreads,
    working: input.visibleWorkingThreads,
    snoozed: input.visibleSnoozedThreads,
    settled: settledPage.renderedSettledThreads,
    folds: {
      collapsed: collapsedChildThreadKeys,
      expandedInSettled: expandedSettledChildThreadKeys,
    },
    shownSettledKeys: shownSettledChildThreadKeys,
    routeThreadKey,
    isUnread: (thread) =>
      hasUnseenCompletion({
        ...thread,
        lastVisitedAt: resolveThreadLastVisitedAt(
          thread.lastVisitedAt,
          lastVisitedAtById[threadShellKey(thread)],
        ),
      }),
  });
  const familyByHeadKey = new Map(
    Object.values(sectionFamilies).flatMap((families) =>
      families.map((family) => [threadShellKey(family.head), family] as const),
    ),
  );
  // The disclosure row and the context menu flip the same fold.
  const toggleCollapsed = (family: RenderedChildThreadFamily) => {
    const { place } = family;
    if (place.section === "settled") {
      setExpandedSettledChildThreadKeys(
        (keys) =>
          toggleChildThreadFamily({ collapsed: EMPTY_KEYS, expandedInSettled: keys }, place)
            .expandedInSettled,
      );
    } else {
      setCollapsedChildThreadKeys(
        (keys) =>
          toggleChildThreadFamily({ collapsed: keys, expandedInSettled: EMPTY_KEYS }, place)
            .collapsed,
      );
    }
  };
  // In Settled the "+N settled" row is the family's fold (buildSidebarChildThreadSections).
  const toggleSettledShown = (family: RenderedChildThreadFamily) =>
    family.place.section === "settled"
      ? toggleCollapsed(family)
      : setShownSettledChildThreadKeys((keys) => {
          const next = new Set(keys);
          if (!next.delete(family.place.headKey)) next.add(family.place.headKey);
          return next;
        });
  // Only family heads are list items: children render with their head and
  // never take a drop slot of their own, and drop orders list heads only.
  const headsOf = (list: readonly EnvironmentThreadShell[]) =>
    list.filter((thread) => familyByHeadKey.has(threadShellKey(thread)));
  return {
    ...settledPage,
    orderedThreads,
    headsOf,
    headKeysOf: (list: readonly EnvironmentThreadShell[]) => headsOf(list).map(threadShellKey),
    /**
     * The context menu's "Hide/Show child threads" state, null without children, and null
     * outside Settled when every child is settled: the "+N settled" row is all there is.
     */
    menuStateOf: (headKey: string) => {
      const family = familyByHeadKey.get(headKey);
      if (family === undefined || !family.hasChildren) return null;
      if (!family.disclosure && family.place.section !== "settled") return null;
      return { collapsed: family.collapsed };
    },
    toggleCollapsedOf: (headKey: string) => {
      const family = familyByHeadKey.get(headKey);
      if (family !== undefined) toggleCollapsed(family);
    },
    /**
     * The rows under a head: none without children, and none while the head
     * is dragged (its children stay in place until it lands).
     */
    renderChildren: <P extends { readonly variant: string }>(
      headKey: string,
      section: SidebarSection,
      options: {
        readonly dragging: boolean;
        readonly renderRow: (
          thread: EnvironmentThreadShell,
          section: SidebarSection,
        ) => ReactElement<P>;
        readonly Row: ComponentType<P & { readonly nested?: boolean }>;
      },
    ): ReactNode[] => {
      const family = familyByHeadKey.get(headKey);
      if (family === undefined || !family.hasChildren || options.dragging) return [];
      // A child thread under its head is a slim row that is not sortable.
      const nestedRow = (thread: EnvironmentThreadShell, rowSection: SidebarSection) => {
        const row = options.renderRow(thread, rowSection);
        const {
          sortableId: _sortableId,
          sortableDisabled: _sortableDisabled,
          contextDrag: _contextDrag,
          sortable: _sortable,
          ...rowProps
        } = row.props as P &
          Record<"sortableId" | "sortableDisabled" | "contextDrag" | "sortable", unknown>;
        const { Row } = options;
        return <Row key={row.key} {...(rowProps as unknown as P)} variant="slim" nested />;
      };
      return [
        <SidebarChildThreads
          key={`children:${headKey}`}
          family={family}
          onToggle={toggleCollapsed}
          onToggleSettled={toggleSettledShown}
          settledRows={
            family.settledShown ? family.settled.map((child) => nestedRow(child, "settled")) : null
          }
        >
          {family.children.map((child) => nestedRow(child, section))}
        </SidebarChildThreads>,
      ];
    },
  };
}

export type SidebarChildThreadStatusIcon =
  | "working"
  | "waiting"
  | "input"
  | "request"
  | "approval"
  | "failed"
  | "done"
  | "new"
  | "woke";

function SidebarStatusIcon(props: { icon: SidebarChildThreadStatusIcon; className?: string }) {
  const className = cn("size-4 shrink-0", props.className);
  switch (props.icon) {
    case "working":
      return <CircleDashedIcon aria-hidden className={className} />;
    case "waiting":
      return <CircleDotDashedIcon aria-hidden className={className} />;
    case "input":
      return <MessageCircleQuestionIcon aria-hidden className={className} />;
    case "request":
      return <UserRoundIcon aria-hidden className={className} />;
    case "approval":
      return <ShieldQuestionIcon aria-hidden className={className} />;
    case "failed":
      return <CircleAlertIcon aria-hidden className={className} />;
    case "done":
      return <CircleCheckIcon aria-hidden className={className} />;
    case "new":
      // A filled dot, like an unread mark, in the same box as the other icons.
      return (
        <span aria-hidden className={cn("inline-flex items-center justify-center", className)}>
          <CircleIcon className="size-2 fill-current" />
        </span>
      );
    case "woke":
      return null;
  }
}

/** A child's status icon: the row's own status while it runs or failed, else its kind. */
export function sidebarChildRowStatusOf(input: {
  readonly kind: ChildThreadKind;
  readonly topStatus: {
    readonly label: string;
    readonly icon: SidebarChildThreadStatusIcon;
    readonly className: string;
  } | null;
}): { label: string; icon: SidebarChildThreadStatusIcon; className: string } {
  const { kind, topStatus } = input;
  if (
    topStatus !== null &&
    (kind === "needs-you" || kind === "working" || kind === "failed") &&
    topStatus.icon !== "woke"
  ) {
    return topStatus;
  }
  return CHILD_THREAD_KIND_STATUS[kind];
}

const CHILD_THREAD_KIND_STATUS: Record<
  ChildThreadKind,
  { label: string; icon: SidebarChildThreadStatusIcon; className: string }
> = {
  "needs-you": {
    label: "Needs you",
    icon: "input",
    className: "text-warning-foreground",
  },
  failed: { label: "Failed", icon: "failed", className: "text-error-foreground" },
  // Green like done: an unseen result is finished work, not a call to act; the dot marks unseen.
  new: { label: "New", icon: "new", className: "text-success-foreground" },
  working: { label: "Working", icon: "working", className: "text-info-foreground" },
  done: { label: "Done", icon: "done", className: "text-success-foreground" },
  settled: { label: "Settled", icon: "done", className: "text-muted-foreground/60" },
};

/**
 * A child row has no room for the card's status label; the colored icon
 * alone shows what each child is doing.
 */
export function SidebarChildThreadStatus(props: {
  status: { label: string; icon: SidebarChildThreadStatusIcon; className: string };
  testId?: string;
}) {
  const { status } = props;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <span
            role="img"
            aria-label={status.label}
            data-testid={props.testId ?? "sidebar-child-thread-status"}
            className={cn("inline-flex shrink-0 items-center", status.className)}
          />
        }
      >
        <SidebarStatusIcon icon={status.icon} />
      </TooltipTrigger>
      <TooltipPopup side="top">{status.label}</TooltipPopup>
    </Tooltip>
  );
}

const CHILD_THREAD_ROLE_ICON: Record<ChildThreadRole, ComponentType<{ className?: string }>> = {
  review: EyeIcon,
  fix: WrenchIcon,
  worker: HammerIcon,
  step: ListChecksIcon,
  build: CodeIcon,
};

const CHILD_THREAD_ROLE_CLASS_NAME: Record<ChildThreadRole, string> = {
  review: "text-violet-600 dark:text-violet-300",
  fix: "text-warning-foreground",
  worker: "text-info-foreground",
  step: "text-success-foreground",
  build: "text-muted-foreground",
};

/** What the agent opened a child for, from its title; a settled child's role recedes. */
export function SidebarChildThreadRoleIcon(props: {
  role: ChildThreadRole;
  muted?: boolean;
  className?: string;
}) {
  const Icon = CHILD_THREAD_ROLE_ICON[props.role];
  return (
    <span
      aria-hidden
      data-testid="sidebar-child-thread-role"
      data-role={props.role}
      className={cn(
        "inline-flex shrink-0 items-center",
        props.muted ? "text-muted-foreground/60" : CHILD_THREAD_ROLE_CLASS_NAME[props.role],
      )}
    >
      <Icon className={cn("size-3.5", props.className)} />
    </span>
  );
}

function SidebarChildThreadChip(props: { chip: ChildThreadChip }) {
  const { chip } = props;
  const status = CHILD_THREAD_KIND_STATUS[chip.kind];
  return (
    <span
      aria-hidden
      data-testid="sidebar-child-thread-chip"
      data-kind={chip.kind}
      className={cn(
        "inline-flex h-4.5 shrink-0 items-center gap-0.5 rounded-full bg-foreground/6 ps-1 pe-1.5 text-2xs leading-none font-medium tabular-nums",
        status.className,
      )}
    >
      <SidebarStatusIcon icon={status.icon} className="size-3" />
      {chip.count}
    </span>
  );
}

const childRowClassName =
  "flex h-8 w-full min-w-0 items-center gap-1.5 rounded-md ps-6 pe-2.5 text-left text-xs text-muted-foreground hover:bg-sidebar-row-hover hover:text-sidebar-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring";

// A family's children under their head: a hairline near the left edge curves into the last
// row. The first row is the disclosure (chevron and a chip per kind of child); then every child
// that is not settled, and one "+N settled" row that opens the settled ones in place. Collapsed,
// only children that need the user or failed and the open thread show besides the chips.
export function SidebarChildThreads(props: {
  family: RenderedChildThreadFamily;
  onToggle: (family: RenderedChildThreadFamily) => void;
  onToggleSettled: (family: RenderedChildThreadFamily) => void;
  settledRows: ReactNode;
  children: ReactNode;
}) {
  const { family, onToggle, onToggleSettled } = props;
  const settledRoles = childThreadRolesOf(family.settled.map((thread) => thread.title));
  return (
    <li className="list-none">
      <ul
        role="presentation"
        data-testid="sidebar-child-threads"
        className={cn(
          "relative flex flex-col gap-px",
          "after:pointer-events-none after:absolute after:start-2 after:top-1 after:w-2.5 after:rounded-es-md after:border-s after:border-b after:border-foreground/20 after:content-['']",
          // The curve lands on the middle of the last row: a slim child row,
          // or the disclosure or "+N settled" row.
          !family.settledRow && family.children.length > 0
            ? "after:bottom-[18px]"
            : "after:bottom-4",
        )}
      >
        {family.disclosure ? (
          <li className="list-none">
            {/* The chips say how many of each; the tooltip spells it out. */}
            <Tooltip>
              <TooltipTrigger
                render={
                  <button
                    type="button"
                    aria-expanded={!family.collapsed}
                    aria-label={formatChildThreadsDisclosureLabel({
                      kind: "family",
                      expanded: !family.collapsed,
                      count: family.all.length,
                      headTitle: family.head.title,
                      summary: family.summary,
                    })}
                    data-testid="sidebar-child-threads-disclosure"
                    className={cn(childRowClassName, "gap-1")}
                    onClick={() => onToggle(family)}
                  />
                }
              >
                <ChevronRightIcon
                  aria-hidden
                  className={cn(
                    "size-3.5 shrink-0 transition-transform duration-150 motion-reduce:transition-none",
                    !family.collapsed && "rotate-90",
                  )}
                />
                <span className="flex min-w-0 items-center gap-1 overflow-hidden">
                  {family.chips.map((chip) => (
                    <SidebarChildThreadChip key={chip.kind} chip={chip} />
                  ))}
                </span>
              </TooltipTrigger>
              <TooltipPopup side="top">{family.summary}</TooltipPopup>
            </Tooltip>
          </li>
        ) : null}
        {props.children}
        {family.settledShown ? (
          <li className="list-none">
            {/* Settled children recede until hovered or focused. */}
            <ul
              role="presentation"
              className="flex flex-col gap-px *:opacity-60 *:transition-opacity *:focus-within:opacity-100 *:hover:opacity-100 motion-reduce:*:transition-none"
            >
              {props.settledRows}
            </ul>
          </li>
        ) : null}
        {family.settledRow ? (
          <li className="list-none">
            <button
              type="button"
              aria-expanded={family.settledShown}
              aria-label={formatChildThreadsDisclosureLabel({
                kind: "settled",
                expanded: family.settledShown,
                count: family.settled.length,
                headTitle: family.head.title,
              })}
              data-testid="sidebar-child-threads-settled"
              className={cn(childRowClassName, "text-muted-foreground/70")}
              onClick={() => onToggleSettled(family)}
            >
              {family.disclosure ? (
                <span aria-hidden className="size-4 shrink-0" />
              ) : (
                <CircleCheckIcon aria-hidden className="size-4 shrink-0 text-muted-foreground/60" />
              )}
              <span className="truncate">
                {family.settledShown ? "Show less" : `+${family.settled.length} settled`}
              </span>
              {family.settledShown ? null : (
                <span className="flex shrink-0 items-center gap-0.5">
                  {settledRoles.map((role) => (
                    <SidebarChildThreadRoleIcon key={role} role={role} muted className="size-3" />
                  ))}
                </span>
              )}
            </button>
          </li>
        ) : null}
      </ul>
    </li>
  );
}
