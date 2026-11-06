import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import {
  EnvironmentId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

const here = EnvironmentId.make("env-here");
const elsewhere = EnvironmentId.make("env-elsewhere");
const projectId = ProjectId.make("project");

vi.mock("../../hooks/useLoadBalancedEnvironment", () => ({
  useLoadBalancedEnvironment: () => ({
    pending: false,
    environmentId: "env-elsewhere",
    refresh: () => {},
  }),
}));
vi.mock("../../hooks/useScratchProject", () => ({
  useScratchProject: () => ({ openScratchProject: async () => null }),
}));

import { render } from "../../../test/render";
import { DraftId, type DraftSessionState, useComposerDraftStore } from "../../composerDraftStore";
import { useDraftEnvironmentRouting } from "./useDraftEnvironmentRouting";

const draftId = DraftId.make("draft-routed");

function Routing(props: { readonly draftThread: DraftSessionState }) {
  useDraftEnvironmentRouting({
    draftId,
    draftThread: props.draftThread,
    envLocked: false,
    automaticEnvironment: true,
    logicalProjectEnvironments: [{ environmentId: elsewhere, projectId }] as never,
    environmentById: new Map(),
    providersByEnvironment: new Map(),
    loadBalancingSettings: { loadBalancingWeights: {} },
    referencedThreadContexts: [],
    activeProviderInstanceId: ProviderInstanceId.make("instance"),
    selectedProvider: ProviderDriverKind.make("driver"),
    composerHasAttachments: false,
    activeProjectKey: null,
    activeProjectIsScratch: false,
    projectGroupingSettings: {} as never,
    sendInFlightRef: { current: false },
  });
  return null;
}

/** Opens the draft with `stored` as its selection and renders what the render before saw: auto. */
async function renderStaleAuto(stored: "auto" | "manual") {
  const store = useComposerDraftStore.getState();
  store.clearDraftThread(draftId);
  store.setLogicalProjectDraftThreadId("logical", scopeProjectRef(here, projectId), draftId, {
    threadId: ThreadId.make("thread-routed"),
    environmentSelection: stored,
    loadBalancedEnvironmentId: null,
  });
  const session = useComposerDraftStore.getState().getDraftSession(draftId)!;
  return render(<Routing draftThread={{ ...session, environmentSelection: "auto" }} />);
}

const draft = () => useComposerDraftStore.getState().getDraftSession(draftId);

// render() runs inside act(), so the effect has run by the time it returns, as the first test shows.
it("moves a draft automatic routing still owns", async () => {
  await using _screen = await renderStaleAuto("auto");

  expect(draft()?.environmentId).toBe(elsewhere);
});

it("keeps a draft pinned by a copied reference when an earlier pick settles", async () => {
  await using _screen = await renderStaleAuto("manual");

  expect(draft()).toMatchObject({ environmentId: here, environmentSelection: "manual" });
});
