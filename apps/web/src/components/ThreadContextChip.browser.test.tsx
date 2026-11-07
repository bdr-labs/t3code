import { scopedThreadKey } from "@t3tools/client-runtime/environment";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { useRef } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../test/render";
import { AppAtomRegistryProvider, appAtomRegistry } from "../rpc/atomRegistry";
import {
  activeThreadReferencesAtom,
  threadReferenceHighlight,
  useThreadReferenceSession,
} from "../threadReferenceHighlight";
import { SidebarReferenceHighlightBar } from "./sidebar/SidebarReferenceHighlightBar";
import { ThreadContextChip } from "./ThreadContextChip";
import { SidebarProvider } from "./ui/sidebar";

const environmentId = EnvironmentId.make("env-chip");
const target = { environmentId, threadId: ThreadId.make("thread-target") };
const sessionKey = scopedThreadKey({ environmentId, threadId: ThreadId.make("thread-session") });
const chipName = "Thread, Referenced";

function setup() {
  appAtomRegistry.set(activeThreadReferencesAtom, {
    hovered: null,
    sessionKey,
    pinnedBySession: new Map(),
  });
}
const state = () => appAtomRegistry.get(activeThreadReferencesAtom);
const pins = () => state().pinnedBySession.get(sessionKey) ?? [];

async function viewport(width: number) {
  const before = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(width, 800);
  return { [Symbol.asyncDispose]: () => page.viewport(before.width, before.height) };
}

const chip = (
  <AppAtomRegistryProvider>
    <button type="button">Before</button>
    <ThreadContextChip record={{ ...target, title: "Referenced" }} />
    <button type="button">After</button>
  </AppAtomRegistryProvider>
);

it("pins on click without navigating, drops the hover on leave, and unpins on a second click", async () => {
  setup();
  await using _viewport = await viewport(1280);
  await using screen = await render(chip);
  const link = screen.getByRole("link", { name: chipName });

  await userEvent.click(link);
  expect(document.activeElement).toBe(link.element());
  expect(pins()).toEqual([target]);
  expect(state().hovered).toEqual(target);

  // The click left focus in the chip; leaving must still end the hover.
  await userEvent.unhover(link);
  expect(state().hovered).toBeNull();
  expect(pins()).toEqual([target]);
  await expect.element(link).toHaveAttribute("data-reference-highlight", "target");
  expect(screen.router?.state.location.pathname).toBe("/");

  await userEvent.click(link);
  expect(pins()).toEqual([]);
  expect(screen.router?.state.location.pathname).toBe("/");
});

it("opens on mod-click and pins nothing", async () => {
  setup();
  await using _viewport = await viewport(1280);
  await using screen = await render(chip);

  await userEvent.click(screen.getByRole("link", { name: chipName }), {
    modifiers: ["ControlOrMeta"],
  });

  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe(`/${environmentId}/${target.threadId}`),
  );
  expect(pins()).toEqual([]);
});

it("highlights while keyboard focus rests on the chip, and Enter toggles the pin", async () => {
  setup();
  await using _viewport = await viewport(1280);
  await using screen = await render(chip);
  screen.getByRole("button", { name: "Before" }).element().focus();

  await userEvent.tab();
  expect(state().hovered).toEqual(target);
  await userEvent.keyboard("{Enter}");
  expect(pins()).toEqual([target]);
  await userEvent.keyboard("{Enter}");
  expect(pins()).toEqual([]);

  await userEvent.tab();
  expect(state().hovered).toBeNull();
});

it("opens on a phone-width tap and pins nothing", async () => {
  setup();
  await using _viewport = await viewport(390);
  await using screen = await render(chip);

  await userEvent.click(screen.getByRole("link", { name: chipName }));

  await vi.waitFor(() =>
    expect(screen.router?.state.location.pathname).toBe(`/${environmentId}/${target.threadId}`),
  );
  expect(pins()).toEqual([]);
});

it("publishes the session only while its writer is mounted", async () => {
  setup();
  function Writer(props: { readonly sessionKey: string | null }) {
    useThreadReferenceSession(props.sessionKey);
    return null;
  }
  const other = scopedThreadKey({ environmentId, threadId: ThreadId.make("thread-other") });
  await using screen = await render(<Writer sessionKey={other} />);
  expect(state().sessionKey).toBe(other);
  await screen.rerender(<Writer sessionKey={null} />);
  expect(state().sessionKey).toBeNull();
  await screen.rerender(<Writer sessionKey={sessionKey} />);
  await screen.unmount();
  expect(state().sessionKey).toBeNull();
});

function Bar() {
  const searchInputRef = useRef<HTMLInputElement>(null);
  return (
    <AppAtomRegistryProvider>
      <SidebarProvider>
        <input ref={searchInputRef} aria-label="Search" />
        <SidebarReferenceHighlightBar searchInputRef={searchInputRef} />
      </SidebarProvider>
    </AppAtomRegistryProvider>
  );
}

it("removes a pin from the sidebar bar, whose own hover highlights nothing", async () => {
  setup();
  threadReferenceHighlight.togglePinned(target);
  await using _viewport = await viewport(1280);
  await using screen = await render(<Bar />);

  await userEvent.hover(screen.getByRole("link", { name: /^Open / }));
  expect(state().hovered).toBeNull();
  await userEvent.click(screen.getByRole("button", { name: /^Remove .* highlight$/ }));
  expect(pins()).toEqual([]);
  await expect
    .element(screen.getByRole("group", { name: "Highlighted thread references" }))
    .not.toBeInTheDocument();
});
