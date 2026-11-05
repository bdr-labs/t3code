import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { DraftId } from "../../composerDraftStore";
import { ComposerCommandMenu, type ComposerCommandItem } from "./ComposerCommandMenu";
import { composerCommandKeyHandler } from "./composerCommandKey";
import { resolveComposerMenuActiveItemId } from "./composerMenuHighlight";

const compactItem = {
  id: "compact",
  type: "provider-slash-command",
  provider: "claudeAgent",
  command: { name: "compact", description: "Compact the conversation" },
  label: "/compact",
  description: "Compact the conversation",
  disabledReason: "Wait for the current turn to finish.",
} as ComposerCommandItem;

const reviewItem = {
  id: "review",
  type: "provider-slash-command",
  provider: "claudeAgent",
  command: { name: "review", description: "Review the changes" },
  label: "/review",
  description: "Review the changes",
} as ComposerCommandItem;

/** The real key handler and menu, wired the way ChatComposer wires them. */
function Composer(props: {
  items: ComposerCommandItem[];
  onSelect: (item: ComposerCommandItem) => void;
  onSubmit: () => void;
  prompt?: string;
}) {
  const prompt = props.prompt ?? "/comp";
  const [highlighted, setHighlighted] = useState<string | null>(null);
  const activeId = resolveComposerMenuActiveItemId({
    items: props.items,
    highlightedItemId: highlighted,
    currentSearchKey: "slash",
    highlightedSearchKey: "slash",
  });
  const onKey = composerCommandKeyHandler({
    keybindings: [],
    sendShortcut: "enter",
    routeKind: "server",
    phase: "running",
    isCompacting: false,
    followUpBehavior: "queue",
    isSoftwareKeyboardOpen: false,
    planModeUiEnabled: false,
    isLiteralPendingAnswer: false,
    pendingUserInputs: [],
    promptHistoryEntries: [],
    promptHistoryPositionRef: { current: null },
    composerDraftTarget: DraftId.make("draft"),
    promptRef: { current: prompt },
    composerImagesRef: { current: [] },
    composerFilesRef: { current: [] },
    composerTerminalContextsRef: { current: [] },
    composerPreviewAnnotations: [],
    composerReviewComments: [],
    composerEditorRef: { current: null },
    composerMenuOpenRef: { current: true },
    composerMenuItemsRef: { current: props.items },
    activeComposerMenuItemRef: {
      current: props.items.find((item) => item.id === activeId) ?? null,
    },
    setComposerDraftPrompt: () => {},
    setComposerCursor: () => {},
    setComposerTrigger: () => {},
    setComposerHighlightedItemId: setHighlighted,
    dismissComposerTrigger: () => {},
    toggleInteractionMode: () => {},
    nudgeComposerMenuHighlight: (key) => {
      const index = props.items.findIndex((item) => item.id === highlighted);
      const start = index >= 0 ? index : key === "ArrowDown" ? -1 : 0;
      const next = start + (key === "ArrowDown" ? 1 : -1) + props.items.length;
      setHighlighted(props.items[next % props.items.length]?.id ?? null);
    },
    onSelectComposerItem: props.onSelect,
    resolveActiveComposerTrigger: () => ({ trigger: null }),
    readComposerSnapshot: () => ({ value: prompt }),
    applyPromptReplacement: () => false,
    submitComposer: props.onSubmit,
  });
  return (
    <>
      <textarea
        aria-label="Message"
        onKeyDown={(event) => {
          if (onKey(event.key, event.nativeEvent)) event.preventDefault();
        }}
      />
      <ComposerCommandMenu
        listId="menu"
        items={props.items}
        resolvedTheme="light"
        isLoading={false}
        triggerKind="slash-command"
        activeItemId={activeId}
        onHighlightedItemChange={setHighlighted}
        onSelect={props.onSelect}
      />
    </>
  );
}

const option = (name: RegExp) => page.getByRole("option", { name });

it("shows a disabled entry with its reason, and Enter, Tab and a click do nothing", async () => {
  const onSelect = vi.fn();
  const onSubmit = vi.fn();
  await using _screen = await render(
    <Composer items={[compactItem]} onSelect={onSelect} onSubmit={onSubmit} />,
  );
  const compact = option(/\/compact/);

  await expect.element(compact).toHaveAttribute("aria-disabled", "true");
  await expect.element(compact).toHaveAttribute("aria-selected", "true");
  await expect.element(compact.getByText("Wait for the current turn to finish.")).toBeVisible();
  await expect.element(page.getByText("Compact the conversation")).not.toBeInTheDocument();

  await userEvent.click(page.getByRole("textbox", { name: "Message" }));
  await userEvent.keyboard("{Enter}");
  await userEvent.keyboard("{Tab}");
  // Playwright refuses an aria-disabled target unless forced; a real pointer is not refused.
  await userEvent.click(compact, { force: true });

  expect(onSelect).not.toHaveBeenCalled();
  expect(onSubmit).not.toHaveBeenCalled();
  await expect.element(compact).toBeVisible();
});

it.each(["/compact", "/compact  "])(
  "sends a typed %j on Enter, while Tab and a click on its entry do nothing",
  async (prompt) => {
    const onSelect = vi.fn();
    const onSubmit = vi.fn();
    await using _screen = await render(
      <Composer items={[compactItem]} onSelect={onSelect} onSubmit={onSubmit} prompt={prompt} />,
    );
    const textbox = page.getByRole("textbox", { name: "Message" });

    await userEvent.click(textbox);
    await userEvent.keyboard("{Tab}");
    await expect.element(textbox).toHaveFocus();
    await userEvent.click(option(/\/compact/), { force: true });
    expect(onSubmit).not.toHaveBeenCalled();

    await userEvent.click(textbox);
    await userEvent.keyboard("{Enter}");
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSelect).not.toHaveBeenCalled();
  },
);

it("lets the arrows reach a disabled entry and leave it", async () => {
  const onSelect = vi.fn();
  const onSubmit = vi.fn();
  await using _screen = await render(
    <Composer
      items={[compactItem, reviewItem]}
      onSelect={onSelect}
      onSubmit={onSubmit}
      prompt="/"
    />,
  );
  const compact = option(/\/compact/);
  const review = option(/\/review/);

  await expect.element(review).toHaveAttribute("aria-selected", "true");
  await expect.element(review).not.toHaveAttribute("aria-disabled");

  await userEvent.click(page.getByRole("textbox", { name: "Message" }));
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(compact).toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{Enter}");
  expect(onSelect).not.toHaveBeenCalled();
  expect(onSubmit).not.toHaveBeenCalled();

  await userEvent.keyboard("{ArrowDown}");
  await expect.element(review).toHaveAttribute("aria-selected", "true");
  await userEvent.keyboard("{Enter}");
  expect(onSelect).toHaveBeenCalledExactlyOnceWith(reviewItem);
  expect(onSubmit).not.toHaveBeenCalled();
});
