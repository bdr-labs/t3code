import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const persisted = vi.hoisted(() => ({ title: "" }));
vi.mock(import("../../state/session"), async (importOriginal) => ({
  ...(await importOriginal()),
  useEnvironmentScope: () => true,
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/use-orchestration-command"), async (importOriginal) => ({
  ...(await importOriginal()),
  useOrchestrationCommand: (() =>
    async ({ input }: { input: { title: string } }) => {
      persisted.title = input.title;
      return { _tag: "Success" };
    }) as never,
}));
vi.mock(import("~/hooks/useThreadActionMenu"), () => ({
  useThreadActionMenu: () => ({ openMenu: () => {}, closeMenu: () => {} }),
}));

import "~/index.css";

import { render } from "../../../test/render";
import { ChatHeader } from "./ChatHeader";

function header(title: string) {
  return (
    <>
      <ChatHeader
        activeThreadEnvironmentId={EnvironmentId.make("environment")}
        activeThreadId={ThreadId.make("thread")}
        activeThreadTitle={title}
        isServerThread
        activeProject={null}
        parentThreadLink={null}
        onOpenThread={() => {}}
        rightPanelOpen={false}
        onNewThreadInProject={() => {}}
      />
      <div tabIndex={0}>Outside rename</div>
    </>
  );
}

it.each(["blur", "Enter"] as const)(
  "preserves a concurrent title update when an untouched rename ends with %s",
  async (finish) => {
    persisted.title = "New thread";
    await using screen = await render(header(persisted.title));
    await screen.getByRole("button", { name: "Thread actions for New thread" }).dblClick();
    const input = screen.getByRole("textbox", { name: "Thread title" });
    await expect.element(input).toHaveValue("New thread");

    persisted.title = "Fix login redirect";
    await screen.rerender(header(persisted.title));
    if (finish === "Enter") await userEvent.keyboard("{Enter}");
    else await screen.getByText("Outside rename").click();

    await expect.element(input).not.toBeInTheDocument();
    expect(persisted.title).toBe("Fix login redirect");

    await screen.rerender(header(persisted.title));
    await screen.getByRole("button", { name: "Thread actions for Fix login redirect" }).dblClick();
    await screen.getByRole("textbox", { name: "Thread title" }).fill("My edited title");
    persisted.title = "Another concurrent title";
    await screen.rerender(header(persisted.title));
    await userEvent.keyboard("{Enter}");
    await expect
      .element(screen.getByRole("textbox", { name: "Thread title" }))
      .not.toBeInTheDocument();
    expect(persisted.title).toBe("My edited title");
  },
);

function draftHeader(onCopyDraftReference: () => void) {
  return (
    <ChatHeader
      activeThreadEnvironmentId={EnvironmentId.make("environment")}
      activeThreadId={ThreadId.make("c8e23066-11e7-4f14-b25e-96e6fb58af44")}
      activeThreadTitle="New thread"
      isServerThread={false}
      activeProject={null}
      parentThreadLink={null}
      onOpenThread={() => {}}
      rightPanelOpen={false}
      onNewThreadInProject={() => {}}
      onCopyDraftReference={onCopyDraftReference}
    />
  );
}

async function viewport(width: number, height: number) {
  const before = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(width, height);
  return { [Symbol.asyncDispose]: () => page.viewport(before.width, before.height) };
}

const REFERENCE_NAME = "Copy thread c8e23066-11e7-4f14-b25e-96e6fb58af44";

it("shows a draft's reserved thread id and copies a reference to it", async () => {
  await using _viewport = await viewport(1280, 800);
  const onCopyDraftReference = vi.fn();
  await using screen = await render(draftHeader(onCopyDraftReference));

  const reference = screen.getByRole("button", { name: REFERENCE_NAME });
  await expect.element(reference).toHaveTextContent("c8e23066");
  await reference.click();
  expect(onCopyDraftReference).toHaveBeenCalledOnce();
});

it("leaves the room to the title at phone width", async () => {
  await using _viewport = await viewport(390, 844);
  await using screen = await render(draftHeader(() => {}));

  await expect.element(screen.getByRole("heading", { name: "New thread" })).toBeVisible();
  expect(screen.getByRole("button", { name: REFERENCE_NAME }).elements()).toHaveLength(0);
});

it("shows no reserved id once the thread has started", async () => {
  await using _viewport = await viewport(1280, 800);
  await using screen = await render(header("Started"));

  expect(screen.getByRole("button", { name: /^Copy thread / }).elements()).toHaveLength(0);
});
