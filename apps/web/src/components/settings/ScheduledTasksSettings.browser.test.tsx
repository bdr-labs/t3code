import { RegistryContext } from "@effect/atom-react";
import { Atom, AtomRegistry } from "effect/reactivity";
import {
  DEFAULT_UNIFIED_SETTINGS,
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
  type ScheduledTask,
  type ServerProvider,
} from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";
import { act, render } from "../../../test/render";
import { ScheduledTasksSettings } from "./ScheduledTasksSettings";

const environmentId = EnvironmentId.make("laptop");
const projectId = ProjectId.make("project");
const task: ScheduledTask = {
  id: ScheduledTaskId.make("nightly"),
  title: "Review issues",
  prompt: "Review open issues",
  enabled: true,
  schedule: { type: "interval", everyMs: 60_000 },
  projectId,
  threadId: ThreadId.make("older-thread"),
  workspaceStrategy: { type: "root" },
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  createdBy: "user",
  creationSource: "web",
  createdAt: "2026-09-17T00:00:00.000Z",
  updatedAt: "2026-09-17T00:00:00.000Z",
  nextRunAt: null,
  lastRunAt: null,
  lastRunStatus: "never",
  lastRunError: null,
  runCount: 0,
};

// Stands in for the thread family read the editor makes when the shell lacks the bound thread.
const threadFamilyRead = {
  snapshotSequence: 1,
  threads: [{ id: task.threadId, title: "Fix login bug" }],
};

const codexProvider = {
  instanceId: task.modelSelection.instanceId,
  driver: "codex",
  displayName: "Codex",
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: task.createdAt,
  models: [{ slug: "gpt-5.4", name: "GPT-5.4", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
  usageLimits: {
    checkedAt: task.createdAt,
    windows: [
      { id: "seven_day", kind: "weekly", label: "Weekly", usedPercent: 40 },
      { id: "seven_day_opus", kind: "weekly", label: "Weekly · Opus", usedPercent: 10 },
    ],
  },
} as unknown as ServerProvider;
const otherProvider = {
  ...codexProvider,
  instanceId: ProviderInstanceId.make("claudeAgent"),
  driver: "claudeAgent",
  displayName: "Claude",
  models: [{ slug: "fable", name: "Fable", isCustom: false, capabilities: null }],
  usageLimits: {
    checkedAt: task.createdAt,
    windows: [{ id: "five_hour", kind: "session", label: "Session", usedPercent: 40 }],
  },
} as unknown as ServerProvider;
const unsupportedProvider = {
  ...codexProvider,
  instanceId: ProviderInstanceId.make("opencode"),
  driver: "opencode",
  displayName: "OpenCode",
  usageLimits: {
    checkedAt: task.createdAt,
    windows: [],
    unavailable: { reason: "unsupported" },
  },
} as unknown as ServerProvider;
const providersAtom = Atom.make<ReadonlyArray<ServerProvider>>([
  codexProvider,
  otherProvider,
  unsupportedProvider,
]);

const state = vi.hoisted(() => ({
  connected: true,
  tasksLoaded: true,
  secondary: false,
  usageSchedule: null as ScheduledTask["schedule"] | null,
  saved: [] as ReadonlyArray<ScheduledTask["schedule"]>,
}));
const secondaryId = EnvironmentId.make("secondary");
const permissions = new Map<string, Atom.Writable<boolean>>();

function setup() {
  state.connected = true;
  state.tasksLoaded = true;
  state.secondary = false;
  state.usageSchedule = null;
  state.saved = [];
  permissions.clear();
  permissions.set(environmentId, Atom.make(true));
  permissions.set(secondaryId, Atom.make(true));
  permissions.set("", Atom.make(false));
}

function secondaryEnvironment() {
  return { ...environment(), environmentId: secondaryId, label: "Secondary" };
}

function environment() {
  return {
    environmentId,
    label: "Laptop",
    connection: { phase: state.connected ? "connected" : "disconnected" },
    serverConfig: state.connected
      ? { environment: { platform: "linux", capabilities: { oneTimeSchedules: true } } }
      : null,
  };
}

vi.mock(import("./SettingsScopeContext"), async (original) => {
  const scope = () => {
    const entry = environment();
    return {
      scope: { kind: "all", label: "All", members: [], environmentIds: [environmentId] },
      environments: state.secondary ? [entry, secondaryEnvironment()] : [entry],
      connectedEnvironments: state.connected
        ? state.secondary
          ? [entry, secondaryEnvironment()]
          : [entry]
        : [],
      environment: entry,
      target: null,
      targets: [],
    };
  };
  return {
    ...(await original()),
    useSettingsScope: scope as never,
  };
});
vi.mock(import("../../state/server"), async (original) => {
  const actual = await original();

  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      providersValueAtom: (() => providersAtom) as never,
      upsertScheduledTask: {
        ...actual.serverEnvironment.upsertScheduledTask,
        permissionAtom: (id: string | null) => permissions.get(id ?? "")!,
      },
    },
  };
});
vi.mock(import("../../state/threads"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    threadFamilies: { ...actual.threadFamilies, familyAtom: (() => threadFamilyRead) as never },
  };
});
// Mirrors the real query: a null request (disconnected environment) has no data.
vi.mock(import("../../state/query"), async (original) => ({
  ...(await original()),
  useEnvironmentQuery: ((request: unknown) => ({
    data:
      request === null || request === threadFamilyRead
        ? request
        : {
            tasks: state.tasksLoaded
              ? [state.usageSchedule ? { ...task, schedule: state.usageSchedule } : task]
              : [],
          },
    error: null,
    isPending: false,
    refresh: vi.fn(),
  })) as never,
}));
vi.mock(import("../../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironment: ((id: EnvironmentId) =>
    id === secondaryId ? secondaryEnvironment() : environment()) as never,
}));
vi.mock(import("../../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => [{ id: projectId, environmentId, title: "Project" }]) as never,
}));
vi.mock(import("~/state/session"), async (original) => ({
  ...(await original()),
  readEnvironmentScope: () => true,
}));
vi.mock(import("../../state/use-atom-command"), () => ({
  useAtomCommand: (() => async (call: { input: { schedule: ScheduledTask["schedule"] } }) => {
    state.saved = [...state.saved, call.input.schedule];
    return { _tag: "Success" };
  }) as never,
}));
vi.mock(import("../../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useEnvironmentSettings: (() => DEFAULT_UNIFIED_SETTINGS) as never,
}));

describe("ScheduledTasksSettings", () => {
  it("creates on a permitted secondary and reacts to permission changes", async () => {
    setup();
    state.secondary = true;
    const registry = AtomRegistry.make();
    using _registry = { [Symbol.dispose]: () => registry.dispose() };
    registry.set(permissions.get(environmentId)!, false);
    await using screen = await render(
      <RegistryContext.Provider value={registry}>
        <ScheduledTasksSettings />
      </RegistryContext.Provider>,
    );
    const create = screen.getByRole("button", { name: "New task" });
    await expect.element(create).toBeEnabled();
    await act(() => registry.set(permissions.get(secondaryId)!, false));
    await expect.element(create).toBeDisabled();
    await act(() => registry.set(permissions.get(secondaryId)!, true));
    await expect.element(create).toBeEnabled();
    await create.click();
    await expect.element(page.getByLabelText("Runs on")).toHaveTextContent("Secondary");
  });

  it("keeps the permitted representative as the creation target", async () => {
    setup();
    state.secondary = true;
    await using screen = await render(<ScheduledTasksSettings />);
    await screen.getByRole("button", { name: "New task" }).click();
    await expect.element(page.getByLabelText("Runs on")).toHaveTextContent("Laptop");
  });

  it("disables creation without a connected target", async () => {
    setup();
    state.connected = false;
    await using screen = await render(<ScheduledTasksSettings />);
    await expect.element(screen.getByRole("button", { name: "New task" })).toBeDisabled();
  });

  it("keeps a linked task's unsaved edits across a disconnect and reconnect", async () => {
    setup();
    await using screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    await expect.element(page.getByRole("dialog").getByText("Fix login bug")).toBeVisible();
    const name = page.getByRole("dialog").getByRole("textbox", { name: "Name" });
    await expect.element(name).toHaveValue("Review issues");
    await userEvent.fill(name, "Review stale issues");

    state.connected = false;
    await screen.rerender(<ScheduledTasksSettings taskId={task.id} />);

    await expect.element(name).toHaveValue("Review stale issues");

    state.connected = true;
    await screen.rerender(<ScheduledTasksSettings taskId={task.id} />);
    await expect.element(name).toHaveValue("Review stale issues");
  });

  it("keeps an editor the user opened when the linked task loads later", async () => {
    setup();
    state.tasksLoaded = false;
    await using screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    await userEvent.click(page.getByRole("button", { name: "New task" }));
    const dialog = page.getByRole("dialog");
    const name = dialog.getByRole("textbox", { name: "Name" });
    await userEvent.fill(name, "My draft");

    state.tasksLoaded = true;
    await screen.rerender(<ScheduledTasksSettings taskId={task.id} />);

    await expect.element(dialog.getByRole("heading", { name: "New task" })).toBeInTheDocument();
    await expect.element(name).toHaveValue("My draft");
  });

  it("creates a usage task from the instance's live windows", async () => {
    setup();
    await using screen = await render(<ScheduledTasksSettings />);
    await screen.getByRole("button", { name: "New task" }).click();
    const dialog = page.getByRole("dialog");
    await userEvent.fill(dialog.getByRole("textbox", { name: "Name" }), "Near the limit");
    await userEvent.fill(dialog.getByRole("textbox", { name: "Prompt" }), "Wrap up");
    await dialog.getByRole("button", { name: "On usage" }).click();
    await expect.element(dialog.getByLabelText("Usage window")).toHaveTextContent("Weekly");

    await dialog.getByLabelText("Usage window").click();
    await page.getByRole("option", { name: "Weekly · Opus" }).click();
    await dialog.getByRole("button", { name: "Above" }).click();
    await userEvent.fill(dialog.getByLabelText("Percent used"), "75");
    await dialog.getByRole("button", { name: "Create task" }).click();

    await vi.waitFor(() =>
      expect(state.saved).toEqual([
        { type: "usage", window: "seven_day_opus", on: "above", usedPercent: 75 },
      ]),
    );
  });

  it("a model change moves a trigger on the task's model to that instance's windows", async () => {
    setup();
    state.usageSchedule = { type: "usage", window: "seven_day", on: "reset" };
    await using _screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    const dialog = page.getByRole("dialog");
    await expect.element(dialog.getByLabelText("Usage window")).toHaveTextContent("Weekly");

    await dialog.getByRole("button", { name: "GPT-5.4" }).click();
    await page.getByRole("button", { name: "Claude", exact: true }).click();
    await page.getByRole("option", { name: /Fable/ }).click();

    await expect.element(dialog.getByLabelText("Usage window")).toHaveTextContent("Session");
    await dialog.getByRole("button", { name: "Save task" }).click();
    await vi.waitFor(() =>
      expect(state.saved).toEqual([{ type: "usage", window: "five_hour", on: "reset" }]),
    );
  });

  it("says an instance that reports no usage cannot be watched", async () => {
    setup();
    state.usageSchedule = {
      type: "usage",
      instanceId: ProviderInstanceId.make("opencode"),
      window: "weekly",
      on: "reset",
    };
    await using _screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    await expect
      .element(
        page.getByRole("dialog").getByText("This provider does not report usage", { exact: false }),
      )
      .toBeVisible();
  });

  it.each([
    {
      name: "every field of a live window",
      stored: {
        type: "usage",
        instanceId: ProviderInstanceId.make("codex"),
        window: "seven_day",
        on: "below",
        usedPercent: 20,
      },
      provider: "Codex",
      window: "Weekly",
      pressed: "Below",
      label: "When Weekly is below 20%",
    },
    {
      name: "a kind an agent named, on the task's model",
      stored: { type: "usage", window: "weekly", on: "reset" },
      provider: "The task's model",
      window: "Weekly",
      pressed: "Renews",
      label: "When Weekly renews",
    },
    {
      name: "a window the provider no longer reports",
      stored: { type: "usage", window: "seven_day_sonnet", on: "above", usedPercent: 80 },
      provider: "The task's model",
      window: "Seven day sonnet",
      pressed: "Above",
      label: "When Seven day sonnet is above 80%",
    },
  ] as const)("an edit round-trips $name, with no server state", async (row) => {
    setup();
    state.usageSchedule = { ...row.stored, state: { armed: false } };
    await using screen = await render(<ScheduledTasksSettings taskId={task.id} />);
    const dialog = page.getByRole("dialog");
    await expect.element(dialog.getByLabelText("Provider")).toHaveTextContent(row.provider);
    await expect.element(dialog.getByLabelText("Usage window")).toHaveTextContent(row.window);
    await expect
      .element(dialog.getByRole("button", { name: row.pressed }))
      .toHaveAttribute("aria-pressed", "true");
    if ("usedPercent" in row.stored) {
      await expect
        .element(dialog.getByLabelText("Percent used"))
        .toHaveValue(row.stored.usedPercent);
    }
    await expect.element(screen.getByText(row.label, { exact: false })).toBeInTheDocument();

    await dialog.getByRole("button", { name: "Save task" }).click();
    await vi.waitFor(() => expect(state.saved).toEqual([row.stored]));
  });
});
