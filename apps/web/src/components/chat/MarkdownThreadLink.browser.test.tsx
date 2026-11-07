import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import { render } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { MarkdownThreadLink } from "./MarkdownThreadLink";

const environmentId = EnvironmentId.make("env-draft");
const threadId = ThreadId.make("thread-reserved");
const draftId = DraftId.make("draft-reserved");
const link = { environmentId, threadId };

const thread = vi.hoisted(() => ({ started: false }));
// The draft's thread starts when its shell arrives; until then the real hook finds none.
vi.mock(import("../../state/entities"), async (original) => {
  const actual = await original();
  const useThreadShell: typeof actual.useThreadShell = (ref) => {
    const shell = actual.useThreadShell(ref);
    return thread.started && ref?.threadId === "thread-reserved"
      ? ({
          id: ref.threadId,
          environmentId: ref.environmentId,
          projectId: ProjectId.make("project"),
          title: "Login form, fixed",
        } as NonNullable<typeof shell>)
      : shell;
  };
  return { ...actual, useThreadShell };
});

function clearDrafts() {
  thread.started = false;
  useComposerDraftStore.setState({
    draftsByThreadKey: {},
    draftThreadsByThreadKey: {},
    logicalProjectDraftThreadKeyByLogicalProjectKey: {},
  });
}

it("opens the draft that holds the id, until its thread starts", async () => {
  clearDrafts();
  useComposerDraftStore
    .getState()
    .setLogicalProjectDraftThreadId(
      "logical-project",
      scopeProjectRef(environmentId, ProjectId.make("project")),
      draftId,
      { threadId },
    );

  await using screen = await render(
    <MarkdownThreadLink environmentId={environmentId} link={link} label={null} />,
  );

  const chip = screen.getByRole("link", { name: "Thread, New thread" });
  await expect.element(chip).toHaveAttribute("href", `/draft/${draftId}`);
});

it("names a draft by its first message's title, and the thread by its own once it starts", async () => {
  clearDrafts();
  const store = useComposerDraftStore.getState();
  store.setLogicalProjectDraftThreadId(
    "logical-project",
    scopeProjectRef(environmentId, ProjectId.make("project")),
    draftId,
    { threadId },
  );
  store.setPrompt(draftId, "Fix the login form");

  await using screen = await render(
    <MarkdownThreadLink environmentId={environmentId} link={link} label="New thread" />,
  );
  await expect
    .element(screen.getByRole("link", { name: "Thread, Fix the login form" }))
    .toHaveAttribute("href", `/draft/${draftId}`);

  // The draft lingers while its send settles; the thread's own title wins from the start.
  thread.started = true;
  await screen.rerender(
    <MarkdownThreadLink environmentId={environmentId} link={link} label="New thread" />,
  );
  await expect
    .element(screen.getByRole("link", { name: "Thread, Login form, fixed" }))
    .toHaveAttribute("href", `/${environmentId}/${threadId}`);
});

it("says an id no draft here holds has not started or was deleted", async () => {
  clearDrafts();
  await using screen = await render(
    <MarkdownThreadLink environmentId={environmentId} link={link} label={null} />,
  );

  await expect
    .element(screen.getByLabelText("Unavailable context, Thread not started or deleted"))
    .toBeVisible();
  expect(screen.getByRole("link").elements()).toHaveLength(0);
});
