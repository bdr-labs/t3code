import { describe, expect, it } from "vite-plus/test";

import { threadGroupOf } from "./threadGroups.ts";

describe("threadGroupOf", () => {
  it.each([
    ["no tags at all", undefined, null],
    ["no group tag", ["recording", "review"], null],
    ["an empty group name", ["group:"], null],
    ["an empty group tag before a named one", ["group:", "group:fleet"], "fleet"],
    ["a group among other tags", ["recording", "group:fleet"], "fleet"],
    ["two group tags, the first wins", ["group:fleet", "group:other"], "fleet"],
    ["a name keeping its case and colons", ["group:Fleet:A"], "Fleet:A"],
    ["a prefix in another case", ["Group:fleet", "GROUP:fleet"], null],
    ["a tag that only contains the prefix", ["my-group:fleet", "groups:fleet"], null],
  ])("reads %s", (_name, tags, expected) => {
    expect(threadGroupOf(tags)).toBe(expected);
  });
});
