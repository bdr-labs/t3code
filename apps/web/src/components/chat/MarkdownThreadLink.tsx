import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  formatHostedThreadLink,
  guessThreadLinkRef,
  percentDecodedThreadLinkId,
  type ThreadLink,
  unknownThreadLinkLabel,
} from "@t3tools/shared/threadLinks";

import { DRAFT_THREAD_TITLE, useComposerDraftStore } from "../../composerDraftStore";
import { configuredHostedAppUrl } from "../../hostedPairing";
import { useThreadRefs, useThreadShell } from "../../state/entities";
import { UnresolvedChip } from "../contextChipParts";
import { ThreadContextChip } from "../ThreadContextChip";

/** `label` is the link's written text; an autolink has none. */
export function MarkdownThreadLink(props: {
  readonly environmentId: EnvironmentId;
  readonly link: ThreadLink;
  readonly label: string | null;
}) {
  const environmentId = props.link.environmentId ?? props.environmentId;
  const decodedId = percentDecodedThreadLinkId(props.link.threadId);
  const written = useThreadShell(scopeThreadRef(environmentId, props.link.threadId));
  const decoded = useThreadShell(
    written === null && decodedId !== null ? scopeThreadRef(environmentId, decodedId) : null,
  );
  const local = written ?? decoded;
  const guess = local === null && props.link.environmentId === null;
  const refs = useThreadRefs(guess);
  const remote = useThreadShell(guess ? guessThreadLinkRef(props.link, refs) : null);
  const thread = local ?? remote;
  const hasDraft = useComposerDraftStore(
    (store) =>
      thread === null &&
      store.getDraftIdByRef(scopeThreadRef(environmentId, props.link.threadId)) !== null,
  );
  if (thread === null) {
    if (hasDraft) {
      const ref = scopeThreadRef(environmentId, props.link.threadId);
      const title = props.label || DRAFT_THREAD_TITLE;
      return (
        <ThreadContextChip
          record={{ ...ref, title }}
          copyMarkdown={formatHostedThreadLink(ref, title, configuredHostedAppUrl())}
        />
      );
    }
    const unknown = unknownThreadLinkLabel(props.link, props.environmentId);
    return <UnresolvedChip label={props.label ?? unknown} tooltip={unknown} />;
  }
  const ref = { environmentId: thread.environmentId, threadId: thread.id };
  const title = thread.title.trim() || props.label || "Untitled thread";
  return (
    <ThreadContextChip
      record={{ ...ref, title }}
      copyMarkdown={formatHostedThreadLink(ref, title, configuredHostedAppUrl())}
    />
  );
}
