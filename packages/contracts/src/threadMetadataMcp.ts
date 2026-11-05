import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import { ThreadLinkedPullRequest } from "./threadPullRequest.ts";
import { StoredThreadTags, ThreadTag } from "./threadTags.ts";
import { ThreadTitleRegeneration } from "./threadTitle.ts";

export function hasOnlyPairedSurrogates(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

const ThreadMetadataTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(512)).annotate({
  description: "New concise display title. Required only when action is rename.",
});

const ThreadMetadataClientRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(256))
  .check(
    Schema.makeFilter((value) =>
      hasOnlyPairedSurrogates(value)
        ? true
        : "clientRequestId must contain valid paired Unicode surrogates.",
    ),
  )
  .annotate({ description: "Stable idempotency key to reuse when retrying this mutation." });

/** A tag this way goes into its command's id, and an id with a lone surrogate cannot encode. */
export const ThreadMetadataMcpTags = Schema.Array(
  ThreadTag.check(
    Schema.makeFilter((value) =>
      hasOnlyPairedSurrogates(value)
        ? true
        : "A thread tag must contain valid paired Unicode surrogates.",
    ),
  ),
).check(Schema.isMaxLength(16));

export const ThreadMetadataMcpAction = Schema.Literals(["rename", "regenerate_title", "tag"]);
export type ThreadMetadataMcpAction = typeof ThreadMetadataMcpAction.Type;

export const ThreadMetadataMcpUpdateInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  action: ThreadMetadataMcpAction,
  title: Schema.optional(ThreadMetadataTitle),
  addTags: Schema.optional(ThreadMetadataMcpTags),
  removeTags: Schema.optional(ThreadMetadataMcpTags),
  clientRequestId: Schema.optional(ThreadMetadataClientRequestId),
}).check(
  Schema.makeFilter((input) => {
    const hasTagField = input.addTags !== undefined || input.removeTags !== undefined;
    if (input.action !== "tag") {
      return (input.action === "rename") === (input.title !== undefined) && !hasTagField
        ? true
        : "rename requires title; regenerate_title does not accept one; neither accepts a tag field.";
    }
    const added = input.addTags ?? [];
    const removed = input.removeTags ?? [];
    return input.title === undefined &&
      added.length + removed.length > 0 &&
      !added.some((tag) => removed.includes(tag))
      ? true
      : "tag requires at least one tag in addTags or removeTags, none in both, and no title.";
  }),
);
export type ThreadMetadataMcpUpdateInput = typeof ThreadMetadataMcpUpdateInput.Type;

export const ThreadMetadataMcpUpdateResult = Schema.Struct({
  threadId: ThreadId,
  action: ThreadMetadataMcpAction,
  commandId: CommandId,
  sequence: NonNegativeInt,
  title: Schema.String,
  titleRegeneration: Schema.NullOr(ThreadTitleRegeneration),
  linkedPullRequest: Schema.NullOr(ThreadLinkedPullRequest),
  updatedAt: IsoDateTime,
  /** The thread's tags after a `tag` action; absent on the others. */
  tags: Schema.optional(StoredThreadTags),
});
export type ThreadMetadataMcpUpdateResult = typeof ThreadMetadataMcpUpdateResult.Type;
