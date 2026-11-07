import { createMemoryHistory } from "@tanstack/react-router";
import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";
import type * as Context from "effect/Context";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { AppRoot } from "~/AppRoot";
// The route loads ChatView lazily, and its first transform (React Compiler over ~4k lines)
// takes 6-11s; importing it here keeps that out of the test's timeout.
import "~/components/ChatView";
import { openCommandPalette } from "~/commandPaletteBus";
import { DraftId, useComposerDraftStore } from "~/composerDraftStore";
import { __setClientSettingsForTests } from "~/hooks/useSettings";
import { getRouter } from "~/router";
import {
  ENVIRONMENT_ID,
  PROJECT_ID,
  emitThreadEvent,
  installFakeEnvironment,
  runningRun,
  serveScheduledTasks,
  threadWithHistory,
  type FakeDriver,
} from "../../test/fakeEnvironment";
import { act, render } from "../../test/render";

// The socket is the only fake layer; see test/appScenarios.renders.tsx.
vi.mock("../../../../packages/client-runtime/src/connection/driver.ts", async (importOriginal) => {
  const [actual, { fakeDriver }, Layer] = await Promise.all([
    importOriginal<{ readonly ConnectionDriver: Context.Key<unknown, FakeDriver> }>(),
    import("../../test/fakeEnvironment"),
    import("effect/Layer"),
  ]);
  return { ...actual, layer: Layer.succeed(actual.ConnectionDriver, fakeDriver) };
});

vi.mock(import("~/rpc/requestLatencyState"), async (original) => ({
  ...(await original()),
  trackRpcRequestSent: () => {},
}));

it("a new draft does not load its reserved thread before the server lists it", async () => {
  using _environment = installFakeEnvironment([]);
  using fetchSpy = vi.spyOn(globalThis, "fetch");
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const draftId = DraftId.make("draft-27443");
  const threadId = ThreadId.make("thread-27443");
  useComposerDraftStore
    .getState()
    .setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, { threadId });

  const router = getRouter(createMemoryHistory({ initialEntries: [`/draft/${draftId}`] }));
  await router.load();
  await using _app = await render(<AppRoot router={router} />, {
    // AppRoot brings its own router.
    router: false,
  });
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  // The shell snapshot has arrived once the sidebar lists the project, so the connection is up.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();

  const threadRequests = fetchSpy.mock.calls
    .map(([input]) => String(input instanceof Request ? input.url : input))
    .filter((url) => url.includes(`/api/orchestration/threads/${threadId}/`));
  // A 404 here marks the thread deleted, and the view never loads it once the send creates it.
  expect(threadRequests).toEqual([]);
});

async function mountAt(path: string) {
  // Desktop-sized, so the whole task form fits and its footer can be clicked.
  await page.viewport(1400, 900);
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    onboardingCompletedAt: "2026-01-01T00:00:00.000Z",
  });
  const router = getRouter(createMemoryHistory({ initialEntries: [path] }));
  await router.load();
  // AppRoot brings its own router.
  const screen = await render(<AppRoot router={router} />, { router: false });
  await expect.element(page.getByTestId("composer-editor")).toBeVisible();
  // The shell snapshot has arrived once the sidebar lists the project, so the connection is up.
  await expect.element(page.getByText("render", { exact: true }).first()).toBeVisible();
  return screen;
}

const sendOnEvent = () => page.getByRole("button", { name: "Send on an event" });

it("schedules a new thread's message from the composer, and keeps it on a cancel", async () => {
  using _environment = installFakeEnvironment([]);
  using tasks = serveScheduledTasks();
  const draftId = DraftId.make("draft-send-on-event");
  const threadId = ThreadId.make("thread-send-on-event");
  const drafts = useComposerDraftStore.getState();
  drafts.setProjectDraftThreadId(scopeProjectRef(ENVIRONMENT_ID, PROJECT_ID), draftId, {
    threadId,
  });
  await using _app = await mountAt(`/draft/${draftId}`);
  const prompt = () => useComposerDraftStore.getState().getComposerDraft(draftId)?.prompt ?? "";

  await expect.element(sendOnEvent()).not.toBeInTheDocument();
  await userEvent.type(page.getByTestId("composer-editor"), "Check the nightly build");
  await expect.element(sendOnEvent()).toBeEnabled();

  // A task holds a prompt and nothing else.
  const terminal = {
    id: "terminal-context",
    threadId,
    createdAt: "2026-03-17T19:12:28.000Z",
    terminalId: "default",
    terminalLabel: "Terminal 1",
    lineStart: 1,
    lineEnd: 1,
    text: "npm test",
  };
  await act(() => drafts.setTerminalContexts(draftId, [terminal]));
  await expect.element(sendOnEvent()).toBeDisabled();
  await act(() => drafts.setTerminalContexts(draftId, []));
  await expect.element(sendOnEvent()).toBeEnabled();
  const written = prompt();

  await sendOnEvent().click();
  const dialog = page.getByRole("dialog");
  await expect
    .element(dialog.getByRole("textbox", { name: "Prompt" }))
    .toHaveValue("Check the nightly build");
  await expect
    .element(dialog.getByRole("textbox", { name: "Name" }))
    .toHaveValue("Check the nightly build");
  await expect
    .element(dialog.getByRole("button", { name: "On usage" }))
    .toHaveAttribute("aria-pressed", "true");
  await expect
    .element(dialog.getByText("Each run starts a new thread", { exact: false }))
    .toBeVisible();
  // This provider reports no usage, so the form refuses to save and stays open.
  await dialog.getByRole("button", { name: "Create task" }).click();
  await expect.element(page.getByText("Pick a usage window")).toBeVisible();
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect.element(dialog).not.toBeInTheDocument();
  expect(tasks.saved).toEqual([]);
  expect(prompt()).toBe(written);

  // The command palette offers the same, for what the composer holds.
  await act(() => openCommandPalette({ query: "Send on an event" }));
  await page.getByRole("option", { name: /Send on an event/ }).click();
  await page.getByRole("button", { name: "Every interval" }).click();
  await page.getByRole("button", { name: "Create task" }).click();
  await vi.waitFor(() => expect(tasks.saved).toHaveLength(1));
  expect(tasks.saved[0]).toMatchObject({
    title: "Check the nightly build",
    prompt: "Check the nightly build",
    schedule: { type: "interval", everyMs: 15 * 60_000 },
    projectId: PROJECT_ID,
    threadId: null,
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  });
  expect(tasks.saved[0]?.schedule).not.toHaveProperty("deliverAs");
  await expect.element(page.getByText("Scheduled", { exact: true })).toBeVisible();
  await vi.waitFor(() => expect(prompt()).toBe(""));
  // The draft stays a draft.
  expect(useComposerDraftStore.getState().getDraftSession(draftId)).not.toBeNull();
  await expect.element(sendOnEvent()).not.toBeInTheDocument();
});

it("schedules into a thread on a model its provider no longer lists when nothing was picked", async () => {
  const thread = { ...threadWithHistory("thread-retired-model", 1), model: "gpt-5.2" };
  using _environment = installFakeEnvironment([thread]);
  using tasks = serveScheduledTasks();
  await using _app = await mountAt(`/${ENVIRONMENT_ID}/${thread.id}`);

  await userEvent.type(page.getByTestId("composer-editor"), "Continue after the reset");
  await expect.element(sendOnEvent()).toBeEnabled();
  await sendOnEvent().click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("button", { name: "Every interval" }).click();
  await dialog.getByRole("button", { name: "Create task" }).click();
  await vi.waitFor(() => expect(tasks.saved).toHaveLength(1));
  expect(tasks.saved[0]).toMatchObject({
    threadId: thread.id,
    modelSelection: { instanceId: "codex", model: "gpt-5.2" },
  });
});

it("schedules into a stopped thread on its own model, steering it if it runs, and offers nothing while it runs", async () => {
  const thread = threadWithHistory("thread-scheduled", 1);
  using _environment = installFakeEnvironment([thread]);
  using tasks = serveScheduledTasks();
  await using _app = await mountAt(`/${ENVIRONMENT_ID}/${thread.id}`);
  const chord = "{Control>}{Alt>}{Shift>}{Enter}{/Shift}{/Alt}{/Control}";

  await userEvent.type(page.getByTestId("composer-editor"), "Continue after the reset");
  // A bound task runs on the thread's model, which a pick here moves only with a send.
  const threadRef = scopeThreadRef(ENVIRONMENT_ID, thread.id);
  const pick = (model: string) =>
    act(() =>
      useComposerDraftStore
        .getState()
        .setModelSelection(
          threadRef,
          { instanceId: ProviderInstanceId.make("codex"), model },
          { explicit: true },
        ),
    );
  await pick("gpt-5.5");
  await expect.element(sendOnEvent()).toBeDisabled();
  await userEvent.keyboard(chord);
  await expect
    .element(
      page.getByText(
        "Scheduled messages run on the thread's model. Send once to move it, then schedule.",
      ),
    )
    .toBeVisible();
  await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
  await pick("gpt-5.4");
  await expect.element(sendOnEvent()).toBeEnabled();

  await userEvent.keyboard(chord);
  const dialog = page.getByRole("dialog");
  await expect.element(dialog.getByText(thread.title)).toBeVisible();
  // The chord opened the form and sent nothing.
  await expect
    .element(page.getByTestId("composer-editor"))
    .toHaveTextContent("Continue after the reset");
  await dialog.getByLabelText("If the thread is running when this fires").click();
  await page.getByRole("option", { name: "Steer the turn" }).click();
  await dialog.getByRole("button", { name: "Every interval" }).click();
  await dialog.getByRole("button", { name: "Create task" }).click();
  await vi.waitFor(() => expect(tasks.saved).toHaveLength(1));
  expect(tasks.saved[0]).toMatchObject({
    prompt: "Continue after the reset",
    threadId: thread.id,
    schedule: { type: "interval", deliverAs: "steer" },
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
  });
  await vi.waitFor(() => expect(page.getByTestId("composer-editor")).toHaveTextContent(""));

  const live = runningRun(thread.id, "thread-scheduled-live", 2, "thread-scheduled-user-1");
  await act(() => emitThreadEvent(thread.id, { type: "run.created", payload: live }));
  await userEvent.type(page.getByTestId("composer-editor"), "And then this");
  await expect
    .element(page.getByRole("button", { name: /Steer message|Queue message/ }))
    .toBeVisible();
  await expect.element(sendOnEvent()).not.toBeInTheDocument();
});
