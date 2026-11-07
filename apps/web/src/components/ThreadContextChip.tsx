import {
  threadReferenceHighlight,
  useHasThreadReferenceSession,
  useIsThreadReferencePinned,
  useReferenceHighlightRole,
} from "../threadReferenceHighlight";
import { scopedThreadKey, scopeProjectRef } from "@t3tools/client-runtime/environment";
import type { ThreadContextRecord } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import { MessagesSquareIcon } from "lucide-react";
import { useEffect } from "react";

import { useComposerDraftStore } from "~/composerDraftStore";
import { isElectron } from "~/env";
import { useMediaQuery } from "~/hooks/useMediaQuery";
import { cn, isMacPlatform } from "~/lib/utils";
import { useProject, useThreadShell } from "~/state/entities";
import { ContextChip, ContextChipLabel } from "./ContextChip";
import { ProjectFavicon } from "./ProjectFavicon";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

const { enter, leave, togglePinned } = threadReferenceHighlight;

export function ThreadContextChip(props: {
  record: Pick<ThreadContextRecord, "environmentId" | "threadId" | "title">;
  copyMarkdown?: string;
  unreadable?: boolean;
}) {
  const { environmentId, threadId } = props.record;
  const shell = useThreadShell({ environmentId, threadId });
  // Until the thread starts, a draft on this client that holds its id is what the chip opens.
  const draftId = useComposerDraftStore((store) =>
    shell ? null : store.getDraftIdByRef({ environmentId, threadId }),
  );
  const draftTitle = useComposerDraftStore((store) =>
    shell ? null : store.getDraftTitleByRef({ environmentId, threadId }),
  );
  const threadKey = scopedThreadKey({ environmentId, threadId });
  // A chip for a related thread stays plain: only mentions of the active reference stand out.
  const isTarget = useReferenceHighlightRole(threadKey) === "target";
  const isPinned = useIsThreadReferencePinned(threadKey);
  const hasSession = useHasThreadReferenceSession();
  // The sidebar's phone breakpoint: there it is a closed sheet, so a highlight could not be seen.
  const isPhone = useMediaQuery("max-md");
  const navigate = useNavigate();
  const to = draftId
    ? ({ to: "/draft/$draftId", params: { draftId } } as const)
    : ({ to: "/$environmentId/$threadId", params: { environmentId, threadId } } as const);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- no pointerleave fires for a chip that unmounts under the pointer, and the shared hover would stick
  useEffect(() => () => leave({ environmentId, threadId }), [environmentId, threadId]);
  const project = useProject(shell ? scopeProjectRef(environmentId, shell.projectId) : null);
  const title = shell?.title?.trim() || draftTitle || props.record.title;
  const status = props.unreadable
    ? "On another machine, so this machine's agent can't read it. Remove it or switch back to send."
    : shell
      ? null
      : draftId
        ? draftTitle
          ? `Draft "${draftTitle}", not started yet.`
          : "Draft, not started yet."
        : "Thread not started or deleted.";
  const openHint = `${isMacPlatform(navigator.platform) ? "⌘" : "Ctrl"}-click to open.`;
  const gesture = isPhone
    ? shell
      ? "Open thread"
      : draftId
        ? "Open it"
        : null
    : isPinned
      ? "Highlighted in this session. Click to remove."
      : hasSession
        ? `Highlight in this session. ${openHint}`
        : openHint;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ContextChip
            kind="thread"
            onPointerEnter={() => enter({ environmentId, threadId })}
            onPointerLeave={() => leave({ environmentId, threadId })}
            // A click focuses the chip too; only keyboard focus may hold a highlight.
            onFocus={(event) => {
              if (event.currentTarget.matches(":focus-visible")) enter({ environmentId, threadId });
            }}
            onClick={(event) => {
              // A phone tap opens as a link; shift and alt keep the browser's own link gestures.
              if (isPhone || event.shiftKey || event.altKey) return;
              event.preventDefault();
              // Mod opens here on every client: desktop denies the window a link click would open.
              if (event.metaKey || event.ctrlKey) void navigate(to);
              else togglePinned({ environmentId, threadId });
            }}
            onAuxClick={(event) => {
              if (!isElectron || event.button !== 1) return;
              event.preventDefault();
              void navigate(to);
            }}
            onBlur={(event) => {
              if (!event.currentTarget.matches(":hover")) leave({ environmentId, threadId });
            }}
            {...(props.unreadable ? { state: "invalid" as const } : {})}
            render={<Link {...to} />}
            aria-label={`Thread, ${title}`}
            data-markdown-copy={props.copyMarkdown}
            data-reference-highlight={isTarget ? "target" : undefined}
            className={cn("no-underline", isTarget && "ring-1 ring-(--context-chip-ink)/60")}
          >
            {project ? (
              <ProjectFavicon project={project} className="size-[1em] self-center" />
            ) : (
              <MessagesSquareIcon />
            )}
            <ContextChipLabel>{title}</ContextChipLabel>
          </ContextChip>
        }
      />
      <TooltipPopup side="top">{[status, gesture].filter(Boolean).join(" ")}</TooltipPopup>
    </Tooltip>
  );
}
