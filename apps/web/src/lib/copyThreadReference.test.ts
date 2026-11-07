import { scopeProjectRef, scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ORCHESTRATION_V2_WS_METHODS,
  ProjectId,
  type ScopedProjectRef,
  ThreadId,
} from "@t3tools/contracts";
import {
  COMPOSER_CONTEXT_CLIPBOARD_MIME,
  decodeComposerContextFragment,
} from "@t3tools/shared/composerContextClipboard";
import { parseThreadLinkHref } from "@t3tools/shared/threadLinks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const clipboard = vi.hoisted(() => ({
  write: vi.fn<(value: string, target: string, extra?: Record<string, string>) => Promise<boolean>>(
    async () => true,
  ),
}));
const rpc = vi.hoisted(() => ({
  calls: [] as Array<{ tag: string; environmentId: string; input: Record<string, unknown> }>,
  outcome: { _tag: "Success", value: undefined } as { _tag: string; value?: unknown },
}));
vi.mock("../hooks/useCopyToClipboard", () => ({ writeTextToClipboard: clipboard.write }));
vi.mock("../components/ui/toast", () => ({
  stackedThreadToast: (toast: unknown) => toast,
  toastManager: { add: vi.fn() },
}));
vi.mock("../connection/runtime", () => ({ connectionAtomRuntime: {} }));
vi.mock("../rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("../state/entities", () => ({
  readProject: (ref: ScopedProjectRef) =>
    ref.projectId === "project" ? { title: "t3code" } : { title: "Scratch", isScratch: true },
}));
vi.mock("@t3tools/client-runtime/state/runtime", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@t3tools/client-runtime/state/runtime")>()),
  createEnvironmentRpcCommand: (_runtime: unknown, options: { tag: string }) => ({
    tag: options.tag,
  }),
  runAtomCommand: async (
    _registry: unknown,
    command: { tag: string },
    target: { environmentId: string; input: Record<string, unknown> },
  ) => {
    rpc.calls.push({ tag: command.tag, ...target });
    return rpc.outcome;
  },
}));

import { DraftId, useComposerDraftStore } from "../composerDraftStore";
import {
  copyDraftThreadReference,
  shareThreadReference,
  startDraftThreadReservations,
} from "./copyThreadReference";

const environmentId = EnvironmentId.make("env-draft");
const otherEnvironmentId = EnvironmentId.make("env-other");
const threadId = ThreadId.make("thread-reserved");
const draftId = DraftId.make("draft-reserved");
const { reserveDraftThread: RESERVE, releaseDraftThread: RELEASE } = ORCHESTRATION_V2_WS_METHODS;

function openDraft() {
  useComposerDraftStore
    .getState()
    .setLogicalProjectDraftThreadId(
      "logical-project",
      scopeProjectRef(environmentId, ProjectId.make("project")),
      draftId,
      { threadId, environmentSelection: "auto", loadBalancedEnvironmentId: null },
    );
}
const type = (prompt: string) => useComposerDraftStore.getState().setPrompt(draftId, prompt);
const reserveOf = (title: string, projectTitle: string | null = "t3code") => ({
  tag: RESERVE,
  environmentId,
  input: { threadId, title, projectTitle },
});

describe("copyDraftThreadReference", () => {
  let stopReservations: () => void;
  beforeEach(() => {
    clipboard.write.mockClear();
    rpc.calls.length = 0;
    rpc.outcome = { _tag: "Success", value: undefined };
    useComposerDraftStore.setState({
      draftsByThreadKey: {},
      draftThreadsByThreadKey: {},
      logicalProjectDraftThreadKeyByLogicalProjectKey: {},
    });
    openDraft();
    stopReservations = startDraftThreadReservations();
  });
  afterEach(() => {
    stopReservations();
    vi.useRealTimers();
  });

  it("copies a link and a chip that name the id the draft keeps", async () => {
    await copyDraftThreadReference(draftId);

    const [value, , extra] = clipboard.write.mock.calls[0]!;
    expect(parseThreadLinkHref(value)).toEqual({ environmentId, threadId });
    const fragment = decodeComposerContextFragment(extra![COMPOSER_CONTEXT_CLIPBOARD_MIME]!);
    expect(fragment?.records).toMatchObject([
      { kind: "thread", environmentId, threadId, title: "New thread" },
    ]);
    expect(useComposerDraftStore.getState().getDraftSession(draftId)?.threadId).toBe(threadId);
  });

  it("names the draft by the title its first message would give, and reserves it there", async () => {
    type("Fix the login form");

    await copyDraftThreadReference(draftId);

    const fragment = decodeComposerContextFragment(
      clipboard.write.mock.calls[0]![2]![COMPOSER_CONTEXT_CLIPBOARD_MIME]!,
    );
    expect(fragment?.records).toMatchObject([{ title: "Fix the login form" }]);
    expect(rpc.calls).toEqual([reserveOf("Fix the login form")]);
  });

  it("still copies when the reservation fails", async () => {
    rpc.outcome = { _tag: "Failure" };

    await copyDraftThreadReference(draftId);

    expect(rpc.calls).toEqual([reserveOf("New thread")]);
    expect(clipboard.write).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["a copy", () => copyDraftThreadReference(draftId)],
    ["an @ pick", () => shareThreadReference(scopeThreadRef(environmentId, threadId))],
  ])("stops automatic routing from moving the draft off the machine %s names", async (_, share) => {
    await share();

    expect(useComposerDraftStore.getState().getDraftSession(draftId)).toMatchObject({
      environmentId,
      environmentSelection: "manual",
      loadBalancedEnvironmentId: null,
    });
  });

  it("copies nothing for a draft already on its way to being a thread", async () => {
    useComposerDraftStore.getState().markDraftThreadPromoting(draftId);

    await copyDraftThreadReference(draftId);

    expect(clipboard.write).not.toHaveBeenCalled();
    expect(rpc.calls).toEqual([]);
  });

  it("sends nothing of a draft whose reference nobody has shared", () => {
    vi.useFakeTimers();
    type("Private thoughts");
    vi.advanceTimersByTime(10_000);
    useComposerDraftStore.getState().clearDraftThread(draftId);

    expect(rpc.calls).toEqual([]);
  });

  it("rewrites a shared draft's title at most every 2 seconds, with the latest", async () => {
    vi.useFakeTimers();
    await copyDraftThreadReference(draftId);
    rpc.calls.length = 0;

    for (const prompt of ["F", "Fi", "Fix", "Fix the", "Fix the form"]) type(prompt);
    vi.advanceTimersByTime(1_999);
    expect(rpc.calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(rpc.calls).toEqual([reserveOf("Fix the form")]);

    type("Fix the form now");
    vi.advanceTimersByTime(2_000);
    expect(rpc.calls).toEqual([reserveOf("Fix the form"), reserveOf("Fix the form now")]);
  });

  it("writes a draft shared before this page loaded back at its next title change", () => {
    stopReservations();
    useComposerDraftStore.getState().markDraftReferenceShared(draftId);
    stopReservations = startDraftThreadReservations();
    vi.useFakeTimers();

    expect(rpc.calls).toEqual([]);
    type("Picked up again");
    vi.advanceTimersByTime(2_000);
    expect(rpc.calls).toEqual([reserveOf("Picked up again")]);
  });

  it("releases a shared draft that is discarded", async () => {
    await copyDraftThreadReference(draftId);
    rpc.calls.length = 0;

    useComposerDraftStore.getState().clearDraftThread(draftId);

    expect(rpc.calls).toEqual([{ tag: RELEASE, environmentId, input: { threadId } }]);
  });

  it("keeps a starting draft's reservation until the draft is gone", async () => {
    await copyDraftThreadReference(draftId);
    rpc.calls.length = 0;

    useComposerDraftStore.getState().markDraftThreadPromoting(draftId);
    expect(rpc.calls).toEqual([]);
    useComposerDraftStore.getState().finalizePromotedDraftThread(draftId);
    expect(rpc.calls).toEqual([{ tag: RELEASE, environmentId, input: { threadId } }]);
  });

  it("tells only the draft's own machine, and releases it there when the draft moves", async () => {
    vi.useFakeTimers();
    await copyDraftThreadReference(draftId);
    rpc.calls.length = 0;

    useComposerDraftStore.getState().setDraftThreadContext(draftId, {
      projectRef: scopeProjectRef(otherEnvironmentId, ProjectId.make("project")),
    });
    type("Now elsewhere");
    vi.advanceTimersByTime(10_000);

    expect(rpc.calls).toEqual([{ tag: RELEASE, environmentId, input: { threadId } }]);
  });

  it("reserves a draft picked into a message from the @ menu", () => {
    type("Picked");

    shareThreadReference(scopeThreadRef(environmentId, threadId));
    shareThreadReference(scopeThreadRef(environmentId, ThreadId.make("thread-started")));

    expect(rpc.calls).toEqual([reserveOf("Picked")]);
  });
});
