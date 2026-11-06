import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "vite-plus/test";

import { render } from "../../../test/render";
import { DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { MarkdownThreadLink } from "./MarkdownThreadLink";

const environmentId = EnvironmentId.make("env-draft");
const threadId = ThreadId.make("thread-reserved");
const draftId = DraftId.make("draft-reserved");
const link = { environmentId, threadId };

function clearDrafts() {
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
