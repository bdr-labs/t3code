import { expect, it } from "@effect/vitest";
import { ScheduledTaskUpsertSchedule } from "@t3tools/contracts";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import { Tool } from "effect/ai";

import { advertisedJsonSchema } from "../../advertisedJsonSchema.ts";
import { ProjectToolkit } from "../project/tools.ts";
import { OrchestratorToolkit } from "./tools.ts";

// Oversized page sizes clamp on decode, so the schema has no `maximum`; Codex also drops
// bounds from its TypeScript view. The description is the only place a model sees a limit.
it("states t3_thread_read page size limits in the parameter descriptions", () => {
  const schema = Tool.getJsonSchema(OrchestratorToolkit.tools.t3_thread_read) as {
    readonly properties: Readonly<Record<string, { readonly description?: string }>>;
  };
  const limits = { limit: "100", runLimit: "50", maxCharsPerItem: "50000" };
  for (const [name, maximum] of Object.entries(limits)) {
    expect(schema.properties[name]?.description, name).toContain(maximum);
  }
});

it("refuses a t3_thread_update whose fields do not fit its action", () => {
  const decode = Schema.decodeUnknownExit(
    OrchestratorToolkit.tools.t3_thread_update.parametersSchema,
  );
  expect(Exit.isFailure(decode({ action: "rename" }))).toBe(true);
  expect(Exit.isFailure(decode({ action: "regenerate_title", title: "New" }))).toBe(true);
  expect(Exit.isSuccess(decode({ action: "rename", title: "New", environmentId: undefined }))).toBe(
    true,
  );
  expect(Exit.isSuccess(decode({ action: "regenerate_title" }))).toBe(true);

  const manyTags = Array.from({ length: 17 }, (_, index) => `tag-${index}`);
  for (const refused of [
    { action: "rename", title: "New", addTags: ["a"] },
    { action: "rename", title: "New", removeTags: [] },
    { action: "regenerate_title", addTags: ["a"] },
    { action: "regenerate_title", removeTags: ["a"] },
    { action: "tag" },
    { action: "tag", title: "New", addTags: ["a"] },
    { action: "tag", addTags: [] },
    { action: "tag", addTags: [], removeTags: [] },
    { action: "tag", addTags: ["a"], removeTags: ["a"] },
    { action: "tag", addTags: ["x".repeat(65)] },
    { action: "tag", removeTags: ["group:\nfleet"] },
    { action: "tag", addTags: ["group:\ud800"] },
    { action: "tag", addTags: ["   "] },
    { action: "tag", addTags: manyTags },
    { action: "tag", removeTags: manyTags },
  ]) {
    expect(Exit.isFailure(decode(refused)), JSON.stringify(refused)).toBe(true);
  }
  for (const accepted of [
    { action: "tag", addTags: ["a"] },
    { action: "tag", removeTags: ["a"] },
    { action: "tag", addTags: ["a"], removeTags: [] },
    { action: "tag", addTags: ["a"], removeTags: ["b"], threadId: "thread:other" },
    { action: "tag", addTags: manyTags.slice(0, 16), removeTags: ["x".repeat(64)] },
  ]) {
    expect(Exit.isSuccess(decode(accepted)), JSON.stringify(accepted)).toBe(true);
  }
});

// A client on an older deck learns these fields exist from here, so the shape is a promise.
it("advertises an opener, tags and the tag action in tools/list", () => {
  const tagList = {
    type: "array",
    maxItems: 16,
    items: expect.objectContaining({ type: "string" }),
  };
  expect(advertisedJsonSchema(ProjectToolkit.tools.t3_thread_launch).properties).toMatchObject({
    openedByThreadId: expect.objectContaining({ type: "string" }),
    tags: expect.objectContaining(tagList),
  });
  expect(advertisedJsonSchema(OrchestratorToolkit.tools.t3_thread_update).properties).toMatchObject(
    {
      action: expect.objectContaining({ enum: ["rename", "regenerate_title", "tag"] }),
      addTags: expect.objectContaining(tagList),
      removeTags: expect.objectContaining(tagList),
    },
  );
});

// The tool's own description names no trigger, so this field is all a model reads about them.
it("names every schedule trigger in the schedule_task schema", () => {
  const { properties } = advertisedJsonSchema(OrchestratorToolkit.tools.schedule_task);
  for (const member of ScheduledTaskUpsertSchedule.members) {
    expect(properties).toMatchObject({
      schedule: {
        description: expect.stringContaining(`type:'${member.fields.type.literal}'`),
      },
    });
  }
  // `deliverAs` carries no description of its own, to keep the tool list small.
  expect(properties).toMatchObject({
    schedule: { description: expect.stringContaining("deliverAs:'steer'") },
  });
});
