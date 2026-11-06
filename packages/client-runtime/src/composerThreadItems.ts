import {
  isListedThreadLineage,
  type EnvironmentId,
  type EnvironmentMachineKind,
  type ScopedThreadRef,
  type ThreadId,
} from "@t3tools/contracts";
import { foldSearchQuery, rankSearchItems, scoreThreadSearch } from "@t3tools/shared/paletteSearch";

import type { EnvironmentThreadShell } from "./state/models.ts";
import { threadSearchSubject, type ThreadSearchShell } from "./state/threadSearch.ts";

const COMPOSER_THREAD_RESULT_LIMIT = 5;

export type ComposerThreadCandidate = ThreadSearchShell &
  Pick<EnvironmentThreadShell, "archivedAt" | "lineage">;

export interface ComposerThreadItem {
  readonly id: string;
  readonly type: "thread";
  readonly thread: ScopedThreadRef;
  readonly label: string;
  readonly description: string;
}

/**
 * Threads to reference from the composer, matched and ranked like the command
 * palette, without subagent or side chat threads. The agent reads threads on its own server
 * and on the machines it links to, so candidates stay within those, and a linked
 * machine's threads say which machine they are on.
 */
export function matchComposerThreadItems(input: {
  shells: ReadonlyArray<ComposerThreadCandidate>;
  environmentId: EnvironmentId;
  /** The machines the composer's environment links to, by name. */
  linkedEnvironments: ReadonlyMap<EnvironmentId, string>;
  excludeThreadId: ThreadId | null;
  query: string;
  /** Recency is measured against this time. */
  now: number;
}): ComposerThreadItem[] {
  const query = foldSearchQuery(input.query);
  if (query.length === 0) return [];
  const candidates = input.shells.filter(
    (shell) =>
      (shell.environmentId === input.environmentId ||
        input.linkedEnvironments.has(shell.environmentId)) &&
      shell.id !== input.excludeThreadId &&
      shell.archivedAt === null &&
      isListedThreadLineage(shell.lineage),
  );
  return rankSearchItems(candidates, (shell, options) =>
    scoreThreadSearch(query, threadSearchSubject(shell, null), input.now, {
      ...options,
      picks: false,
    }),
  )
    .slice(0, COMPOSER_THREAD_RESULT_LIMIT)
    .map(({ item: shell }) => {
      const machine =
        shell.environmentId === input.environmentId
          ? undefined
          : input.linkedEnvironments.get(shell.environmentId);
      return {
        id: `thread:${shell.environmentId}:${shell.id}`,
        type: "thread",
        thread: { environmentId: shell.environmentId, threadId: shell.id },
        label: shell.title,
        description: machine === undefined ? "Thread" : `Thread on ${machine}`,
      };
    });
}

export interface ComposerDraftThreadCandidate {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly projectTitle: string | null;
}

/**
 * This client's drafts, whose threads do not exist yet but whose ids are already theirs. A draft
 * has no title to rank by, so "draft", "new thread" or its project's name finds it.
 */
export function matchComposerDraftThreadItems(input: {
  drafts: ReadonlyArray<ComposerDraftThreadCandidate>;
  environmentId: EnvironmentId;
  linkedEnvironments: ReadonlyMap<EnvironmentId, string>;
  excludeThreadId: ThreadId | null;
  query: string;
}): ComposerThreadItem[] {
  const query = foldSearchQuery(input.query);
  if (query.length === 0) return [];
  return input.drafts
    .filter(
      (draft) =>
        (draft.environmentId === input.environmentId ||
          input.linkedEnvironments.has(draft.environmentId)) &&
        draft.threadId !== input.excludeThreadId &&
        foldSearchQuery(`new thread draft ${draft.projectTitle ?? ""}`).includes(query),
    )
    .slice(0, COMPOSER_THREAD_RESULT_LIMIT)
    .map((draft) => {
      const machine =
        draft.environmentId === input.environmentId
          ? undefined
          : input.linkedEnvironments.get(draft.environmentId);
      const where = draft.projectTitle === null ? "Draft" : `Draft in ${draft.projectTitle}`;
      return {
        id: `thread:${draft.environmentId}:${draft.threadId}`,
        type: "thread",
        thread: { environmentId: draft.environmentId, threadId: draft.threadId },
        label: "New thread",
        description: machine === undefined ? where : `${where} on ${machine}`,
      };
    });
}

export interface ComposerEnvironmentCandidate {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly machine: EnvironmentMachineKind;
}

export interface ComposerEnvironmentItem {
  readonly id: string;
  readonly type: "environment";
  readonly environmentId: EnvironmentId;
  readonly machine: EnvironmentMachineKind;
  readonly label: string;
  readonly description: string;
}

/**
 * The user's machines the `@` picker offers, so the agent can link or work there. The
 * composer's own environment is left out. Like threads, they need a query: bare `@` stays a
 * file picker.
 */
export function matchComposerEnvironmentItems(input: {
  environments: ReadonlyArray<ComposerEnvironmentCandidate>;
  environmentId: EnvironmentId;
  query: string;
}): ComposerEnvironmentItem[] {
  const query = input.query.trim().toLowerCase();
  if (query.length === 0) return [];
  return input.environments
    .filter(
      (environment) =>
        environment.environmentId !== input.environmentId &&
        environment.label.toLowerCase().includes(query),
    )
    .map((environment) => ({
      id: `environment:${environment.environmentId}`,
      type: "environment",
      environmentId: environment.environmentId,
      machine: environment.machine,
      label: environment.label,
      description: "Machine",
    }));
}
