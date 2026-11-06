import * as DateTime from "effect/DateTime";
import { threadKey } from "@t3tools/client-runtime/state/entities";
import { EnvironmentId, NodeId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const state = vi.hoisted(() => ({
  projection: null as unknown,
  commandSucceeds: false,
  relatedShells: [] as unknown[],
  threadTitles: {} as Record<string, string>,
  archivedThreads: [] as unknown[],
  hiddenKeys: new Set<string>(),
  projects: [] as unknown[],
}));

vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((atom: unknown) =>
    atom === null
      ? { data: null, isSuccess: false, isPending: false }
      : { data: state.threadTitles, isSuccess: true, isPending: false }) as never,
}));

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => false) as never,
}));

vi.mock(import("../../state/entities"), () => ({
  useQuietThreadShell: (() => null) as never,
  useThreadProjection: ((ref: unknown) =>
    ref === null ? null : { projection: state.projection }) as never,
  useThreadRelationshipShells: (() =>
    state.projection === null
      ? []
      : [(state.projection as { thread: unknown }).thread, ...state.relatedShells]) as never,
  useProjects: (() => state.projects) as never,
  useHiddenThreadKeys: (() => state.hiddenKeys) as never,
  useAnyEnvironmentHiding: (() => false) as never,
}));
vi.mock(import("../../state/environments"), () => ({
  useEnvironment: (() => null) as never,
  useEnvironmentProviders: (() => new Map()) as never,
}));
vi.mock(import("../../lib/archivedThreadsState"), () => ({
  useArchivedThreadSnapshots: (() => ({
    snapshots: [{ environmentId: "environment", snapshot: { threads: state.archivedThreads } }],
  })) as never,
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => async () =>
    state.commandSucceeds
      ? AsyncResult.success(undefined)
      : AsyncResult.failure(Cause.fail(new Error("Connection lost")))) as never,
}));

import "~/index.css";
import { render } from "../../../test/render";
import { makeThreadProjectionFixture } from "../../test-fixtures";
import { ToastProvider } from "../ui/toast";
import { ThreadRelationshipsPanel } from "./ThreadRelationshipsControl";
import { useLineageFoldStore } from "./ThreadRelationshipsControl.logic";

const environmentId = EnvironmentId.make("environment");
const threadId = ThreadId.make("fork");

function setup() {
  state.commandSucceeds = false;
  state.relatedShells = [];
  state.threadTitles = { source: "Source" };
  state.archivedThreads = [];
  state.hiddenKeys = new Set();
  state.projects = [];
  useLineageFoldStore.setState({ folded: new Map(), settledOpen: new Set() });
  state.projection = {
    thread: {
      id: threadId,
      title: "Fork",
      activeProviderThreadId: null,
      lineage: { parentThreadId: ThreadId.make("source"), relationshipToParent: "fork" },
      forkedFrom: null,
    },
    runs: [{ id: "run", ordinal: 1, status: "completed" }],
    subagents: [],
    contextTransfers: [],
    providerThreads: [],
    providerSessions: [{ id: "session", status: "ready" }],
  };
}

it.each([
  ["merge", "Could not merge back"],
  ["disconnect", "Could not disconnect agent session"],
])("reports a rejected %s command and clears the busy state", async (action, title) => {
  setup();
  await using screen = await render(
    <ToastProvider timeout={0}>
      <ThreadRelationshipsPanel
        environmentId={environmentId}
        threadId={threadId}
        showLineage
        showSideChats
      />
    </ToastProvider>,
  );

  if (action === "merge") {
    await screen.getByRole("button", { name: "Merge back to source conversation" }).click();
  } else {
    await screen.getByRole("button", { name: "More thread actions" }).click();
    await page.getByRole("menuitem", { name: "Disconnect agent session" }).click();
  }

  await expect.element(page.getByText(title, { exact: true })).toBeVisible();
  await expect
    .element(
      screen.getByRole("button", {
        name: action === "merge" ? "Merge back to source conversation" : "More thread actions",
      }),
    )
    .toBeEnabled();
});

it.each([
  ["merge", "Could not merge back"],
  ["disconnect", "Could not disconnect agent session"],
])("clears the previous %s error after a successful retry", async (action, title) => {
  setup();
  await using screen = await render(
    <ToastProvider timeout={0}>
      <ThreadRelationshipsPanel
        environmentId={environmentId}
        threadId={threadId}
        showLineage
        showSideChats
      />
    </ToastProvider>,
    { router: "/environment/fork" },
  );

  const runAction = async () => {
    if (action === "merge") {
      await screen.getByRole("button", { name: "Merge back to source conversation" }).click();
    } else {
      await screen.getByRole("button", { name: "More thread actions" }).click();
      await page.getByRole("menuitem", { name: "Disconnect agent session" }).click();
    }
  };

  await runAction();
  await expect.element(page.getByText(title, { exact: true })).toBeVisible();
  expect(screen.router?.state.location.pathname).toBe("/environment/fork");

  state.commandSucceeds = true;
  await runAction();

  await expect.element(page.getByText(title, { exact: true })).not.toBeInTheDocument();
  await vi.waitFor(() => {
    expect(screen.router?.state.location.pathname).toBe(
      action === "merge" ? "/environment/source" : "/environment/fork",
    );
  });
  if (action === "disconnect") {
    await expect.element(screen.getByRole("button", { name: "More thread actions" })).toBeEnabled();
  }
});

it("opens an idle child from Lineage when its shell has not been loaded", async () => {
  setup();
  const projection = makeThreadProjectionFixture();
  const childId = ThreadId.make("omitted-child");
  const environmentId = EnvironmentId.make("local");
  state.projection = {
    ...projection,
    subagents: [
      {
        id: NodeId.make("agent"),
        threadId: projection.thread.id,
        runId: null,
        parentNodeId: NodeId.make("parent"),
        origin: "app_owned",
        createdBy: "agent",
        driver: "codex",
        providerInstanceId: projection.thread.providerInstanceId,
        providerThreadId: null,
        childThreadId: childId,
        nativeTaskRef: null,
        prompt: "Inspect the change",
        title: "Idle child",
        model: null,
        status: "completed",
        result: null,
        startedAt: null,
        completedAt: projection.thread.updatedAt,
        updatedAt: projection.thread.updatedAt,
      },
    ],
  };
  await using screen = await render(
    <ThreadRelationshipsPanel
      environmentId={environmentId}
      threadId={projection.thread.id}
      showLineage
      showSideChats
    />,
  );
  await screen.getByRole("button", { name: /Previous agents/ }).click();
  const child = screen.getByRole("button", { name: /Idle child/ });
  await expect.element(child).toBeEnabled();
  await child.click();
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe("/local/omitted-child"),
  );
});

it("shows a lineage thread's full title in its tooltip", async () => {
  setup();
  const longTitle = "Compare the lineage tooltip against a title that the row truncates";
  const sourceThread = {
    ...(state.projection as { thread: Record<string, unknown> }).thread,
    id: "source",
    title: longTitle,
    lineage: { parentThreadId: null, relationshipToParent: null },
  };
  state.relatedShells = [sourceThread];
  await using _screen = await render(
    <ThreadRelationshipsPanel
      environmentId={environmentId}
      threadId={threadId}
      showLineage
      showSideChats={false}
    />,
  );

  await userEvent.hover(page.getByText(longTitle, { exact: true }));
  await vi.waitFor(() =>
    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(longTitle),
  );
});

it("shows a side chat's full title in its tooltip", async () => {
  setup();
  const longTitle = "Side chat question with a title that the side chat row truncates";
  state.relatedShells = [
    {
      id: "side",
      title: longTitle,
      lineage: {
        parentThreadId: threadId,
        relationshipToParent: "fork",
        rootThreadId: threadId,
        sideChat: true,
      },
    },
  ];
  await using _screen = await render(
    <ThreadRelationshipsPanel
      environmentId={environmentId}
      threadId={threadId}
      showLineage={false}
      showSideChats
    />,
  );

  await userEvent.hover(page.getByText(longTitle, { exact: true }));
  await vi.waitFor(() =>
    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(longTitle),
  );
});

it("shows a remote subagent's full title in its tooltip even when its environment is unavailable", async () => {
  setup();
  const longTitle = "Investigate a remote subagent issue across linked environments";
  const remoteEnvId = EnvironmentId.make("remote-env");
  const remoteThreadId = ThreadId.make("remote-thread");
  const now = DateTime.makeUnsafe("2026-10-31T20:00:00.000Z");
  state.projection = {
    ...(state.projection as Record<string, unknown>),
    subagents: [
      {
        id: NodeId.make("remote-agent"),
        threadId,
        runId: null,
        parentNodeId: NodeId.make("parent"),
        origin: "app_owned",
        createdBy: "agent",
        driver: "codex",
        providerInstanceId: "provider",
        providerThreadId: null,
        childThreadId: null,
        nativeTaskRef: null,
        prompt: "Run remote task",
        title: longTitle,
        model: null,
        status: "completed",
        result: null,
        startedAt: null,
        completedAt: null,
        updatedAt: now,
        remoteChild: {
          environmentId: remoteEnvId,
          threadId: remoteThreadId,
          label: "Remote VM",
        },
      },
    ],
  };
  await using screen = await render(
    <ThreadRelationshipsPanel
      environmentId={environmentId}
      threadId={threadId}
      showLineage
      showSideChats={false}
    />,
    { router: "/environment/fork" },
  );

  const row = screen.getByRole("button", { name: new RegExp(longTitle) });
  await userEvent.hover(row);
  await vi.waitFor(() =>
    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(longTitle),
  );
  expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(
    "Runs on Remote VM. Connect to it to open the thread there.",
  );

  await row.click({ force: true });
  expect(screen.router?.state.location.pathname).toBe("/environment/fork");
});

it("shows a delegated-from thread's full title in its tooltip even when its environment is unavailable", async () => {
  setup();
  const longTitle = "Parent task delegated from another machine that has a long description";
  state.projection = {
    ...(state.projection as Record<string, unknown>),
    thread: {
      ...(state.projection as { thread: Record<string, unknown> }).thread,
      delegatedFrom: {
        environmentId: EnvironmentId.make("parent-env"),
        threadId: ThreadId.make("parent-thread"),
        title: longTitle,
      },
    },
  };
  await using screen = await render(
    <ThreadRelationshipsPanel
      environmentId={environmentId}
      threadId={threadId}
      showLineage
      showSideChats={false}
    />,
    { router: "/environment/fork" },
  );

  const row = screen.getByRole("button", { name: new RegExp(longTitle) });
  await userEvent.hover(row);
  await vi.waitFor(() =>
    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(longTitle),
  );
  expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(
    "Delegated from a linked environment. Connect to it to open the parent thread.",
  );

  await row.click({ force: true });
  expect(screen.router?.state.location.pathname).toBe("/environment/fork");
});

it("hides a deleted fork and keeps unloaded and archived forks with their current titles", async () => {
  setup();
  const projection = makeThreadProjectionFixture();
  state.threadTitles = { "unloaded-fork": "Unloaded fork", "archived-fork": "Archived fork" };
  state.archivedThreads = [
    {
      ...projection.thread,
      id: ThreadId.make("archived-fork"),
      title: "Old archived title",
      archivedAt: projection.thread.updatedAt,
      lineage: { parentThreadId: projection.thread.id, relationshipToParent: "fork" },
    },
  ];
  state.projection = {
    ...projection,
    contextTransfers: ["deleted-fork", "unloaded-fork", "archived-fork"].map((id) => ({
      sourceThreadId: projection.thread.id,
      targetThreadId: ThreadId.make(id),
      status: "pending",
    })),
  };
  await using screen = await render(
    <ThreadRelationshipsPanel
      environmentId={environmentId}
      threadId={projection.thread.id}
      showLineage
      showSideChats
    />,
  );
  await expect.element(screen.getByText("Unloaded fork", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("Archived fork", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("deleted-fork", { exact: true })).not.toBeInTheDocument();
});

const familyShell = (id: string, title: string, extra: Record<string, unknown> = {}) => {
  const { thread } = makeThreadProjectionFixture();
  return {
    ...thread,
    id: ThreadId.make(id),
    title,
    latestRunId: "run",
    activeRunId: null,
    activityRunStatus: null,
    status: "completed",
    pendingRuntimeRequest: null,
    hasActionableProposedPlan: false,
    latestUserMessageAt: null,
    itemCount: 0,
    visibleItemCount: 0,
    lineage: {
      rootThreadId: ThreadId.make(id),
      parentThreadId: null,
      relationshipToParent: null,
    },
    ...extra,
  };
};

const settled = { settledOverride: "settled" };

/** Renders the panel for a thread with the given fields, among the given related shells. */
function setupFamily(current: Record<string, unknown>, related: unknown[]) {
  setup();
  const projection = makeThreadProjectionFixture();
  const { id, title } = projection.thread;
  state.projection = { ...projection, thread: { ...familyShell(id, title), ...current } };
  state.relatedShells = related;
  return id;
}

const familyRows = () =>
  [...document.querySelectorAll('[aria-label="Thread family"] li > div')].map(
    (row) => row.textContent,
  );

const familyRow = (title: string) =>
  page.getByText(title, { exact: true }).element().closest("li > div") as HTMLElement;

const running = { status: "running", activityRunStatus: "running" };

const renderFamilyPanel = (currentThreadId: ThreadId) =>
  render(
    <div style={{ width: 280 }}>
      <ThreadRelationshipsPanel
        environmentId={environmentId}
        threadId={currentThreadId}
        showLineage
        showSideChats
      />
    </div>,
    { router: "/environment/current" },
  );

const heading = (name: string | RegExp) => page.getByRole("heading", { name });

it("names the opener in the family tree with its status and links to it", async () => {
  const id = setupFamily({ openedByThreadId: ThreadId.make("captain") }, [
    familyShell("captain", "Captain", running),
  ]);
  await using screen = await renderFamilyPanel(id);

  await expect.element(page.getByRole("heading", { name: "Lineage" })).toBeVisible();
  await expect.element(heading("Family")).toBeVisible();
  const row = screen.getByRole("button", { name: /^Captain/ });
  await expect.element(row).toHaveTextContent("CaptainRunning");
  await row.click();
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe("/environment/captain"),
  );
});

it.each([
  ["no opener, opened thread or group", {}, []],
  ["a dangling opener", { openedByThreadId: "deleted-opener" }, []],
  [
    "an opener that was deleted",
    { openedByThreadId: "captain" },
    [familyShell("captain", "Captain", { deletedAt: "2026-06-24T00:00:00.000Z" })],
  ],
  ["a group of one", { tags: ["group:fleet"] }, []],
  ["only an empty group tag", { tags: ["group:"] }, [familyShell("m", "M", { tags: ["group:"] })]],
])("keeps the panel hidden with %s", async (_name, current, related) => {
  const id = setupFamily(current, related);
  await using screen = await renderFamilyPanel(id);

  await expect.element(heading("Lineage")).not.toBeInTheDocument();
  await expect.element(screen.getByText("deleted-opener")).not.toBeInTheDocument();
  await expect.element(screen.getByText("Unknown")).not.toBeInTheDocument();
});

it("lists opened threads needing the user first and folds settled ones", async () => {
  const fixtureId = makeThreadProjectionFixture().thread.id;
  const openedBy = { openedByThreadId: fixtureId };
  const id = setupFamily({ title: "Captain" }, [
    familyShell("working", "Mate working", { ...openedBy, ...running }),
    familyShell("asking", "Mate asking", {
      ...openedBy,
      ...running,
      pendingRuntimeRequest: {
        id: "request",
        kind: "user_input",
        createdAt: makeThreadProjectionFixture().updatedAt,
      },
    }),
    familyShell("settled-a", "Mate settled A", { ...openedBy, ...settled }),
    familyShell("settled-running", "Mate settled but running", {
      ...openedBy,
      ...settled,
      ...running,
    }),
  ]);
  await using screen = await renderFamilyPanel(id);

  await expect.element(heading("Family")).toBeVisible();
  expect(familyRows().map((title) => title?.replace(/(Running|Done)$/, ""))).toEqual([
    "Captain",
    "Mate asking",
    "Mate settled but running",
    "Mate working",
  ]);
  await expect.element(screen.getByText("Mate settled A", { exact: true })).not.toBeInTheDocument();

  const fold = screen.getByRole("button", { name: "Settled (1)" });
  await expect.element(fold).toHaveTextContent("Settled (1)");
  await fold.click();
  await expect.element(screen.getByText("Mate settled A", { exact: true })).toBeVisible();
  await fold.click();
  await expect.element(screen.getByText("Mate settled A", { exact: true })).not.toBeInTheDocument();
});

it("shows the group's other live members and counts the settled ones without a link", async () => {
  const group = { tags: ["group:fleet"] };
  const id = setupFamily(group, [
    familyShell("mate-b", "Mate B", { ...group, status: "running", activityRunStatus: "running" }),
    familyShell("mate-c", "Mate C", { ...group, ...settled }),
    familyShell("mate-d", "Mate D", { ...group, ...settled }),
    familyShell("elsewhere", "Other fleet", { tags: ["group:Fleet"] }),
  ]);
  await using screen = await renderFamilyPanel(id);

  await expect.element(heading("Group: fleet")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: /Mate B/ })).toBeVisible();
  await expect.element(screen.getByText("Mate C", { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByText("Other fleet", { exact: true })).not.toBeInTheDocument();
  const count = screen.getByText("+2 settled", { exact: true });
  await expect.element(count).toBeVisible();
  expect(count.element().closest("a, button")).toBeNull();
});

it("leaves hidden threads out of the group's rows and count", async () => {
  const group = { tags: ["group:fleet"] };
  const id = setupFamily(group, [
    familyShell("hidden-live", "Hidden live", group),
    familyShell("hidden-settled", "Hidden settled", { ...group, ...settled }),
  ]);
  state.hiddenKeys = new Set(
    ["hidden-live", "hidden-settled"].map((hidden) =>
      threadKey({ environmentId, threadId: ThreadId.make(hidden) }),
    ),
  );
  await using _screen = await renderFamilyPanel(id);

  await expect.element(heading("Lineage")).not.toBeInTheDocument();
  await expect.element(page.getByText("Hidden live", { exact: true })).not.toBeInTheDocument();
});

it("gives each thread one row across agents, opener, opened and group", async () => {
  const group = { tags: ["group:fleet"] };
  const fixtureId = makeThreadProjectionFixture().thread.id;
  const workerLineage = {
    rootThreadId: fixtureId,
    parentThreadId: fixtureId,
    relationshipToParent: "subagent",
  };
  const id = setupFamily({ ...group, openedByThreadId: ThreadId.make("captain") }, [
    familyShell("captain", "Captain", group),
    familyShell("opened", "Opened mate", { ...group, openedByThreadId: fixtureId }),
    familyShell("worker", "Worker", {
      ...group,
      openedByThreadId: fixtureId,
      lineage: workerLineage,
      status: "running",
      activityRunStatus: "running",
    }),
  ]);
  const projection = state.projection as ReturnType<typeof makeThreadProjectionFixture>;
  state.projection = {
    ...projection,
    subagents: [
      {
        id: NodeId.make("worker-agent"),
        threadId: id,
        runId: null,
        parentNodeId: NodeId.make("parent"),
        origin: "app_owned",
        createdBy: "agent",
        driver: "codex",
        providerInstanceId: projection.thread.providerInstanceId,
        providerThreadId: null,
        childThreadId: ThreadId.make("worker"),
        nativeTaskRef: null,
        prompt: "Work",
        title: "Worker",
        model: null,
        status: "running",
        result: null,
        startedAt: null,
        completedAt: null,
        updatedAt: projection.thread.updatedAt,
      },
    ],
  };
  await using screen = await renderFamilyPanel(id);

  await expect.element(heading("Group: fleet")).toBeVisible();
  await expect.element(screen.getByText(/settled/)).not.toBeInTheDocument();
  for (const title of ["Captain", "Opened mate", "Worker"]) {
    expect(screen.getByRole("button", { name: new RegExp(`^${title}`) }).elements()).toHaveLength(1);
  }
  await expect.element(screen.getByText("agent", { exact: true })).toBeVisible();
});

it("truncates long titles and group names inside the panel", async () => {
  const longTitle = "An opener whose title is far too long to fit on one row of the details panel";
  const longGroup = "a-group-name-long-enough-to-overflow-the-details-panel";
  const id = setupFamily(
    { tags: [`group:${longGroup}`], openedByThreadId: ThreadId.make("long") },
    [
      familyShell("long", longTitle),
      familyShell("member", "Member", { tags: [`group:${longGroup}`] }),
    ],
  );
  await using _screen = await renderFamilyPanel(id);

  for (const text of [longTitle, `Group: ${longGroup}`]) {
    const label = page.getByText(text, { exact: true });
    await expect.element(label).toBeVisible();
    const element = label.element();
    expect(element.scrollWidth).toBeGreaterThan(element.clientWidth);
    expect(element.getBoundingClientRect().right).toBeLessThanOrEqual(
      element.closest("section")!.getBoundingClientRect().right,
    );
  }
  await userEvent.hover(page.getByText(`Group: ${longGroup}`, { exact: true }));
  await vi.waitFor(() =>
    expect(document.querySelector('[data-slot="tooltip-popup"]')?.textContent).toContain(longGroup),
  );
});

/** Root, Middle and Sibling under it, Leaf under Middle, each opened by the one above. */
const seededFamily = (currentTitle: string) => {
  const fixtureId = makeThreadProjectionFixture().thread.id;
  const idOf = (title: string) => (title === currentTitle ? fixtureId : ThreadId.make(title));
  const shells = [
    { title: "Root", opener: null, createdAt: 1 },
    { title: "Sibling", opener: "Root", createdAt: 2 },
    { title: "Middle", opener: "Root", createdAt: 3 },
    { title: "Leaf", opener: "Middle", createdAt: 4 },
  ];
  const fields = ({ opener, createdAt }: (typeof shells)[number]) => ({
    createdAt: DateTime.makeUnsafe(createdAt),
    ...(opener === null ? {} : { openedByThreadId: idOf(opener) }),
  });
  const current = shells.find(({ title }) => title === currentTitle)!;
  return {
    current: { title: currentTitle, ...fields(current) },
    related: shells
      .filter(({ title }) => title !== currentTitle)
      .map((entry) => familyShell(idOf(entry.title), entry.title, fields(entry))),
  };
};

it.each([
  ["Root", ["Root", "Middle", "Leaf", "Sibling"]],
  ["Middle", ["Root", "Middle", "Leaf", "Sibling"]],
  ["Leaf", ["Root", "Middle", "Leaf", "Sibling"]],
])("shows the whole family from %s, marked and indented", async (currentTitle, order) => {
  const { current, related } = seededFamily(currentTitle);
  const id = setupFamily(current, related);
  await using screen = await renderFamilyPanel(id);

  await expect.element(heading("Family")).toBeVisible();
  expect(familyRows().map((title) => title?.replace(/Done$/, ""))).toEqual(order);

  const indentOf = (title: string) => familyRow(title).style.paddingInlineStart;
  expect([indentOf("Root"), indentOf("Middle"), indentOf("Leaf")]).toEqual([
    "0rem",
    "0.625rem",
    "1.25rem",
  ]);

  const marked = [...document.querySelectorAll('[aria-current="true"]')];
  expect(marked.map((row) => row.textContent)).toEqual([`${currentTitle}Done`]);
  expect(marked[0]?.closest("a, button")).toBeNull();
  await expect
    .element(screen.getByRole("button", { name: new RegExp(`^${currentTitle}`) }))
    .not.toBeInTheDocument();

  const start = screen.router?.state.location.pathname;
  (marked[0] as HTMLElement).click();
  await expect.element(screen.getByText(currentTitle, { exact: true })).toBeVisible();
  expect(screen.router?.state.location.pathname).toBe(start);
});

it("follows a family row to its thread", async () => {
  const { current, related } = seededFamily("Middle");
  await using screen = await renderFamilyPanel(setupFamily(current, related));
  await screen.getByRole("button", { name: /^Sibling/ }).click();
  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe("/environment/Sibling"),
  );
});

it("folds a row's children and opens them again", async () => {
  const { current, related } = seededFamily("Leaf");
  await using screen = await renderFamilyPanel(setupFamily(current, related));
  const folds = screen.getByRole("button", { name: /^Threads opened by / });
  // Each arrow names its own row, so a screen reader can tell them apart.
  await expect.element(screen.getByRole("button", { name: "Threads opened by Root" })).toBeVisible();
  // Root and Middle: the leaf and the sibling have no arrow, and every ancestor starts open.
  expect(folds.elements()).toHaveLength(2);
  for (const fold of folds.elements()) expect(fold.getAttribute("aria-expanded")).toBe("true");

  await folds.nth(1).click();
  await expect.element(screen.getByText("Leaf", { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByText("Sibling", { exact: true })).toBeVisible();
  await expect.element(folds.nth(1)).toHaveAttribute("aria-expanded", "false");

  await folds.nth(1).click();
  await expect.element(screen.getByText("Leaf", { exact: true })).toBeVisible();
  await expect.element(folds.nth(1)).toHaveAttribute("aria-expanded", "true");
});

it("keeps a fold for the session but opens the path to the thread on screen", async () => {
  const panel = (threadId: ThreadId) => (
    <ThreadRelationshipsPanel
      environmentId={environmentId}
      threadId={threadId}
      showLineage
      showSideChats
    />
  );
  // Both views share one thread id per title, as they do in the app.
  const shells = {
    root: familyShell("root", "Root"),
    a: familyShell("a", "A", { openedByThreadId: "root" }),
    b: familyShell("b", "B", { openedByThreadId: "root" }),
    aChild: familyShell("a-child", "A child", { openedByThreadId: "a" }),
    bChild: familyShell("b-child", "B child", { openedByThreadId: "b" }),
  };
  const show = (current: { id: ThreadId }) => {
    const projection = makeThreadProjectionFixture();
    state.projection = { ...projection, thread: current };
    state.relatedShells = Object.values(shells).filter((shell) => shell.id !== current.id);
  };
  setup();
  show(shells.aChild);
  await using screen = await render(panel(shells.aChild.id), { router: "/environment/a-child" });
  const fold = (title: string) =>
    familyRow(title).querySelector<HTMLElement>(`button[aria-label="Threads opened by ${title}"]`)!;

  fold("B").click();
  await expect.element(screen.getByText("B child", { exact: true })).not.toBeInTheDocument();
  fold("Root").click();
  await expect.element(screen.getByText("A child", { exact: true })).not.toBeInTheDocument();

  show(shells.b);
  await screen.rerender(panel(shells.b.id));
  // Root is on the way to B, so it opens; B itself was folded and is not its own ancestor.
  await expect.element(screen.getByText("A child", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("B child", { exact: true })).not.toBeInTheDocument();

  show(shells.aChild);
  await screen.rerender(panel(shells.aChild.id));
  await expect.element(screen.getByText("A", { exact: true })).not.toBeInTheDocument();
  fold("Root").click();
  await expect.element(screen.getByText("A child", { exact: true })).toBeVisible();
});

it("folds settled children per parent, but never the current thread or a live branch", async () => {
  const fixtureId = makeThreadProjectionFixture().thread.id;
  const id = setupFamily(
    { title: "Current", openedByThreadId: ThreadId.make("root"), ...settled },
    [
      familyShell("root", "Root"),
      familyShell("settled-sibling", "Settled sibling", { openedByThreadId: "root", ...settled }),
      familyShell("settled-parent", "Settled parent", { openedByThreadId: "root", ...settled }),
      familyShell("live-grandchild", "Live grandchild", {
        openedByThreadId: "settled-parent",
        ...running,
      }),
      familyShell("settled-child", "Settled child", { openedByThreadId: fixtureId, ...settled }),
    ],
  );
  await using screen = await renderFamilyPanel(id);

  for (const title of ["Current", "Settled parent", "Live grandchild"]) {
    await expect.element(screen.getByText(title, { exact: true })).toBeVisible();
  }
  await expect.element(screen.getByText("Settled sibling")).not.toBeInTheDocument();
  await expect.element(screen.getByText("Settled child")).not.toBeInTheDocument();

  const folds = screen.getByRole("button", { name: "Settled (1)" });
  expect(folds.elements()).toHaveLength(2);
  await folds.last().click();
  await expect.element(screen.getByText("Settled sibling")).toBeVisible();
  await expect.element(screen.getByText("Settled child")).not.toBeInTheDocument();
});

it("marks a row from another project with that project's icon", async () => {
  const fixture = makeThreadProjectionFixture();
  const id = setupFamily({ openedByThreadId: ThreadId.make("elsewhere") }, [
    familyShell("elsewhere", "Elsewhere", { projectId: "other-project" }),
    familyShell("here", "Here", { openedByThreadId: fixture.thread.id }),
  ]);
  state.projects = [
    {
      id: "other-project",
      environmentId,
      workspaceRoot: "/other",
      title: "Other project",
      faviconPath: null,
      projectIcon: { kind: "monogram", text: "OP", color: "blue" },
    },
  ];
  await using _screen = await renderFamilyPanel(id);

  await expect.element(page.getByText("Elsewhere", { exact: true })).toBeVisible();
  expect(familyRow("Elsewhere").querySelector("svg text")?.textContent).toBe("OP");
  expect(familyRow("Here").querySelector("svg text")).toBeNull();
});

it("truncates a deep row's long title inside a phone-width panel", async () => {
  const longTitle = "A thread at the bottom of the family with a title far too long for its row";
  const fixtureId = makeThreadProjectionFixture().thread.id;
  const ids = Array.from({ length: 8 }, (_, index) => `level-${index}`);
  const id = setupFamily(
    { title: longTitle, openedByThreadId: ThreadId.make(ids.at(-1)!) },
    ids.map((level, index) =>
      familyShell(level, level, index === 0 ? {} : { openedByThreadId: ids[index - 1] }),
    ),
  );
  expect(id).toBe(fixtureId);
  await using _screen = await render(
    <div style={{ width: 320 }}>
      <ThreadRelationshipsPanel
        environmentId={environmentId}
        threadId={id}
        showLineage
        showSideChats
      />
    </div>,
    { router: "/environment/current" },
  );

  const label = page.getByText(longTitle, { exact: true });
  await expect.element(label).toBeVisible();
  const element = label.element();
  expect(element.scrollWidth).toBeGreaterThan(element.clientWidth);
  expect(element.clientWidth).toBeGreaterThan(0);
  const section = element.closest("section")!;
  expect(section.scrollWidth).toBeLessThanOrEqual(section.clientWidth);
  expect(element.getBoundingClientRect().right).toBeLessThanOrEqual(
    section.getBoundingClientRect().right,
  );
});

it("counts what is past the depth cap without a link", async () => {
  const fixtureId = makeThreadProjectionFixture().thread.id;
  const levels = Array.from({ length: 11 }, (_, index) => `level-${index}`);
  const id = setupFamily(
    { title: "Top" },
    levels.map((level, index) =>
      familyShell(level, level, { openedByThreadId: index === 0 ? fixtureId : levels[index - 1] }),
    ),
  );
  await using screen = await renderFamilyPanel(id);

  await expect.element(screen.getByText("level-7", { exact: true })).toBeVisible();
  await expect.element(screen.getByText("level-8", { exact: true })).not.toBeInTheDocument();
  const count = screen.getByText("+3 deeper", { exact: true });
  await expect.element(count).toBeVisible();
  expect(count.element().closest("a, button")).toBeNull();
});

it("keeps a delegate_task worker on its agent row and its children in the tree", async () => {
  const fixture = makeThreadProjectionFixture();
  const fixtureId = fixture.thread.id;
  const id = setupFamily({ title: "Captain" }, [
    familyShell("worker", "Worker", {
      openedByThreadId: fixtureId,
      lineage: {
        rootThreadId: fixtureId,
        parentThreadId: fixtureId,
        relationshipToParent: "subagent",
      },
      ...running,
    }),
    familyShell("mate", "Mate", { openedByThreadId: "worker" }),
  ]);
  state.projection = {
    ...fixture,
    thread: (state.projection as typeof fixture).thread,
    subagents: [
      {
        id: NodeId.make("worker-agent"),
        threadId: id,
        runId: null,
        parentNodeId: NodeId.make("parent"),
        origin: "app_owned",
        createdBy: "agent",
        driver: "codex",
        providerInstanceId: fixture.thread.providerInstanceId,
        providerThreadId: null,
        childThreadId: ThreadId.make("worker"),
        nativeTaskRef: null,
        prompt: "Work",
        title: "Worker",
        model: null,
        status: "running",
        result: null,
        startedAt: null,
        completedAt: null,
        updatedAt: fixture.thread.updatedAt,
      },
    ],
  };
  await using screen = await renderFamilyPanel(id);

  await expect.element(screen.getByText("agent", { exact: true })).toBeVisible();
  expect(screen.getByRole("button", { name: /Worker/ }).elements()).toHaveLength(1);
  expect(familyRows().map((title) => title?.replace(/Done$/, ""))).toEqual(["Captain", "Mate"]);
});

it("adds no family section for a worker or a fork tied only to its parent's row", async () => {
  const parentId = ThreadId.make("parent");
  const id = setupFamily(
    {
      openedByThreadId: parentId,
      lineage: { rootThreadId: parentId, parentThreadId: parentId, relationshipToParent: "fork" },
    },
    [familyShell("parent", "Parent")],
  );
  await using screen = await renderFamilyPanel(id);

  await expect.element(heading("Lineage")).toBeVisible();
  expect(screen.getByRole("button", { name: /^Parent/ }).elements()).toHaveLength(1);
  await expect.element(heading("Family")).not.toBeInTheDocument();
});

it("leaves a hidden thread out of the tree and keeps what it opened", async () => {
  const id = setupFamily({ title: "Current", openedByThreadId: ThreadId.make("hidden") }, [
    familyShell("hidden", "Hidden opener", { openedByThreadId: "root" }),
    familyShell("root", "Root"),
  ]);
  state.hiddenKeys = new Set([threadKey({ environmentId, threadId: ThreadId.make("hidden") })]);
  await using _screen = await renderFamilyPanel(id);

  await expect.element(heading("Family")).toBeVisible();
  await expect.element(page.getByText("Hidden opener")).not.toBeInTheDocument();
  expect(familyRows().map((title) => title?.replace(/Done$/, ""))).toEqual(["Root", "Current"]);
});

it("scrolls a long family inside its own area, leaving the next section in reach", async () => {
  const fixtureId = makeThreadProjectionFixture().thread.id;
  const group = { tags: ["group:fleet"] };
  const id = setupFamily({ title: "Captain", ...group }, [
    ...Array.from({ length: 60 }, (_, index) =>
      familyShell(`mate-${index}`, `Mate ${index}`, { openedByThreadId: fixtureId }),
    ),
    familyShell("member", "Group member", group),
  ]);
  await using screen = await renderFamilyPanel(id);

  const family = screen.getByRole("group", { name: "Thread family" }).element();
  expect(familyRows()).toHaveLength(61);
  expect(family.scrollHeight).toBeGreaterThan(family.clientHeight);
  const groupHeading = heading("Group: fleet").element();
  expect(groupHeading.getBoundingClientRect().top).toBeLessThanOrEqual(
    family.getBoundingClientRect().bottom + 16,
  );
});
