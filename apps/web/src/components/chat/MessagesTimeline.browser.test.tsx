import { flushSync } from "react-dom";
import { AudioPreview } from "../files/AudioPreview";
import { cdp, page } from "vite-plus/test/browser";
import {
  ComposerContextId,
  EnvironmentId,
  MessageId,
  NodeId,
  ProviderDriverKind,
  ProviderInstanceId,
  RunAttemptId,
  RunId,
  RuntimeRequestId,
  TurnItemId,
  ScheduledTaskId,
  ThreadId,
  type OrchestrationV2Subagent,
} from "@t3tools/contracts";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  createRef,
  Profiler,
  StrictMode,
  useState,
  type ComponentProps,
  type ReactElement,
} from "react";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";
import { describe, expect, it, onTestFinished, vi } from "vite-plus/test";

import "~/index.css";

import { environmentThreadDetails } from "../../state/threads";
import { act, fakeTimers, render, stubGlobal } from "../../../test/render";
import { ChangedFilesCard } from "./ChangedFilesTree";
import { MessagesTimeline } from "./MessagesTimeline";
import { makeStreamingTimelineFixture } from "../../test-fixtures";
import {
  type PendingApproval,
  deriveTimelineEntriesFromVisibleTurnItems,
} from "../../session-logic";
import { remarkThoughtPreview } from "./TimelineWorkEntryRow.logic";
import { parseMarkdownWithMath } from "@t3tools/shared/markdownMath";
import { collectThreadFindRanges } from "./threadFindHighlights";
import { toastManager } from "../ui/toast";
import type { CitedHistory } from "./citationProcedure";
import type { TimelineNavigation } from "./timelineViewport";
import { readTimelinePosition, rememberTimelinePosition } from "./timelineScrollAnchoring";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  decodeComposerContextFragment,
} from "@t3tools/shared/composerContextClipboard";
import { collectComposerContextReferences } from "@t3tools/shared/composerContextReferences";

const environmentQuery = vi.hoisted(() => ({
  error: "Pull request not found",
  data: null as unknown,
}));
vi.mock(import("~/state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: (() => ({
    data: environmentQuery.data,
    dataUpdatedAt: 0,
    error: environmentQuery.error,
    failure: null,
    isPending: false,
    isSuccess: false,
    refresh: () => {},
  })) as never,
}));

const audioAsset = vi.hoisted(() => ({ url: "" }));
vi.mock(import("~/assets/assetUrls"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    useAssetUrlState: ((...args: Parameters<typeof actual.useAssetUrlState>) =>
      audioAsset.url
        ? { _tag: "Success", url: audioAsset.url }
        : actual.useAssetUrlState(...args)) as typeof actual.useAssetUrlState,
  };
});

const reasoningSetting = vi.hoisted(() => ({
  on: false,
  reads: 0,
  timelineRenders: 0,
  rowRenders: 0,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => {
  const actual = await original();
  type Settings = ReturnType<typeof actual.getClientSettings>;
  function useClientSettings<T = Settings>(select?: (settings: Settings) => T): T {
    const settings = {
      ...actual.getClientSettings(),
      get reasoningExpandedByDefault() {
        reasoningSetting.reads += 1;
        return reasoningSetting.on;
      },
    };
    return select ? select(settings) : (settings as T);
  }
  return { ...actual, useClientSettings };
});
// Every work row calls this hook on each render; the compiler cannot memoize a hook call.
vi.mock(import("../../state/entities"), async (original) => {
  const actual = await original();
  const useThreadShell: typeof actual.useThreadShell = (ref) => {
    reasoningSetting.rowRenders += 1;
    return actual.useThreadShell(ref);
  };
  return { ...actual, useThreadShell };
});
// The timeline calls this once per render and no row does.
vi.mock(import("./useTimelineRows"), async (original) => {
  const actual = await original();
  const useStableHandoffRuns: typeof actual.useStableHandoffRuns = (runs) => {
    reasoningSetting.timelineRenders += 1;
    return actual.useStableHandoffRuns(runs);
  };
  return { ...actual, useStableHandoffRuns };
});

const ENVIRONMENT_ID = EnvironmentId.make("environment-local");
const CREATED_AT = "2026-03-17T19:12:28.000Z";

type TimelineProps = ComponentProps<typeof MessagesTimeline>;
type Entry = TimelineProps["timelineEntries"][number];

// The timeline remembers scroll position and open disclosures per thread key,
// so every render gets a fresh thread.
function baseProps(): Omit<TimelineProps, "timelineEntries"> {
  return {
    isWorking: false,
    listRef: createRef<LegendListRef | null>(),
    latestRun: null,
    turnDiffSummaries: [],
    runs: [],
    routeThreadKey: `environment-local:thread-${Math.random().toString(36).slice(2)}`,
    onOpenTurnDiff: () => {},
    onOpenThread: () => {},
    onForkFromRun: async () => {},
    supportsConversationRollback: false,
    onRevertToTurnCount: () => {},
    isRevertingCheckpoint: false,
    onImageExpand: () => {},
    activeThreadEnvironmentId: ENVIRONMENT_ID,
    markdownCwd: undefined,
    resolvedTheme: "light",
    timestampFormat: "locale",
    workspaceRoot: undefined,
    anchorMessageId: null,
    onAnchorReady: () => {},
    onAnchorSizeChanged: () => {},
    contentInsetEndAdjustment: 0,
    emptyPlaceholderInset: 0,
    liveFollowEnabled: true,
    onIsAtEndChange: () => {},
  };
}

function message(
  text: string,
  overrides: Partial<Extract<Entry, { kind: "message" }>["message"]> = {},
  id = "message-1",
): Entry {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: CREATED_AT,
    message: {
      id: MessageId.make(id),
      role: "user",
      text,
      runId: null,
      createdAt: CREATED_AT,
      updatedAt: CREATED_AT,
      streaming: false,
      ...overrides,
    },
  };
}

function work(id: string, entry: Record<string, unknown>): Entry {
  return {
    id,
    kind: "work",
    createdAt: CREATED_AT,
    entry: { id, createdAt: CREATED_AT, ...entry },
  } as Entry;
}

function v2Item(type: string, fields: Record<string, unknown>) {
  const id = (fields.id as string | undefined) ?? type;
  return {
    position: 0,
    visibility: "local",
    sourceThreadId: "thread-1",
    sourceItemId: id,
    item: {
      id,
      threadId: "thread-1",
      runId: "run-1",
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      status: "completed",
      title: null,
      startedAt: null,
      completedAt: null,
      updatedAt: {},
      type,
      ...fields,
    },
  } as never;
}

async function renderElement(element: ReactElement, options: { router?: false } = {}) {
  const container = document.createElement("div");
  container.style.cssText = "height: 1200px; width: 900px; display: flex; flex-direction: column;";
  const screen = await render(element, { container, ...options });
  const buttons = (name: string | RegExp) =>
    [...container.querySelectorAll<HTMLElement>("button, [role=button]")].filter((button) => {
      const label = button.getAttribute("aria-label") ?? button.textContent ?? "";
      return typeof name === "string" ? label === name : name.test(label);
    });
  return Object.assign(screen, {
    text: () => container.textContent ?? "",
    buttons,
    button: (name: string | RegExp) => {
      const [match] = buttons(name);
      if (!match) throw new Error(`Missing button: ${String(name)}`);
      return match;
    },
  });
}

function renderTimeline(entries: ReadonlyArray<Entry>, props: Partial<TimelineProps> = {}) {
  return renderElement(
    <MessagesTimeline {...baseProps()} timelineEntries={entries as Entry[]} {...props} />,
  );
}

async function click(element: HTMLElement) {
  await act(async () => element.click());
}

function setup({ scheduledTasks = [] as ReadonlyArray<{ id: string; title: string }> } = {}) {
  environmentQuery.data = { tasks: scheduledTasks };
}

const TASK_ID = ScheduledTaskId.make("task-1");
const AUTOMATION_PROMPT = "Triage the inbox\n\nLabel every new issue and close duplicates.";

describe("MessagesTimeline work rows", () => {
  it("keeps the worked-for heading in place when expanded at the bottom", async () => {
    const props = baseProps();
    const runId = RunId.make("completed-run");
    const container = document.createElement("div");
    container.style.cssText = "height: 600px; width: 900px; display: flex; flex-direction: column;";
    await using screen = await render(
      <MessagesTimeline
        {...props}
        timelineEntries={[
          ...Array.from({ length: 12 }, (_, index) =>
            message(`Earlier context ${index}`, {}, `context-${index}`),
          ),
          message("Progress details\n\n".repeat(50), { role: "assistant", runId }, "progress"),
          message("Done", { role: "assistant", runId }, "final"),
        ]}
      />,
      { container },
    );
    const heading = screen.getByRole("button", { name: /^Worked for/ });
    // LegendList keeps rows click-through until its initial scroll settles on animation
    // frames, which the fake clock below would freeze.
    await expect.element(heading).toHaveStyle({ pointerEvents: "auto" });
    const viewport = props.listRef.current!.getScrollableNode()!;
    await vi.waitFor(() =>
      expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBeLessThan(2),
    );
    expect(viewport.scrollTop).toBeGreaterThan(0);
    const top = heading.element().getBoundingClientRect().top;
    const height = viewport.scrollHeight;
    using _timers = fakeTimers();
    await heading.click();
    await act(() => vi.advanceTimersByTime(1000));
    await vi.waitFor(() => {
      expect(viewport.scrollHeight).toBeGreaterThan(height + 500);
      expect(heading.element().getBoundingClientRect().top).toBeCloseTo(top, 0);
      expect(viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop).toBeGreaterThan(
        500,
      );
    });
  });

  it.each(["delegated", "legacy", "missing"] as const)(
    "uses the reported task for %s completion notifications",
    async (source) => {
      setup();
      const now = DateTime.makeUnsafe(CREATED_AT);
      const childThreadId = ThreadId.make("shared-child");
      const task = (
        id: string,
        status: OrchestrationV2Subagent["status"],
        result: string,
      ): OrchestrationV2Subagent => ({
        id: NodeId.make(id),
        threadId: ThreadId.make("thread-1"),
        runId: null,
        parentNodeId: NodeId.make("parent-root"),
        origin: "app_owned",
        createdBy: "agent",
        driver: ProviderDriverKind.make("claudeAgent"),
        providerInstanceId: ProviderInstanceId.make("claudeAgent"),
        providerThreadId: null,
        childThreadId,
        nativeTaskRef: null,
        prompt: "Simplify delivery",
        title: "Simplify delivery",
        model: null,
        status,
        result,
        startedAt: now,
        completedAt: now,
        updatedAt: now,
      });
      const tasks = [
        task("original", "interrupted", "Old interrupted progress"),
        task("continued", "completed", "Final implementation report"),
        task("follow-up", "completed", "Follow-up explanation"),
      ];
      using _threadAtom = vi.spyOn(environmentThreadDetails, "threadAtom").mockReturnValue(
        Atom.make({
          projection: { subagents: tasks, turnItems: [], visibleTurnItems: [] },
        }) as never,
      );
      const onOpenThread = vi.fn();
      await using screen = await renderTimeline(
        (source === "delegated" ? ["continued", "follow-up"] : [source]).map((id) =>
          work(`notification-${id}`, {
            label: "Notification fallback",
            tone: "info",
            itemType: "notification",
            projectedItem: v2Item("notification", {
              id: `notification-${id}`,
              source:
                source === "legacy"
                  ? { kind: "subagent", childThreadId }
                  : { kind: "delegated_task", childThreadId, taskIds: [NodeId.make(id)] },
              outcome: "completed",
              summary: "Notification fallback",
            }),
          }),
        ),
        { onOpenThread },
      );
      if (source === "delegated") {
        expect(screen.text()).toContain("Final implementation report");
        expect(screen.text()).toContain("Follow-up explanation");
        expect(screen.text()).not.toContain("Old interrupted progress");
        await click(screen.buttons("Open Simplify delivery")[0]!);
        expect(onOpenThread).toHaveBeenCalledWith(childThreadId);
      } else if (source === "legacy") {
        expect(screen.text()).toContain("Old interrupted progress");
      } else {
        expect(screen.text()).toContain("Notification fallback");
        expect(screen.text()).not.toContain("Old interrupted progress");
      }
    },
  );
});

describe("MessagesTimeline messages", () => {
  it("settles when equally long messages have very different rendered heights", async () => {
    const props = baseProps();
    const tall = message("a\n\n".repeat(6000), { role: "assistant" }, "tall");
    const earlier = Array.from({ length: 80 }, (_, index) =>
      message(
        `<details><summary>Reply ${index}</summary>${"compact ".repeat(2250)}</details>`,
        { role: "assistant" },
        `earlier-${index}`,
      ),
    );
    let nestedCommits = 0;
    let maxNestedCommits = 0;
    const onRender = (_id: string, phase: string) => {
      nestedCommits = phase === "nested-update" ? nestedCommits + 1 : 0;
      maxNestedCommits = Math.max(maxNestedCommits, nestedCommits);
    };
    const timeline = (entries: Entry[]) => (
      <Profiler id="timeline" onRender={onRender}>
        <MessagesTimeline {...props} timelineEntries={entries} />
      </Profiler>
    );
    await using screen = await renderElement(timeline([tall]));
    await vi.waitFor(() =>
      expect(props.listRef.current?.getState().sizeAtIndex(0)).toBeGreaterThan(100_000),
    );
    const viewport = props.listRef.current!.getScrollableNode()!;
    await act(() => {
      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event("scroll"));
    });
    await screen.rerender(timeline([...earlier, tall]));
    await act(() => {
      void props.listRef.current!.scrollToIndex({ index: 0, animated: false });
    });
    await vi.waitFor(async () => {
      await act(() => {
        viewport.scrollTop = 0;
        viewport.dispatchEvent(new Event("scroll"));
      });
      expect(screen.text().includes("Reply 0")).toBe(true);
      expect(props.listRef.current!.getState().sizeAtIndex(0)).toBeGreaterThan(0);
    });
    expect(maxNestedCommits).toBeLessThan(20);
  });

  it("keeps the first and last message headings reachable from either end", async () => {
    setup();
    const props = baseProps();
    // Folded messages at both ends: their headings must not live inside the fold.
    const entries = Array.from({ length: 120 }, (_, index) =>
      index === 0
        ? message("First turn", { scheduledTaskId: TASK_ID }, "turn-0")
        : index === 119
          ? message(
              "Last turn",
              { createdBy: "agent", senderThreadId: ThreadId.make("thread-sender") },
              "turn-119",
            )
          : message(
              `Turn ${index}:\n\n${"x ".repeat(200)}`,
              { role: index % 2 === 0 ? "user" : "assistant" },
              `turn-${index}`,
            ),
    );
    await using screen = await renderElement(
      <MessagesTimeline {...props} timelineEntries={entries} />,
    );
    const headings = () => [...screen.container.querySelectorAll("h3")];
    const headingFor = (text: string) =>
      headings().find((heading) => heading.parentElement?.textContent?.includes(text));
    const viewport = props.listRef.current!.getScrollableNode()!;
    // A screen reader scrolls the heading it moves to into view.
    const expectHeadingInView = async (text: string, neighbour: string) => {
      await act(() => headingFor(text)!.scrollIntoView({ block: "start" }));
      await vi.waitFor(() => expect(screen.text()).toContain(neighbour));
      const row = headingFor(text)!.parentElement!.getBoundingClientRect();
      const view = viewport.getBoundingClientRect();
      expect(row.top).toBeLessThan(view.bottom);
      expect(row.bottom).toBeGreaterThan(view.top);
    };

    await vi.waitFor(() => expect(screen.text()).toContain("Turn 118:"));
    expect(screen.text()).not.toContain("Turn 60:");
    // Wrapping follows DOM order, so the ends must also sit first and last.
    await vi.waitFor(() => {
      expect(headings()[0]).toBe(headingFor("First turn"));
      expect(headings().at(-1)).toBe(headingFor("Last turn"));
    });

    await expectHeadingInView("First turn", "Turn 1:");
    expect(headingFor("Last turn")).toBeDefined();
    await expectHeadingInView("Last turn", "Turn 118:");
  });

  it("keeps rows in item order after a reload or thread switch, before any timer runs", async () => {
    setup();
    // NVDA's browse mode keeps the first DOM order it reads, so a timer that sorts rows later is too late.
    using _timers = fakeTimers();
    const thread = (name: string) =>
      Array.from({ length: 120 }, (_, index) =>
        message(
          `${name} turn ${index}:\n\n${"x ".repeat(200)}`,
          { role: index % 2 === 0 ? "user" : "assistant" },
          `${name}-${index}`,
        ),
      );
    const props = baseProps();
    await using screen = await renderElement(
      <MessagesTimeline {...props} timelineEntries={thread("A")} />,
    );
    const turnsInDomOrder = () =>
      [...screen.container.querySelectorAll("h3")].map((heading) =>
        Number(/turn (\d+):/.exec(heading.parentElement?.textContent ?? "")?.[1]),
      );
    const expectItemOrder = () => {
      const turns = turnsInDomOrder();
      expect(turns).toEqual(turns.toSorted((a, b) => a - b));
    };

    expect(screen.text()).toContain("A turn 118:");
    expect(turnsInDomOrder()).toContain(0);
    expectItemOrder();

    await screen.rerender(
      <MessagesTimeline
        {...props}
        routeThreadKey={`${props.routeThreadKey}-other`}
        timelineEntries={thread("B")}
      />,
    );
    expect(screen.text()).toContain("B turn 118:");
    expect(screen.text()).not.toContain("A turn");
    expectItemOrder();
  });

  it("puts rows back in item order soon after a continuous scroll stops", async () => {
    setup();
    const props = baseProps();
    await using screen = await renderElement(
      <MessagesTimeline
        {...props}
        timelineEntries={Array.from({ length: 120 }, (_, index) =>
          message(
            `Turn ${index}:\n\n${"x ".repeat(200)}`,
            { role: index % 2 === 0 ? "user" : "assistant" },
            `turn-${index}`,
          ),
        )}
      />,
    );
    await vi.waitFor(() => expect(screen.text()).toContain("Turn 118:"));
    using _timers = fakeTimers();
    const turnsInDomOrder = () =>
      [...screen.container.querySelectorAll("h3")].map((heading) =>
        Number(/Turn (\d+):/.exec(heading.parentElement?.textContent ?? "")?.[1]),
      );
    const viewport = props.listRef.current!.getScrollableNode()!;

    const scroll = async (by: number) => {
      for (let step = 0; step < 40; step++) {
        await act(() => {
          viewport.scrollTop += by;
          viewport.dispatchEvent(new Event("scroll"));
          vi.advanceTimersByTime(16);
        });
      }
      // Wrapping right after a scroll must still reach the first and last message.
      expect(turnsInDomOrder()[0]).toBe(0);
      expect(turnsInDomOrder().at(-1)).toBe(119);
    };

    await act(() => {
      viewport.scrollTop = 0;
      viewport.dispatchEvent(new Event("scroll"));
      vi.advanceTimersByTime(300);
    });
    await scroll(300);
    expect(turnsInDomOrder().filter((turn) => turn > 0 && turn < 100).length).toBeGreaterThan(0);
    await scroll(-300);

    await act(() => vi.advanceTimersByTime(300));
    const turns = turnsInDomOrder();
    expect(turns).toEqual(turns.toSorted((a, b) => a - b));
  });

  it("preserves XML-like tags and comparisons in user messages as text", async () => {
    const source = [
      'Without reading a file, do you have <global-agent-instructions scope="workspace">',
      'Before <nested data-value="a&b">inside</nested> after',
      "</global-agent-instructions> in your context?",
      "Comparison: 2 < 3 and 5 > 4.",
    ];
    await using screen = await renderTimeline([message(source.join("\n"))]);
    for (const line of source) expect(screen.text()).toContain(line);
    expect(screen.container.querySelector("global-agent-instructions, nested")).toBeNull();
  });

  it("renders unsafe user HTML as inert source text", async () => {
    const source =
      '<script>globalThis.__t3Xss = 1</script><img src="x" onerror="globalThis.__t3Xss = 2">';
    await using screen = await renderTimeline([message(source)]);
    expect(screen.text()).toContain(source);
    expect(screen.container.querySelector("script, img")).toBeNull();
    expect((globalThis as { __t3Xss?: number }).__t3Xss).toBeUndefined();
  });

  it("renders sanitized raw HTML in assistant messages", async () => {
    await using screen = await renderTimeline([
      message(
        [
          '<details onclick="globalThis.__t3Xss = 1">',
          "<summary>Safe details</summary>",
          "<script>globalThis.__t3Xss = 2</script>",
          '<img src="x" onerror="globalThis.__t3Xss = 3">',
          '<a href="javascript:globalThis.__t3Xss = 4">Unsafe link</a>',
          "</details>",
        ].join(""),
        { role: "assistant" },
      ),
    ]);
    expect(screen.container.querySelector("[data-markdown-details]")?.textContent).toContain(
      "Safe details",
    );
    expect(screen.text()).not.toContain("<details");
    expect(screen.container.querySelector("script, [onclick], [onerror]")).toBeNull();
    expect(screen.container.innerHTML).not.toContain("javascript:");
    await click(screen.button("Safe details"));
    expect((globalThis as { __t3Xss?: number }).__t3Xss).toBeUndefined();
  });
});

function usageLimitEntries(resetAt: string) {
  const threadId = ThreadId.make("usage-limit-thread");
  const at = DateTime.makeUnsafe(CREATED_AT);
  return deriveTimelineEntriesFromVisibleTurnItems({
    visibleTurnItems: [
      {
        position: 0,
        visibility: "local",
        sourceThreadId: threadId,
        sourceItemId: TurnItemId.make("usage-limit"),
        item: {
          id: TurnItemId.make("usage-limit"),
          threadId,
          runId: RunId.make("usage-limit-run"),
          nodeId: null,
          providerThreadId: null,
          providerTurnId: null,
          nativeItemRef: null,
          parentItemId: null,
          ordinal: 0,
          title: null,
          startedAt: at,
          completedAt: at,
          updatedAt: at,
          type: "error",
          status: "failed",
          failure: {
            class: "usage_limit",
            message: "You've hit your usage limit.",
            code: null,
            retryable: true,
            resetAt,
          },
        },
      },
    ],
    optimisticMessages: [],
  });
}

describe("MessagesTimeline usage limit notice", () => {
  it("labels the retry time with the viewer's timezone", async () => {
    await using screen = await renderTimeline(usageLimitEntries("2026-03-17T19:30:00.000Z"));
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(screen.text()).toMatch(/Usage limit reached\. Retry after .+\./);
    expect(screen.text()).toContain(`(${timeZone})`);
  });

  it("keeps the retry time in the named zone after the viewer's timezone changes", async () => {
    const resetAt = "2026-07-01T19:30:00.000Z";
    const session = cdp();
    await session.send("Emulation.setTimezoneOverride", { timezoneId: "Europe/Madrid" });
    try {
      {
        await using _madrid = await renderTimeline(usageLimitEntries(resetAt));
      }
      await session.send("Emulation.setTimezoneOverride", { timezoneId: "America/New_York" });
      await using screen = await renderTimeline(usageLimitEntries(resetAt));
      const newYorkTime = new Date(resetAt).toLocaleTimeString(undefined, {
        hour: "numeric",
        minute: "2-digit",
        timeZone: "America/New_York",
      });
      expect(screen.text()).toContain(`${newYorkTime} (America/New_York)`);
    } finally {
      await session.send("Emulation.setTimezoneOverride", { timezoneId: "" });
    }
  });
});

const CITATION_REQUEST = {
  key: "activation-1",
  citation: {
    version: 1,
    environmentId: ENVIRONMENT_ID,
    threadId: ThreadId.make("thread-cited"),
    messageId: MessageId.make("cited"),
    text: "the cited answer",
    start: 0,
    end: 16,
    prefix: "",
    suffix: "",
  },
} satisfies NonNullable<TimelineProps["citationRequest"]>;

describe("MessagesTimeline citations", () => {
  it("lands a citation present at mount under StrictMode", async () => {
    await using _screen = await renderElement(
      <StrictMode>
        <MessagesTimeline
          {...baseProps()}
          timelineEntries={[
            message("A question", {}, "question"),
            message("the cited answer", { role: "assistant" }, "cited"),
          ]}
          citationRequest={CITATION_REQUEST}
          citationHistory={{ _tag: "found" }}
        />
      </StrictMode>,
      // The test router mounts route content without StrictMode's effect replay.
      { router: false },
    );
    // StrictMode replays effect cleanups on mount; the activation must survive them.
    await vi.waitFor(() =>
      expect(document.querySelector("[data-citation-highlighted]")?.textContent).toContain(
        "the cited answer",
      ),
    );
  });

  it("opens the superseded attempt that folds the cited response", async () => {
    const runId = RunId.make("run-steered");
    const attempt = (id: string, ordinal: number, status: "superseded" | "running") => ({
      id: RunAttemptId.make(id),
      runId,
      attemptOrdinal: ordinal,
      rootNodeId: `node-${id}` as never,
      status,
      completedAt: null,
    });
    const superseded = attempt("attempt-1", 1, "superseded");
    const active = attempt("attempt-2", 2, "running");
    const inAttempt = (entry: Entry, entryAttempt: typeof superseded): Entry => ({
      ...entry,
      attempt: entryAttempt,
    });
    await using _screen = await renderTimeline(
      [
        inAttempt(message("Build it", { runId }, "question"), superseded),
        inAttempt(message("the cited answer", { role: "assistant", runId }, "cited"), superseded),
        inAttempt(message("Change direction", { runId }, "steer"), active),
        inAttempt(message("Current response", { role: "assistant", runId }, "current"), active),
      ],
      {
        latestRun: { runId, status: "running", startedAt: CREATED_AT, completedAt: null },
        citationRequest: CITATION_REQUEST,
        citationHistory: { _tag: "found" },
      },
    );
    await vi.waitFor(() =>
      expect(document.querySelector("[data-citation-highlighted]")?.textContent).toContain(
        "the cited answer",
      ),
    );
  });

  it("waits for cited history to load before giving up on a response outside the window", async () => {
    using toast = vi.spyOn(toastManager, "add");
    const props = baseProps();
    const citationRequest = CITATION_REQUEST;
    const recent = message("A recent question", {}, "recent");
    const timeline = (entries: Entry[], citationHistory: CitedHistory) => (
      <MessagesTimeline
        {...props}
        timelineEntries={entries}
        citationRequest={citationRequest}
        citationHistory={citationHistory}
      />
    );
    await using screen = await renderElement(timeline([recent], { _tag: "loading" }));
    await expect.element(screen.getByText("A recent question")).toBeVisible();

    await screen.rerender(
      timeline([message("the cited answer", { role: "assistant" }, "cited"), recent], {
        _tag: "found",
      }),
    );
    await expect.element(screen.getByText("the cited answer")).toBeVisible();
    expect(toast).not.toHaveBeenCalled();
  });
});

describe("MessagesTimeline automation prompts", () => {
  it("folds an automation prompt into a bubble titled by its task", async () => {
    setup({ scheduledTasks: [{ id: TASK_ID, title: "Nightly triage" }] });
    await using screen = await renderTimeline([
      message(AUTOMATION_PROMPT, { scheduledTaskId: TASK_ID }),
    ]);
    const row = screen.button(/^Automation/);
    expect(row.textContent).toContain("Nightly triage");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(screen.text()).not.toContain("close duplicates");

    await click(row);
    expect(screen.text()).toContain("Label every new issue and close duplicates.");
    const link = [...screen.container.querySelectorAll("a")].find(
      (anchor) => anchor.textContent === "Open automation",
    );
    expect(link?.getAttribute("href")).toContain(`taskId=${TASK_ID}`);
    expect(screen.buttons(/copy/i)).not.toHaveLength(0);
  });

  it("falls back to the prompt's first line without a task title", async () => {
    setup();
    await using screen = await renderTimeline([
      message(AUTOMATION_PROMPT, { scheduledTaskId: TASK_ID }),
    ]);
    expect(screen.button(/^Automation/).textContent).toContain("Triage the inbox");
  });

  it("leaves ordinary user messages as full bubbles", async () => {
    setup();
    await using screen = await renderTimeline([message(AUTOMATION_PROMPT)]);
    expect(screen.buttons(/^Automation/)).toHaveLength(0);
    expect(screen.text()).toContain("Label every new issue and close duplicates.");
  });

  it("reveals a find match beyond the folded automation prompt's initial viewport", async () => {
    setup();
    const prompt = `${"Inspect the next item.\n\n".repeat(16)}Close duplicates.`;
    await using screen = await renderTimeline([message(prompt, { scheduledTaskId: TASK_ID })], {
      findExpanded: true,
      findQuery: "duplicates",
      activeFindMatch: { entryId: "entry-message-1", runId: null, occurrence: 0 },
    });
    await vi.waitFor(() =>
      expect(screen.button(/^Automation/).getAttribute("aria-expanded")).toBe("true"),
    );
    const { range } = collectThreadFindRanges(screen.container, "duplicates")[0]!;
    const details = screen.container.querySelector("[data-thread-find-text]")!;
    expect(range.getBoundingClientRect().top - details.getBoundingClientRect().top).toBeGreaterThan(
      384,
    );
    expect(range.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      details.getBoundingClientRect().bottom,
    );
  });

  it("shows edit-from-here once an automation prompt is expanded", async () => {
    setup();
    const runId = RunId.make("run-1");
    await using screen = await renderTimeline(
      [
        message(
          AUTOMATION_PROMPT,
          { scheduledTaskId: TASK_ID, runId, inputIntent: "turn_start" },
          "user-1",
        ),
        message("Done", { role: "assistant", runId }, "assistant-1"),
      ],
      {
        supportsConversationRollback: true,
        threadStartCheckpointReady: true,
        turnDiffSummaries: [
          {
            runId,
            checkpointTurnCount: 1,
            checkpointRef: "checkpoint-1" as never,
            status: "ready",
            files: [],
            assistantMessageId: MessageId.make("assistant-1"),
            completedAt: CREATED_AT,
          },
        ],
      },
    );
    expect(screen.buttons("Edit from here")).toHaveLength(0);
    await click(screen.button(/^Automation/));
    expect(screen.buttons("Edit from here")).toHaveLength(1);
  });
});

const SENDER_THREAD_ID = ThreadId.make("thread-sender");
const AGENT_MESSAGE = "Review finished\n\nThe migration drops the index before backfilling it.";

describe("MessagesTimeline agent messages", () => {
  it("folds a message from another agent into a one-line preview", async () => {
    setup();
    const onOpenThread = vi.fn();
    await using screen = await renderTimeline(
      [message(AGENT_MESSAGE, { createdBy: "agent", senderThreadId: SENDER_THREAD_ID })],
      { onOpenThread },
    );
    const row = screen.button(/^Agent/);
    expect(row.textContent).toContain("Review finished");
    expect(row.getAttribute("aria-expanded")).toBe("false");
    expect(screen.text()).not.toContain("drops the index");
    expect(screen.buttons("Open thread")).toHaveLength(0);

    await click(row);
    expect(screen.text()).toContain("The migration drops the index before backfilling it.");
    await click(screen.button("Open thread"));
    expect(onOpenThread).toHaveBeenCalledWith(SENDER_THREAD_ID);

    await click(screen.button(/^Agent/));
    expect(screen.text()).not.toContain("drops the index");
  });

  it("leaves messages sent by T3 Code as full bubbles", async () => {
    setup();
    await using screen = await renderTimeline([
      message(AGENT_MESSAGE, { createdBy: "agent", creationSource: "server" }),
    ]);
    expect(screen.buttons(/^Agent/)).toHaveLength(0);
    expect(screen.text()).toContain("drops the index");
  });

  it("reveals a find match inside a folded agent message", async () => {
    setup();
    const text = `${"Checked the next file.\n\n".repeat(16)}The migration drops the index.`;
    await using screen = await renderTimeline(
      [message(text, { createdBy: "agent", senderThreadId: SENDER_THREAD_ID })],
      {
        findExpanded: true,
        findQuery: "drops the index",
        activeFindMatch: { entryId: "entry-message-1", runId: null, occurrence: 0 },
      },
    );
    await vi.waitFor(() =>
      expect(screen.button(/^Agent/).getAttribute("aria-expanded")).toBe("true"),
    );
    const { range } = collectThreadFindRanges(screen.container, "drops the index")[0]!;
    const body = screen.container.querySelector("[data-user-message-body]")!;
    expect(range.getBoundingClientRect().height).toBeGreaterThan(0);
    expect(range.getBoundingClientRect().bottom).toBeLessThanOrEqual(
      body.getBoundingClientRect().bottom,
    );
  });
});

describe("MessagesTimeline attachments", () => {
  it.each(["image", "file"] as const)(
    "copies only matching context records for a wordless %s attachment",
    async (kind) => {
      const attachment = {
        type: kind,
        id: "media",
        name: kind === "image" ? "photo.png" : "clip.mp4",
        mimeType: kind === "image" ? "image/png" : "video/mp4",
        sizeBytes: 100,
        downloadable: false,
      };
      const record = {
        version: 1 as const,
        ...(kind === "image" ? { kind: "image" as const } : { kind: "file" as const }),
        contextId: ComposerContextId.make("media-context"),
        label: attachment.name,
        attachmentId: attachment.id,
        name: attachment.name,
        mimeType: attachment.mimeType,
        sizeBytes: attachment.sizeBytes,
      };
      await using screen = await renderTimeline([message("", { attachments: [attachment] })]);
      expect(screen.buttons("Copy message")).toHaveLength(0);
      await screen.rerender(
        <MessagesTimeline
          {...baseProps()}
          timelineEntries={[
            message("", {
              attachments: [attachment],
              context: { version: 1, records: [{ ...record, attachmentId: "other" }] },
            }),
          ]}
        />,
      );
      expect(screen.buttons("Copy message")).toHaveLength(0);
      await screen.rerender(
        <MessagesTimeline
          {...baseProps()}
          timelineEntries={[
            message("", {
              attachments: [attachment],
              context: {
                version: 1,
                records: [
                  record,
                  {
                    ...record,
                    contextId: ComposerContextId.make("other-context"),
                    attachmentId: "other",
                  },
                ],
              },
            }),
          ]}
        />,
      );
      using write = vi.spyOn(navigator.clipboard, "write").mockResolvedValue();
      await click(screen.button("Copy message"));
      await vi.waitFor(() => expect(write).toHaveBeenCalledOnce());
      const [item] = write.mock.calls[0]![0];
      const text = await (await item!.getType("text/plain")).text();
      const fragment = await (await item!.getType(COMPOSER_CONTEXT_CLIPBOARD_MIME)).text();
      expect(
        collectComposerContextReferences(text).map((reference) => reference.contextId),
      ).toEqual([record.contextId]);
      expect(decodeComposerContextFragment(fragment)?.records).toEqual([record]);
    },
  );

  it.each(["loadedmetadata", "loadeddata", "canplay"])(
    "plays audio with unknown duration after %s and updates the total later",
    async (readyEvent) => {
      const onOpen = vi.fn();
      const preview = (failed = false) => (
        <AudioPreview
          compact
          src="data:audio/webm;base64,"
          name="recording.webm"
          failed={failed}
          onOpen={onOpen}
        />
      );
      await using screen = await renderElement(<div dir="rtl">{preview()}</div>);
      const audio = screen.container.querySelector("audio")!;
      const duration = vi.spyOn(audio, "duration", "get").mockReturnValue(Infinity);
      const play = vi.spyOn(audio, "play").mockResolvedValue();
      expect(screen.button("Loading recording.webm")).toHaveProperty("disabled", true);
      await act(() => audio.dispatchEvent(new Event(readyEvent)));
      expect(screen.button("Play recording.webm")).toHaveProperty("disabled", false);
      expect(screen.text()).toContain("0:00");
      expect(screen.text()).not.toContain("/");
      await click(screen.button("Play recording.webm"));
      expect(play).toHaveBeenCalledOnce();
      await act(() => {
        vi.spyOn(audio, "currentTime", "get").mockReturnValue(3);
        audio.dispatchEvent(new Event("play"));
        audio.dispatchEvent(new Event("timeupdate"));
      });
      expect(screen.button("Pause recording.webm")).toHaveProperty("disabled", false);
      expect(screen.text()).toContain("0:03");
      const progress = screen.container.querySelector<HTMLElement>("span[aria-hidden]")!;
      expect(progress.style.width).toBe("0%");
      await act(() => {
        duration.mockReturnValue(10);
        audio.dispatchEvent(new Event("durationchange"));
      });
      expect(screen.text()).toContain("0:03 / 0:10");
      expect(
        getComputedStyle(screen.container.querySelector("audio")!.previousElementSibling!)
          .direction,
      ).toBe("ltr");
      expect(progress.style.width).toBe("30%");
      await act(() => {
        duration.mockReturnValue(NaN);
        audio.dispatchEvent(new Event("durationchange"));
      });
      expect(screen.text()).not.toContain("/");
      expect(progress.style.width).toBe("0%");
      expect(screen.button("Pause recording.webm")).toHaveProperty("disabled", false);
      await screen.rerender(preview(true));
      expect(screen.text()).toContain("Unavailable");
      await click(screen.button("Audio unavailable. Open recording.webm"));
      expect(onOpen).toHaveBeenCalledOnce();
    },
  );

  it.each(["pause", "error"])("unpins audio after %s", async (event) => {
    const NativeObserver = IntersectionObserver;
    using _observer = stubGlobal(
      "IntersectionObserver",
      class extends NativeObserver {
        constructor(
          private readonly notify: IntersectionObserverCallback,
          options?: IntersectionObserverInit,
        ) {
          super(notify, options);
        }
        override observe(target: Element) {
          this.notify([{ target, isIntersecting: true } as IntersectionObserverEntry], this);
        }
      },
    );
    const src =
      "data:audio/wav;base64,UklGRiUAAABXQVZFZm10IBAAAAABAAEAQB8AAEAfAAABAAgAZGF0YQEAAACA";
    audioAsset.url = src;
    onTestFinished(() => {
      audioAsset.url = "";
    });
    const props = baseProps();
    await using screen = await renderTimeline(
      [
        // The first message row is always mounted, so the recordings go in the second.
        message("Start of the thread.", { role: "user" }, "opening"),
        message(
          "Two recordings.",
          {
            attachments: ["one", "two"].map((name) => ({
              type: "file",
              id: `attachment-${name}`,
              name: `${name}.wav`,
              mimeType: "audio/wav",
              sizeBytes: 45,
              previewUrl: src,
            })),
          },
          "audio",
        ),
        ...Array.from({ length: 40 }, (_, index) =>
          message("Conversation history. ".repeat(40), { role: "user" }, `history-${index}`),
        ),
      ],
      props,
    );
    screen.container.style.height = "600px";
    screen.container.scrollIntoView({ block: "start" });
    await vi.waitFor(
      async () => {
        await act(() => {
          void props.listRef.current?.scrollToIndex({ index: 1, animated: false });
        });
        expect(screen.container.querySelectorAll("audio")).toHaveLength(2);
      },
      { timeout: 5000 },
    );
    const [one, two] = [...screen.container.querySelectorAll("audio")];
    await act(async () => {
      vi.spyOn(one!, "paused", "get").mockReturnValue(false);
      vi.spyOn(two!, "paused", "get").mockReturnValue(false);
      one!.dispatchEvent(new Event("play"));
      two!.dispatchEvent(new Event("play"));
    });
    await vi.waitFor(async () => {
      await act(() => {
        void props.listRef.current!.scrollToEnd({ animated: false });
      });
      const scroll = props.listRef.current!.getScrollableNode()!;
      expect(scroll.scrollTop).toBeGreaterThan(5000);
    });
    expect(one!.isConnected).toBe(true);
    expect(two!.isConnected).toBe(true);
    await act(async () => {
      vi.spyOn(one!, "paused", "get").mockReturnValue(true);
      one!.dispatchEvent(new Event("pause"));
    });
    expect(two!.isConnected).toBe(true);
    await act(async () => {
      if (event === "pause") vi.spyOn(two!, "paused", "get").mockReturnValue(true);
      two!.dispatchEvent(new Event(event));
    });
    await act(() => {
      void props.listRef.current!.scrollToIndex({ index: 20, animated: false });
    });
    await vi.waitFor(() => expect(one!.isConnected).toBe(false));
  });
});

describe("MessagesTimeline thread find", () => {
  // Opening find is navigation; on a list already showing the thread the open
  // action navigates, so the list itself releases follow only when it starts
  // showing a thread whose find is already open.
  function renderObserved() {
    const navigations: TimelineNavigation[] = [];
    const base = baseProps();
    const element = (next: Partial<TimelineProps>) => (
      <MessagesTimeline
        {...base}
        timelineEntries={[message("Where is the sidebar fix?")]}
        onViewportAttach={(viewport) =>
          viewport.subscribe((navigation) => navigations.push(navigation))
        }
        {...next}
      />
    );
    return { navigations, element };
  }
  const released = { source: "command", releasesFollow: true };

  it("releases follow once when it starts showing a thread whose find is open", async () => {
    setup();
    const { navigations, element } = renderObserved();
    await using screen = await renderElement(element({}));
    expect(navigations).toEqual([]);

    const other = "environment-local:thread-find-open";
    await screen.rerender(element({ routeThreadKey: other, findOpen: true }));
    expect(navigations).toEqual([released]);
    await screen.rerender(element({ routeThreadKey: other, findOpen: false }));
    await screen.rerender(element({ routeThreadKey: other, findOpen: true }));
    expect(navigations).toEqual([released]);
  });

  it("releases follow once when it mounts on a thread whose find is open", async () => {
    setup();
    const { navigations, element } = renderObserved();
    await using screen = await renderElement(element({ findOpen: true }));
    await screen.rerender(element({ findOpen: true }));
    expect(navigations).toEqual([released]);
  });

  it("still restores the position of a thread it switches to whose find is open", async () => {
    setup();
    const base = baseProps();
    const other = "environment-local:thread-find-open-positioned";
    const replies = Array.from({ length: 40 }, (_, index) =>
      message(`Reply ${index}\n\n${"line\n\n".repeat(8)}`, { role: "assistant" }, `r-${index}`),
    );
    rememberTimelinePosition(
      other,
      { rowId: "entry-r-20", offsetWithinRow: 0, scrollOffset: 0, atEnd: false },
      false,
    );
    await using screen = await renderElement(
      <MessagesTimeline {...base} timelineEntries={[message("Short thread")]} />,
    );
    await screen.rerender(
      <MessagesTimeline
        {...base}
        routeThreadKey={other}
        timelineEntries={replies}
        liveFollowEnabled={false}
        findOpen
      />,
    );
    const viewport = base.listRef.current!.getScrollableNode()!;
    await vi.waitFor(() => {
      const row = screen.container.querySelector('[data-timeline-row-id="entry-r-20"]');
      expect(row).not.toBeNull();
      expect(
        Math.abs(row!.getBoundingClientRect().top - viewport.getBoundingClientRect().top),
      ).toBeLessThanOrEqual(2);
    });
  });
  it("reveals find's match, not the remembered row, on a thread it switches to", async () => {
    setup();
    const base = baseProps();
    const other = "environment-local:thread-find-open-match";
    const replies = Array.from({ length: 40 }, (_, index) =>
      message(
        `${index === 5 ? "Needle here" : `Reply ${index}`}\n\n${"line\n\n".repeat(8)}`,
        { role: "assistant" },
        `r-${index}`,
      ),
    );
    rememberTimelinePosition(
      other,
      { rowId: "entry-r-20", offsetWithinRow: 0, scrollOffset: 0, atEnd: false },
      false,
    );
    await using screen = await renderElement(
      <MessagesTimeline {...base} timelineEntries={[message("Short thread")]} />,
    );
    await screen.rerender(
      <MessagesTimeline
        {...base}
        routeThreadKey={other}
        timelineEntries={replies}
        liveFollowEnabled={false}
        findOpen
        findExpanded
        findQuery="Needle"
        activeFindMatch={{ entryId: "entry-r-5", runId: null, occurrence: 0 }}
      />,
    );
    const viewport = base.listRef.current!.getScrollableNode()!;
    await vi.waitFor(() => {
      const row = screen.container.querySelector('[data-timeline-row-id="entry-r-5"]');
      expect(row).not.toBeNull();
      const bounds = viewport.getBoundingClientRect();
      const top = row!.getBoundingClientRect().top;
      expect(top).toBeGreaterThanOrEqual(bounds.top);
      expect(top).toBeLessThan(bounds.bottom);
    });
  });
});

describe("compact reasoning math", () => {
  it("keeps formulas while flattening compact reasoning previews", () => {
    const tree = parseMarkdownWithMath("## Reasoning\n\nUse **norm** $|x|$ and \\[x^2\\]");
    remarkThoughtPreview("Reasoning")(tree);
    expect(tree.children.map((node) => node.type)).toEqual([
      "text",
      "inlineMath",
      "text",
      "inlineMath",
    ]);
    expect(tree.children.map((node) => ("value" in node ? node.value : null))).toEqual([
      "Reasoning Use norm ",
      "|x|",
      " and ",
      "x^2",
    ]);
  });
});

it("renders automatic compaction as one live divider that finishes with its reason and token delta", async () => {
  setup();
  const fixture = makeStreamingTimelineFixture();
  const prompt = fixture.visibleTurnItems[3]!;
  const assistant = fixture.visibleTurnItems[5]!;
  if (prompt.item.type !== "user_message" || assistant.item.type !== "assistant_message") {
    throw new Error("Expected streaming fixture messages");
  }
  const promptItem = prompt.item;
  const compaction = {
    ...assistant,
    item: {
      ...assistant.item,
      type: "compaction" as const,
      driver: null,
      beforeTokenCount: 899_000,
    },
  };
  const entries = (completed: boolean) =>
    deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [
        {
          ...prompt,
          item: { ...promptItem, text: "/compact", idleCompaction: "beforeCacheExpires" },
        },
        {
          ...compaction,
          item: {
            ...compaction.item,
            status: completed ? "completed" : "running",
            afterTokenCount: completed ? 19_000 : undefined,
          },
        },
      ],
      optimisticMessages: [],
    });
  const props = baseProps();
  const ui = (completed: boolean) => (
    <MessagesTimeline
      {...props}
      timelineEntries={entries(completed)}
      isWorking={!completed}
      isCompacting={!completed}
      activeTurnStartedAt={fixture.time(5)}
      latestRun={{
        runId: fixture.runId,
        status: completed ? "completed" : "running",
        startedAt: fixture.time(5),
        completedAt: completed ? fixture.time(9) : null,
      }}
    />
  );
  const container = document.createElement("div");
  container.style.cssText = "height: 1200px; width: 900px; display: flex; flex-direction: column;";
  await using screen = await render(ui(false), { container });
  await expect
    .element(screen.getByRole("separator", { name: "Compacting before the cache expires…" }))
    .toBeVisible();
  expect(container.textContent).not.toContain("/compact");
  expect(container.textContent).not.toContain("Thinking");
  expect(container.textContent).not.toContain("Working");
  expect(container.querySelectorAll('[role="separator"]')).toHaveLength(1);
  await screen.rerender(ui(true));
  await expect
    .element(
      screen.getByRole("separator", {
        name: "Context automatically compacted before cache expiry 899K → 19K tokens",
      }),
    )
    .toBeVisible();
  expect(container.querySelectorAll('[role="separator"]')).toHaveLength(1);
  expect(container.textContent).not.toContain("Compacting before");
});

function TimelineChangedFilesCard() {
  const [expanded, setExpanded] = useState(true);
  return (
    <ChangedFilesCard
      runId={RunId.make("run-1")}
      files={["src/a.ts", "src/b.ts", "src/c.ts"].map((path) => ({
        path,
        kind: "modified",
        additions: 1,
        deletions: 0,
      }))}
      totals={{ count: 3, additions: 3, deletions: 0 }}
      allDirectoriesExpanded={expanded}
      resolvedTheme="light"
      onToggleAllDirectories={() => setExpanded((value) => !value)}
      onOpenTurnDiff={() => {}}
    />
  );
}

function ChangedFilesTimeline() {
  return (
    <LegendList
      data={["files", "after"]}
      keyExtractor={(item) => item}
      estimatedItemSize={100}
      recycleItems={false}
      className="h-[600px]"
      renderItem={({ item }) =>
        item === "files" ? <TimelineChangedFilesCard /> : <div data-testid="after">After</div>
      }
    />
  );
}

describe("ChangedFilesCard", () => {
  it.each(["folder", "all folders"])(
    "measures %s collapse and expansion in the same commit",
    async (toggle) => {
      await using screen = await render(<ChangedFilesTimeline />);
      const after = () =>
        screen.container.querySelector('[data-testid="after"]')!.getBoundingClientRect().top;
      const cardBottom = () =>
        screen.container.querySelector("[data-changed-files-state]")!.getBoundingClientRect()
          .bottom;
      await vi.waitFor(() => expect(after()).toBe(cardBottom()));
      const topBefore = after();
      const button = () =>
        screen.container.querySelector<HTMLButtonElement>(
          toggle === "folder"
            ? '[data-changed-file-row="src"] button'
            : 'button[aria-label$="all folders"]',
        )!;
      await act(() => {
        flushSync(() => button().click());
        expect(screen.container.textContent).not.toContain("a.ts");
        expect(after()).toBe(topBefore - 3 * 28);
      });
      await act(() => {
        flushSync(() => button().click());
        expect(screen.container.textContent).toContain("a.ts");
        expect(after()).toBe(topBefore);
      });
    },
  );
});

it("keeps concurrent approvals actionable outside collapsed work and restores settled rows", async () => {
  setup();
  const fixture = makeStreamingTimelineFixture();
  const source = fixture.visibleTurnItems[4]!;
  if (source.item.type !== "dynamic_tool") throw new Error("Expected fixture tool");
  const sourceItem = source.item;
  const commandRequest = RuntimeRequestId.make("command-approval");
  const appRequest = RuntimeRequestId.make("app-approval");
  const approvals: PendingApproval[] = [
    {
      requestId: commandRequest,
      requestKind: "command",
      createdAt: fixture.time(6),
      detail: "printf '" + "long-command ".repeat(80) + "'",
      reason: "Needs permission to run the command",
      fullAccessOverride: "ask_rule",
      responseCapability: "live",
    },
    {
      requestId: appRequest,
      requestKind: "permission",
      createdAt: fixture.time(6),
      detail: "Open the current tab",
      appName: "Safari",
      options: [
        { decision: "decline", label: "Deny" },
        { decision: "accept", label: "Allow once" },
        {
          decision: "acceptAlways",
          label: "Always allow Safari",
          warning: "Applies to future requests",
        },
      ],
      responseCapability: "live",
    },
  ];
  const entries = (completed = false) =>
    deriveTimelineEntriesFromVisibleTurnItems({
      visibleTurnItems: [
        { ...source, item: { ...sourceItem, status: completed ? "completed" : sourceItem.status } },
        ...approvals.map((approval, index) => ({
          ...source,
          position: source.position + index + 1,
          sourceItemId: TurnItemId.make(`approval-${index}`),
          item: {
            ...sourceItem,
            id: TurnItemId.make(`approval-${index}`),
            type: "approval_request" as const,
            status: completed ? ("completed" as const) : ("waiting" as const),
            requestId: approval.requestId,
            requestKind: approval.requestKind,
            prompt: approval.detail,
          },
        })),
      ],
      optimisticMessages: [],
    });
  const props = baseProps();
  const onRespondToApproval = vi.fn(async () => {});
  const ui = (overrides: Partial<TimelineProps> = {}) => (
    <MessagesTimeline
      {...props}
      timelineEntries={entries()}
      pendingApprovals={approvals}
      canOperateThread
      onRespondToApproval={onRespondToApproval}
      isWorking
      runningRunId={fixture.runId}
      {...overrides}
    />
  );
  await using screen = await renderElement(ui());
  await expect.element(screen.getByRole("group", { name: "Command approval" })).toBeVisible();
  await expect
    .element(screen.getByRole("group", { name: "App permission approval" }))
    .toBeVisible();
  await expect.element(screen.getByText(approvals[0]!.detail!, { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Needs permission to run the command")).toBeVisible();
  await vi.waitFor(() => {
    expect(
      getComputedStyle(screen.getByLabelText("Command", { exact: true }).element()).userSelect,
    ).toBe("text");
    expect(
      getComputedStyle(screen.getByText("Needs permission to run the command").element())
        .userSelect,
    ).toBe("text");
  });
  await expect.element(screen.getByText("Safari", { exact: true })).toBeVisible();
  await click(screen.button("Why am I being asked this?"));
  await expect.element(page.getByText(/an ask rule in the agent's own settings/)).toBeVisible();
  await click(screen.button("Why am I being asked this?"));
  await click(screen.buttons("More approval options")[1]!);
  await expect.element(page.getByRole("menuitem", { name: "Always allow Safari" })).toBeVisible();
  await page.getByRole("menuitem", { name: "Always allow Safari" }).click();
  expect(onRespondToApproval).toHaveBeenLastCalledWith(appRequest, "acceptAlways");
  await click(screen.buttons("More approval options")[0]!);
  await expect.element(page.getByRole("menuitem", { name: "Cancel", exact: true })).toBeVisible();
  await page.getByRole("menuitem", { name: "Always allow this session" }).click();
  expect(onRespondToApproval).toHaveBeenLastCalledWith(commandRequest, "acceptForSession");
  await click(screen.button("Decline"));
  expect(onRespondToApproval).toHaveBeenLastCalledWith(commandRequest, "decline");
  await click(screen.button("Allow once"));
  expect(onRespondToApproval).toHaveBeenLastCalledWith(appRequest, "accept");
  for (const timelineEntries of [entries(), []]) {
    await screen.rerender(
      ui({ timelineEntries, heldApprovalRequestIds: new Set([commandRequest]) }),
    );
    await expect
      .element(screen.getByRole("group", { name: "Command approval" }))
      .not.toBeInTheDocument();
    await vi.waitFor(() => expect(screen.buttons("Approve")).toHaveLength(0));
    await expect
      .element(screen.getByRole("button", { name: "Allow once", exact: true }))
      .toBeVisible();
    await screen.rerender(ui({ timelineEntries }));
    await expect.element(screen.getByRole("group", { name: "Command approval" })).toBeVisible();
    await vi.waitFor(() => expect(screen.buttons("Approve")).toHaveLength(1));
  }
  await screen.rerender(ui({ timelineEntries: [], isWorking: false }));
  await expect.element(screen.getByRole("group", { name: "Command approval" })).toBeVisible();
  await click(screen.button("Approve"));
  expect(onRespondToApproval).toHaveBeenLastCalledWith(commandRequest, "accept");
  await click(screen.button("Deny"));
  expect(onRespondToApproval).toHaveBeenLastCalledWith(appRequest, "decline");
  await screen.rerender(
    ui({
      timelineEntries: [],
      isWorking: false,
      pendingApprovals: [{ ...approvals[0]!, detail: "" }],
    }),
  );
  await expect
    .element(screen.getByLabelText("Command", { exact: true }))
    .toHaveTextContent("Command approval");
  await screen.rerender(ui({ canOperateThread: false }));
  await expect.element(screen.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  await vi.waitFor(() =>
    expect(
      screen.buttons("More approval options").every((button) => button.hasAttribute("disabled")),
    ).toBe(true),
  );
  await screen.rerender(ui({ respondingRequestIds: [commandRequest] }));
  await expect.element(screen.getByRole("button", { name: "Approve", exact: true })).toBeDisabled();
  await expect
    .element(screen.getByRole("button", { name: "Allow once", exact: true }))
    .toBeEnabled();
  await screen.rerender(
    ui({ pendingApprovals: [{ ...approvals[0]!, responseCapability: "not_resumable" }] }),
  );
  await expect
    .element(screen.getByText("Provider process is gone. Interrupt or restart the run to respond."))
    .toBeVisible();
  await vi.waitFor(() => expect(screen.buttons("Approve")).toHaveLength(0));
  await screen.rerender(
    ui({ pendingApprovals: [], timelineEntries: entries(true), isWorking: false }),
  );
  await expect
    .element(screen.getByRole("group", { name: "Command approval" }))
    .not.toBeInTheDocument();
  await vi.waitFor(() => expect(screen.text()).not.toContain("Waiting for approval"));
  await screen.getByRole("button", { expanded: false }).click();
  await expect
    .element(screen.getByRole("button", { name: approvals[0]!.detail!, exact: true }))
    .toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Open the current tab", exact: true }))
    .toBeVisible();
});

describe("MessagesTimeline thread links", () => {
  it("names a delegate_task worker's parent-thread link agent of", async () => {
    await using screen = await renderTimeline([], {
      parentThreadLink: {
        title: "Architecture audit",
        label: "agent of",
      },
    });
    expect(screen.text()).toContain("agent of");
    expect(screen.text()).not.toContain("subagent of");
    expect(screen.text()).toContain("Architecture audit");
  });

  it("names a provider-native subagent's parent-thread link subagent of", async () => {
    await using screen = await renderTimeline([], {
      parentThreadLink: { title: "Architecture audit" },
    });
    expect(screen.text()).toContain("subagent of");
    expect(screen.text()).toContain("Architecture audit");
  });
});

describe("MessagesTimeline reasoning expanded by default", () => {
  const RUN = RunId.make("run-reasoning");
  const FINISHED = {
    runId: RUN,
    status: "completed",
    startedAt: CREATED_AT,
    completedAt: CREATED_AT,
  };
  const RUNNING = { runId: RUN, status: "running", startedAt: CREATED_AT, completedAt: null };
  const LONG_THOUGHT = Array.from({ length: 60 }, (_, line) => `Thought line ${line}.`).join(
    "\n\n",
  );

  function expandReasoning() {
    reasoningSetting.on = true;
    return { [Symbol.dispose]: () => void (reasoningSetting.on = false) };
  }
  const thought = (id: string, detail = `${id} text`, entry: Record<string, unknown> = {}) =>
    work(id, {
      runId: RUN,
      label: "Thinking",
      tone: "thinking",
      itemType: "reasoning",
      detail,
      ...entry,
    });
  const tool = (id: string, entry: Record<string, unknown> = {}) =>
    work(id, {
      runId: RUN,
      label: `Ran ${id}`,
      command: `rg ${id}`,
      requestKind: "command",
      tone: "tool",
      toolLifecycleStatus: "completed",
      detail: `${id} output`,
      ...entry,
    });
  const filler = (count: number, name = "earlier") =>
    Array.from({ length: count }, (_, index) =>
      message(
        `${name} ${index}\n\n${"line\n\n".repeat(6)}`,
        { role: index % 2 === 0 ? "user" : "assistant" },
        `${name}-${index}`,
      ),
    );
  const turn = (...work: ReadonlyArray<Entry>) => [
    message("Go", { runId: RUN }, "go"),
    ...work,
    message("Done", { role: "assistant", runId: RUN }, "final"),
  ];
  const settledTurn = (index: number) => {
    const runId = RunId.make(`settled-${index}`);
    return [
      message(`Turn ${index}`, { runId }, `user-${index}`),
      work(`settled-${index}`, {
        runId,
        label: "Thinking",
        tone: "thinking",
        itemType: "reasoning",
        detail: `Settled thought ${index}`,
      }),
      message(`Reply ${index}`, { role: "assistant", runId }, `reply-${index}`),
    ];
  };
  const settledTurns = (count: number) =>
    Array.from({ length: count }, (_, index) => settledTurn(index)).flat();
  const rowOf = (container: Element, id: string) =>
    container.querySelector<HTMLElement>(`[data-timeline-row-id="${id}"]`);
  const toggleOf = (container: Element, id: string) =>
    rowOf(container, id)?.querySelector<HTMLElement>("[aria-expanded]") ?? null;
  const expectOpen = (container: Element, id: string, open: boolean) =>
    vi.waitFor(() =>
      expect(toggleOf(container, id)?.getAttribute("aria-expanded")).toBe(String(open)),
    );
  const detailsOf = (row: Element | null | undefined) =>
    row?.querySelector<HTMLElement>(".select-text") ?? null;
  async function scrollTo(viewport: HTMLElement, top: number) {
    await act(() => {
      viewport.scrollTop = top;
    });
  }
  // LegendList sees a scroll on the next frame, and a row keeps its container until another row
  // of the same item type needs it, so a row only unmounts once the scroll has walked past others.
  async function scrollListTo(list: LegendListRef, top: number) {
    const viewport = list.getScrollableNode()!;
    await scrollTo(viewport, top);
    await vi.waitFor(() =>
      expect(Math.abs(list.getState().scroll - viewport.scrollTop)).toBeLessThan(2),
    );
  }
  async function scrollRowOut(list: LegendListRef, container: Element, id: string) {
    const viewport = list.getScrollableNode()!;
    for (
      let top = viewport.scrollTop + 1000;
      top < viewport.scrollHeight && rowOf(container, id);
      top += 1000
    ) {
      await scrollListTo(list, top);
    }
    await vi.waitFor(() => expect(rowOf(container, id)).toBeNull());
  }
  // LegendList keeps rows click-through until its initial scroll settles, and that scroll can
  // still pull the list back to the end before then.
  const expectInitialScrollSettled = (row: () => HTMLElement | null | undefined) =>
    vi.waitFor(() => expect(getComputedStyle(row()!).pointerEvents).toBe("auto"));

  it("off, leaves a finished turn closed and its reasoning capped", async () => {
    setup();
    await using screen = await renderTimeline(turn(thought("thought-1", LONG_THOUGHT)), {
      latestRun: FINISHED as never,
    });
    await vi.waitFor(() => expect(screen.buttons(/^Worked for/)).toHaveLength(1));
    expect(rowOf(screen.container, "thought-1")).toBeNull();
    await click(screen.button(/^Worked for/));
    await expectOpen(screen.container, "thought-1", false);
    expect(detailsOf(rowOf(screen.container, "thought-1"))).toBeNull();
    await click(toggleOf(screen.container, "thought-1")!);
    await expectOpen(screen.container, "thought-1", true);
    const details = detailsOf(rowOf(screen.container, "thought-1"))!;
    expect(getComputedStyle(details).maxHeight).toBe("384px");
    expect(details.scrollHeight).toBeGreaterThan(details.clientHeight);
  });

  it("on, shows a finished turn's whole reasoning without a click", async () => {
    setup();
    using _on = expandReasoning();
    await using screen = await renderTimeline(turn(thought("thought-1", LONG_THOUGHT)), {
      latestRun: FINISHED as never,
    });
    await expectOpen(screen.container, "thought-1", true);
    const details = detailsOf(rowOf(screen.container, "thought-1"))!;
    expect(details.textContent).toContain("Thought line 59.");
    expect(getComputedStyle(details).maxHeight).toBe("none");
    expect(details.scrollHeight).toBeLessThanOrEqual(details.clientHeight);
  });

  it("re-seeds a mounted reasoning row when the setting changes, as when settings hydrate late", async () => {
    setup();
    onTestFinished(() => void (reasoningSetting.on = false));
    const props = baseProps();
    const timeline = () => (
      <MessagesTimeline
        {...props}
        isWorking
        runningRunId={RUN}
        latestRun={RUNNING as never}
        timelineEntries={[
          message("Go", { runId: RUN }, "go"),
          thought("thought-1"),
          message("Writing", { role: "assistant", runId: RUN, streaming: true }, "reply"),
        ]}
      />
    );
    await using screen = await renderElement(timeline());
    await expectOpen(screen.container, "thought-1", false);

    reasoningSetting.on = true;
    await screen.rerender(timeline());
    await expectOpen(screen.container, "thought-1", true);

    reasoningSetting.on = false;
    await screen.rerender(timeline());
    await expectOpen(screen.container, "thought-1", false);
  });

  it("on, a collapsed row stays collapsed across a scroll, a delta and a thread switch", async () => {
    setup();
    using _on = expandReasoning();
    const props = baseProps();
    const before = filler(3);
    const after = settledTurns(60);
    const timeline = (detail: string, next: Partial<TimelineProps> = {}) => (
      <MessagesTimeline
        {...props}
        liveFollowEnabled={false}
        latestRun={FINISHED as never}
        timelineEntries={[...before, ...turn(thought("thought-1", detail)), ...after]}
        {...next}
      />
    );
    await using screen = await renderElement(timeline("first"));
    const list = props.listRef.current!;
    const lastRow = () => rowOf(screen.container, "entry-reply-59");
    await vi.waitFor(() => expect(lastRow()).not.toBeNull());
    await expectInitialScrollSettled(lastRow);
    await scrollListTo(list, 0);
    await expectOpen(screen.container, "thought-1", true);

    await click(toggleOf(screen.container, "thought-1")!);
    await expectOpen(screen.container, "thought-1", false);
    expect(detailsOf(rowOf(screen.container, "thought-1"))).toBeNull();

    await scrollRowOut(list, screen.container, "thought-1");
    await scrollListTo(list, 0);
    await expectOpen(screen.container, "thought-1", false);

    await screen.rerender(timeline("first and a delta"));
    await expectOpen(screen.container, "thought-1", false);

    const leaveAndComeBack = async () => {
      await screen.rerender(
        timeline("first and a delta", {
          routeThreadKey: `${props.routeThreadKey}-other`,
          timelineEntries: [message("Another thread", {}, "other")],
        }),
      );
      await vi.waitFor(() => expect(rowOf(screen.container, "thought-1")).toBeNull());
      await screen.rerender(timeline("first and a delta"));
    };
    await leaveAndComeBack();
    await expectOpen(screen.container, "thought-1", false);

    await click(toggleOf(screen.container, "thought-1")!);
    await expectOpen(screen.container, "thought-1", true);
    await leaveAndComeBack();
    await expectOpen(screen.container, "thought-1", true);
  });

  it("on, a collapsed live row stays collapsed through a delta and once it settles", async () => {
    setup();
    using _on = expandReasoning();
    const props = baseProps();
    const live = (detail: string) => (
      <MessagesTimeline
        {...props}
        isWorking
        runningRunId={RUN}
        latestRun={RUNNING as never}
        timelineEntries={[
          message("Go", { runId: RUN }, "go"),
          thought("thought-1", detail, { toolLifecycleStatus: "inProgress" }),
        ]}
      />
    );
    await using screen = await renderElement(live("Live thought"));
    await expectOpen(screen.container, "live-activity-row", true);
    await vi.waitFor(() =>
      expect(detailsOf(rowOf(screen.container, "work-group:thought-1:details"))).not.toBeNull(),
    );

    await click(toggleOf(screen.container, "live-activity-row")!);
    await expectOpen(screen.container, "live-activity-row", false);
    await vi.waitFor(() =>
      expect(rowOf(screen.container, "work-group:thought-1:details")).toBeNull(),
    );

    await screen.rerender(live("Live thought grows"));
    await expectOpen(screen.container, "live-activity-row", false);
    expect(rowOf(screen.container, "work-group:thought-1:details")).toBeNull();

    await screen.rerender(
      <MessagesTimeline
        {...props}
        latestRun={FINISHED as never}
        timelineEntries={turn(thought("thought-1", "Live thought grows"))}
      />,
    );
    await expectOpen(screen.container, "thought-1", false);
  });

  it("on, a mixed group opens with its tool rows closed and no inner scroll for reasoning", async () => {
    setup();
    using _on = expandReasoning();
    await using screen = await renderTimeline(
      turn(thought("thought-1", LONG_THOUGHT), tool("tool-1"), thought("thought-2")),
      { latestRun: FINISHED as never },
    );
    await expectOpen(screen.container, "work-toggle:thought-1", true);
    const group = () => screen.container.querySelector<HTMLElement>("[data-tool-group-scroll]");
    const entry = (name: string) =>
      [...(group()?.querySelectorAll<HTMLElement>("[aria-expanded]") ?? [])].find((row) =>
        (row.getAttribute("aria-label") ?? "").includes(name),
      );
    await vi.waitFor(() => expect(entry("rg tool-1")).toBeDefined());
    expect(entry("rg tool-1")!.getAttribute("aria-expanded")).toBe("false");
    expect(group()!.textContent).not.toContain("tool-1 output");
    await vi.waitFor(() => {
      expect(group()!.textContent).toContain("Thought line 59.");
      expect(group()!.scrollHeight).toBeLessThanOrEqual(group()!.clientHeight + 1);
    });

    // A tool row keeps its cap when the user opens it.
    await click(entry("rg tool-1")!);
    await vi.waitFor(() => expect(group()!.textContent).toContain("tool-1 output"));
    expect(getComputedStyle(group()!.querySelector("pre")!).maxHeight).not.toBe("none");

    await click(toggleOf(screen.container, "work-toggle:thought-1")!);
    await vi.waitFor(() => expect(group()).toBeNull());
    await click(toggleOf(screen.container, "work-toggle:thought-1")!);
    await vi.waitFor(() => expect(group()).not.toBeNull());
  });

  const attempt = (id: string, attemptOrdinal: number, status: "superseded" | "running") => ({
    id: RunAttemptId.make(id),
    runId: RUN,
    attemptOrdinal,
    rootNodeId: `node-${id}` as never,
    status,
    completedAt: null,
  });
  const supersededAttempt = attempt("attempt-1", 1, "superseded");
  const activeAttempt = attempt("attempt-2", 2, "running");
  const inAttempt = (entry: Entry, entryAttempt: typeof supersededAttempt): Entry => ({
    ...entry,
    attempt: entryAttempt,
  });
  const supersededTurn = [
    inAttempt(message("Build it", { runId: RUN }, "question"), supersededAttempt),
    inAttempt(thought("old-thought"), supersededAttempt),
    inAttempt(
      message("the cited answer", { role: "assistant", runId: RUN }, "cited"),
      supersededAttempt,
    ),
    inAttempt(message("Change direction", { runId: RUN }, "steer"), activeAttempt),
    inAttempt(
      message("Current response", { role: "assistant", runId: RUN }, "current"),
      activeAttempt,
    ),
  ];

  it.each([
    {
      name: "turn",
      entries: turn(thought("thought-1")),
      latestRun: FINISHED,
      heading: /^Worked for/,
      hidden: "thought-1",
    },
    {
      name: "attempt",
      entries: supersededTurn,
      latestRun: RUNNING,
      heading: /^Superseded attempt/,
      hidden: "old-thought",
    },
  ])("on, a $name fold closes and reopens", async ({ entries, latestRun, heading, hidden }) => {
    setup();
    using _on = expandReasoning();
    await using screen = await renderTimeline(entries, { latestRun: latestRun as never });
    await expectOpen(screen.container, hidden, true);
    await click(screen.button(heading));
    await vi.waitFor(() => expect(rowOf(screen.container, hidden)).toBeNull());
    await click(screen.button(heading));
    await expectOpen(screen.container, hidden, true);
  });

  it("on, find opens the fold a user collapsed and leaves it open", async () => {
    setup();
    using _on = expandReasoning();
    const props = baseProps();
    const needle = message("Needle here", { role: "assistant", runId: RUN }, "needle");
    const timeline = (next: Partial<TimelineProps> = {}) => (
      <MessagesTimeline
        {...props}
        latestRun={FINISHED as never}
        timelineEntries={turn(needle, thought("thought-1"))}
        {...next}
      />
    );
    await using screen = await renderElement(timeline());
    await vi.waitFor(() => expect(rowOf(screen.container, "entry-needle")).not.toBeNull());
    await click(screen.button(/^Worked for/));
    await vi.waitFor(() => expect(rowOf(screen.container, "entry-needle")).toBeNull());
    const finding = {
      findOpen: true,
      findExpanded: true,
      findQuery: "Needle",
      activeFindMatch: { entryId: "entry-needle", runId: null, occurrence: 0 },
    };
    await screen.rerender(timeline(finding));
    await vi.waitFor(() => expect(rowOf(screen.container, "entry-needle")).not.toBeNull());
    await screen.rerender(timeline());
    await vi.waitFor(() => expect(screen.button(/^Worked for/)).toBeDefined());
    expect(rowOf(screen.container, "entry-needle")).not.toBeNull();

    // While find holds a match in the fold, closing it waits for find to let go, as it does off.
    await screen.rerender(timeline(finding));
    await click(screen.button(/^Worked for/));
    await expectOpen(screen.container, "thought-1", true);
    expect(rowOf(screen.container, "entry-needle")).not.toBeNull();
    await screen.rerender(timeline());
    await vi.waitFor(() => expect(rowOf(screen.container, "entry-needle")).toBeNull());
  });

  it("on, a collapsed fold stays collapsed after leaving the thread", async () => {
    setup();
    using _on = expandReasoning();
    const props = baseProps();
    const timeline = (next: Partial<TimelineProps> = {}) => (
      <MessagesTimeline
        {...props}
        latestRun={FINISHED as never}
        timelineEntries={turn(thought("thought-1"))}
        {...next}
      />
    );
    await using screen = await renderElement(timeline());
    await expectOpen(screen.container, "thought-1", true);
    await click(screen.button(/^Worked for/));
    await vi.waitFor(() => expect(rowOf(screen.container, "thought-1")).toBeNull());
    await vi.waitFor(() =>
      expect(
        readTimelinePosition(props.routeThreadKey)?.disclosures?.collapsedWorkGroups.has(RUN),
      ).toBe(true),
    );
    await screen.rerender(
      timeline({
        routeThreadKey: `${props.routeThreadKey}-other`,
        latestRun: null,
        timelineEntries: [message("Another thread", {}, "other")],
      }),
    );
    await vi.waitFor(() => expect(screen.text()).toContain("Another thread"));
    await screen.rerender(timeline());
    await vi.waitFor(() => expect(screen.button(/^Worked for/)).toBeDefined());
    expect(screen.button(/^Worked for/).getAttribute("aria-expanded")).toBe("false");
    expect(rowOf(screen.container, "thought-1")).toBeNull();
  });

  it("on, a citation opens the attempt fold a user collapsed", async () => {
    setup();
    using _on = expandReasoning();
    const props = baseProps();
    const timeline = (next: Partial<TimelineProps> = {}) => (
      <MessagesTimeline
        {...props}
        latestRun={RUNNING as never}
        timelineEntries={supersededTurn}
        {...next}
      />
    );
    await using screen = await renderElement(timeline());
    await expectOpen(screen.container, "old-thought", true);
    await click(screen.button(/^Superseded attempt/));
    await vi.waitFor(() => expect(rowOf(screen.container, "old-thought")).toBeNull());
    await screen.rerender(
      timeline({ citationRequest: CITATION_REQUEST, citationHistory: { _tag: "found" } }),
    );
    await vi.waitFor(() =>
      expect(document.querySelector("[data-citation-highlighted]")?.textContent).toContain(
        "the cited answer",
      ),
    );
  });

  it("on, a long thread keeps its virtualized rows", async () => {
    setup();
    const thread = settledTurns(150);
    const mountedRows = async () => {
      await using screen = await renderTimeline(thread);
      await vi.waitFor(() => expect(screen.text()).toContain("Reply 149"));
      return screen.container.querySelectorAll("[data-timeline-row-id]").length;
    };
    const closed = await mountedRows();
    using _on = expandReasoning();
    const open = await mountedRows();
    // Open reasoning is taller, so the view holds fewer rows per screen, never every row.
    expect(open).toBeLessThanOrEqual(closed + 24);
    expect(open).toBeLessThan(thread.length / 4);
  });

  it("on, streaming reasoning keeps the bottom anchor", async () => {
    setup();
    using _on = expandReasoning();
    const props = baseProps();
    const live = (detail: string) => (
      <MessagesTimeline
        {...props}
        isWorking
        runningRunId={RUN}
        latestRun={RUNNING as never}
        timelineEntries={[
          ...filler(20),
          message("Go", { runId: RUN }, "go"),
          thought("thought-1", detail, { toolLifecycleStatus: "inProgress" }),
        ]}
      />
    );
    await using screen = await renderElement(live("Line 0."));
    const viewport = props.listRef.current!.getScrollableNode()!;
    const distanceFromEnd = () =>
      viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
    await vi.waitFor(() => expect(distanceFromEnd()).toBeLessThan(2));
    let detail = "Line 0.";
    for (let line = 1; line <= 8; line += 1) {
      detail += `\n\nLine ${line}.\n\n${"more ".repeat(120)}`;
      const height = viewport.scrollHeight;
      await screen.rerender(live(detail));
      await vi.waitFor(() => {
        expect(viewport.scrollHeight).toBeGreaterThan(height);
        expect(distanceFromEnd()).toBeLessThan(2);
      });
    }
  });

  it("on, streaming reasoning below a heading leaves the heading in place", async () => {
    setup();
    using _on = expandReasoning();
    const props = baseProps();
    const live = (detail: string) => (
      <MessagesTimeline
        {...props}
        isWorking
        runningRunId={RUN}
        liveFollowEnabled={false}
        latestRun={RUNNING as never}
        timelineEntries={[
          ...filler(20),
          message("Go", { runId: RUN }, "go"),
          thought("thought-1", detail, { toolLifecycleStatus: "inProgress" }),
        ]}
      />
    );
    await using screen = await renderElement(live("Line 0."));
    const viewport = props.listRef.current!.getScrollableNode()!;
    const heading = () => rowOf(screen.container, "entry-go");
    await vi.waitFor(() => expect(heading()).not.toBeNull());
    await expectInitialScrollSettled(heading);
    await scrollListTo(props.listRef.current!, viewport.scrollHeight - viewport.clientHeight - 200);
    const top = heading()!.getBoundingClientRect().top;
    let detail = "Line 0.";
    for (let line = 1; line <= 4; line += 1) {
      detail += `\n\nLine ${line}.\n\n${"more ".repeat(120)}`;
      await screen.rerender(live(detail));
      await vi.waitFor(() =>
        expect(
          detailsOf(rowOf(screen.container, "work-group:thought-1:details"))?.textContent,
        ).toContain(`Line ${line}.`),
      );
    }
    expect(heading()!.getBoundingClientRect().top).toBeCloseTo(top, 0);
  });

  it("on, a delta renders no settled row and only the timeline reads the setting", async () => {
    setup();
    using _on = expandReasoning();
    const props = baseProps();
    const finishedRows = settledTurns(12);
    const live = (detail: string) => (
      <MessagesTimeline
        {...props}
        isWorking
        runningRunId={RUN}
        latestRun={RUNNING as never}
        timelineEntries={[
          ...finishedRows,
          message("Go", { runId: RUN }, "go"),
          thought("thought-1", detail, { toolLifecycleStatus: "inProgress" }),
          tool("tool-1", { toolLifecycleStatus: "inProgress" }),
        ]}
      />
    );
    reasoningSetting.reads = 0;
    reasoningSetting.timelineRenders = 0;
    await using screen = await renderElement(live("Line 0."));
    await expectOpen(screen.container, "settled-11", true);
    await vi.waitFor(() =>
      expect(screen.container.querySelector("[data-tool-group-scroll]")).not.toBeNull(),
    );
    expect(reasoningSetting.reads).toBe(reasoningSetting.timelineRenders);
    const settledRows = screen.container.querySelectorAll(
      '[data-timeline-row-kind="work"] section[aria-label="Activity"]',
    ).length;
    reasoningSetting.rowRenders = 0;

    await screen.rerender(live("Line 0 and a delta."));
    await vi.waitFor(() =>
      expect(screen.container.querySelector("[data-tool-group-scroll]")?.textContent).toContain(
        "Line 0 and a delta.",
      ),
    );

    // The live row and its two entries, so a render of every mounted row would not fit.
    expect(settledRows).toBeGreaterThan(3);
    expect(reasoningSetting.rowRenders).toBeLessThanOrEqual(3);
    expect(reasoningSetting.reads).toBe(reasoningSetting.timelineRenders);
  });
});
