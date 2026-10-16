import type {
  OrchestrationV2Subagent,
  OrchestrationV2TurnItemStatus,
  OrchestrationV2ThreadShell,
  OrchestrationProjectShell,
  ServerProvider,
} from "@t3tools/contracts";
import { formatModelSlugName, resolveSelectableModel } from "@t3tools/shared/model";
import { fileBasename } from "@t3tools/shared/path";
import { resolveModelShortName } from "../providerClients.ts";
import { isTerminalSubagentStatus } from "./subagentRuntime.ts";

type SubagentOrigin = OrchestrationV2Subagent["origin"] | undefined;

export function subagentGroupSummary(
  members: ReadonlyArray<{
    readonly status: OrchestrationV2TurnItemStatus;
    readonly origin?: SubagentOrigin;
  }>,
) {
  const active = members.some(
    ({ status }) => status === "pending" || status === "running" || status === "waiting",
  );
  return {
    label: `${active ? "Kicked off" : "Ran"} ${childAgentCountLabel(members.map(({ origin }) => origin))}`,
    active,
    failed: members.some(({ status }) => status === "failed"),
  };
}

/**
 * A T3 `delegate_task` worker (`app_owned`) runs its own provider session in its own thread;
 * a provider-native subagent runs inside the parent's provider process.
 */
export function subagentKindLabel(
  origin: OrchestrationV2Subagent["origin"] | undefined,
): "agent" | "subagent" | null {
  if (origin === "app_owned") return "agent";
  if (origin === "provider_native") return "subagent";
  return null;
}

/** The kind as a title for a child agent that has none; an unknown origin reads "subagent". */
export function subagentFallbackTitle(origin: SubagentOrigin): "agent" | "subagent" {
  return origin === "app_owned" ? "agent" : "subagent";
}

/** "1 agent", "2 subagents", "1 agent and 2 subagents"; an unknown origin counts as a subagent. */
export function childAgentCountLabel(origins: ReadonlyArray<SubagentOrigin>): string {
  const agents = origins.filter((origin) => origin === "app_owned").length;
  const subagents = origins.length - agents;
  const parts = [
    agents > 0 ? `${agents} ${agents === 1 ? "agent" : "agents"}` : null,
    subagents > 0 || agents === 0
      ? `${subagents} ${subagents === 1 ? "subagent" : "subagents"}`
      : null,
  ];
  return parts.filter(Boolean).join(" and ");
}

export function summarizeSubagentStatuses(
  statuses: ReadonlyArray<OrchestrationV2TurnItemStatus>,
): string {
  const counts = { working: 0, done: 0, failed: 0, stopped: 0, idle: 0 };
  for (const status of statuses) {
    if (status === "pending" || status === "running" || status === "waiting") counts.working += 1;
    else if (status === "completed") counts.done += 1;
    else if (status === "failed") counts.failed += 1;
    else if (status === "idle") counts.idle += 1;
    else counts.stopped += 1;
  }
  return (Object.keys(counts) as Array<keyof typeof counts>)
    .filter((key) => counts[key] > 0)
    .map((key) => `${counts[key]} ${key}`)
    .join(" · ");
}

export function formatSubagentDisplayTitle(title: string): string {
  const displayTitle = title.replace(/^Subagent:\s*/i, "");
  const path = /^\/root\/(?:[^/]+\/)*([^/]+)\/?$/u.exec(displayTitle);
  if (path === null) return displayTitle;

  const name = path[1]!.replace(/[_\s]+/gu, " ").trim();
  return name.replace(/(^|\s)\S/gu, (letter) => letter.toUpperCase()) || displayTitle;
}

export function resolveSubagentMetadata(input: {
  readonly model: string | null;
  readonly provider?: Pick<ServerProvider, "driver" | "models"> | null | undefined;
  readonly parentThread?:
    | Pick<OrchestrationV2ThreadShell, "projectId" | "worktreePath">
    | null
    | undefined;
  readonly childThread?:
    | Pick<OrchestrationV2ThreadShell, "branch" | "worktreePath">
    | null
    | undefined;
  readonly parentProject?: Pick<OrchestrationProjectShell, "workspaceRoot"> | null | undefined;
  readonly childProject?:
    | Pick<OrchestrationProjectShell, "id" | "title" | "workspaceRoot">
    | null
    | undefined;
}) {
  const model = input.model?.trim();
  const slug = input.provider
    ? resolveSelectableModel(input.provider.driver, model, input.provider.models)
    : model;
  const catalogModel = input.provider?.models.find((candidate) => candidate.slug === slug);
  const reportedLabel = catalogModel
    ? (resolveModelShortName(catalogModel, input.provider?.driver) ?? catalogModel.name)
    : model
      ? formatModelSlugName(model)
      : "Not reported";
  const qualifier = catalogModel?.subProvider?.trim();
  const modelLabel = qualifier
    ? reportedLabel
        .replace(
          new RegExp(
            `^${qualifier.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:\\s*[.:/-]\\s*|\\s+)`,
            "iu",
          ),
          "",
        )
        .trim() || reportedLabel
    : reportedLabel;
  const parentWorkspace = input.parentThread?.worktreePath ?? input.parentProject?.workspaceRoot;
  const childWorkspace = input.childThread?.worktreePath ?? input.childProject?.workspaceRoot;
  const workspace = [
    ...(input.parentThread &&
    input.childProject &&
    input.childProject.id !== input.parentThread.projectId
      ? [{ label: "Project", value: input.childProject.title }]
      : []),
    ...(parentWorkspace && childWorkspace && parentWorkspace !== childWorkspace
      ? [
          {
            label: input.childThread?.branch
              ? "Branch"
              : input.childThread?.worktreePath
                ? "Worktree"
                : "Workspace",
            value: input.childThread?.branch ?? fileBasename(childWorkspace),
          },
        ]
      : []),
  ];
  return { modelLabel, workspace };
}

export function subagentDetailPreview(input: {
  readonly status: OrchestrationV2TurnItemStatus;
  readonly result?: string | null | undefined;
  readonly progress?: string | null | undefined;
}): string | null {
  const terminal = isTerminalSubagentStatus(input.status);
  const preferred = terminal ? input.result : input.progress;
  const fallback = terminal ? input.progress : input.result;
  const detail = preferred?.trimStart() || fallback?.trimStart() || "";
  if (detail.length <= 280) return detail.trimEnd().replace(/\s+/gu, " ") || null;
  const whitespace = /\s+/uy;
  let compact = "";
  for (let index = 0; index < detail.length; index += 1) {
    whitespace.lastIndex = index;
    const gap = whitespace.exec(detail);
    if (gap) {
      index += gap[0].length;
      if (index === detail.length) break;
      if (compact.length > 0) compact += " ";
    }
    compact += detail[index];
    if (compact.length > 280) return `${compact.slice(0, 280).trimEnd()}…`;
  }
  return compact || null;
}
