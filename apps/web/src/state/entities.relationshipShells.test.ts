import type {
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { arrayElementsEqual } from "@t3tools/client-runtime/state/entities";
import { describe, expect, it } from "vite-plus/test";

import { selectThreadRelationshipShells } from "./entities";

type Projection = Parameters<typeof selectThreadRelationshipShells>[1];

const shell = (
  id: string,
  parentThreadId: string | null = null,
  extra: Partial<Record<"openedByThreadId" | "title", string>> & {
    readonly tags?: readonly string[];
  } = {},
) =>
  ({
    id,
    forkedFrom: null,
    lineage: { parentThreadId, relationshipToParent: parentThreadId === null ? null : "fork" },
    ...extra,
  }) as unknown as OrchestrationV2ThreadShell;

const threadId = "current" as OrchestrationV2ThreadShell["id"];

describe("selectThreadRelationshipShells", () => {
  it("keeps the thread, its parent, its children and the threads its projection names", () => {
    const threads = [
      shell("current", "parent"),
      shell("parent"),
      shell("child", "current"),
      shell("subagent-child"),
      shell("workflow-member"),
      shell("transfer-source"),
      shell("unrelated"),
      shell("grandchild", "child"),
    ];
    const projection = {
      thread: threads[0],
      subagents: [
        {
          childThreadId: "subagent-child",
          workflow: { agents: [{ childThreadId: "workflow-member" }, {}] },
        },
        { childThreadId: null },
      ],
      contextTransfers: [{ sourceThreadId: "transfer-source", targetThreadId: "current" }],
    } as unknown as Pick<
      OrchestrationV2ThreadProjection,
      "thread" | "subagents" | "contextTransfers"
    >;

    expect(
      selectThreadRelationshipShells(threadId, projection, threads).map((thread) => thread.id),
    ).toEqual([
      "current",
      "parent",
      "child",
      "subagent-child",
      "workflow-member",
      "transfer-source",
    ]);
  });

  it("finds the parent from the shell before the projection loads", () => {
    const threads = [shell("current", "parent"), shell("parent"), shell("unrelated")];
    expect(
      selectThreadRelationshipShells(threadId, null as Projection, threads).map(
        (thread) => thread.id,
      ),
    ).toEqual(["current", "parent"]);
  });

  it("keeps the opener, the opened threads and the group's members, and nothing else", () => {
    const threads = [
      shell("current", null, { openedByThreadId: "opener", tags: ["group:fleet"] }),
      shell("opener"),
      shell("opened", null, { openedByThreadId: "current" }),
      shell("opened-by-other", null, { openedByThreadId: "other" }),
      shell("member", null, { tags: ["other", "group:fleet"] }),
      shell("other-group", null, { tags: ["group:Fleet"] }),
      shell("unrelated"),
    ];
    const selected = (projection: Projection) =>
      selectThreadRelationshipShells(threadId, projection, threads).map((thread) => thread.id);
    expect(selected(null)).toEqual(["current", "opener", "opened", "member"]);
    expect(
      selected({
        thread: threads[0],
        subagents: [],
        contextTransfers: [],
      } as unknown as Projection),
    ).toEqual(["current", "opener", "opened", "member"]);
  });

  it("keeps the whole family, past the depth cap too, and leaves out other families", () => {
    const threads = [
      shell("current", null, { openedByThreadId: "opener" }),
      shell("opener", null, { openedByThreadId: "root" }),
      shell("root"),
      shell("sibling", null, { openedByThreadId: "opener" }),
      shell("uncle", null, { openedByThreadId: "root" }),
      shell("cousin", null, { openedByThreadId: "uncle" }),
      ...Array.from({ length: 12 }, (_, index) =>
        shell(`deep-${index}`, null, {
          openedByThreadId: index === 0 ? "current" : `deep-${index - 1}`,
        }),
      ),
      shell("other-root"),
      shell("other-child", null, { openedByThreadId: "other-root" }),
    ];
    const selected = selectThreadRelationshipShells(threadId, null as Projection, threads);
    expect(selected.map((thread) => thread.id)).toEqual(
      threads.slice(0, -2).map((thread) => thread.id),
    );
  });

  it("walks the family from a projection when the shell list leaves the thread out", () => {
    const threads = [
      shell("opener"),
      shell("opened", null, { openedByThreadId: "current" }),
      shell("unrelated"),
    ];
    const projection = {
      thread: shell("current", null, { openedByThreadId: "opener" }),
      subagents: [],
      contextTransfers: [],
    } as unknown as Projection;
    expect(
      selectThreadRelationshipShells(threadId, projection, threads).map((thread) => thread.id),
    ).toEqual(["opener", "opened"]);
  });

  it("reads each shell's opener once on a long list, not once per family member", () => {
    let reads = 0;
    const counted = (thread: OrchestrationV2ThreadShell) => {
      const { openedByThreadId, ...rest } = thread;
      return Object.defineProperty(rest, "openedByThreadId", {
        enumerable: true,
        get: () => {
          reads += 1;
          return openedByThreadId;
        },
      }) as OrchestrationV2ThreadShell;
    };
    const threads = [
      counted(shell("current")),
      ...Array.from({ length: 500 }, (_, index) =>
        counted(
          index < 50
            ? shell(`family-${index}`, null, { openedByThreadId: "current" })
            : shell(`other-${index}`),
        ),
      ),
    ];
    selectThreadRelationshipShells(threadId, null as Projection, threads);
    expect(reads).toBeLessThanOrEqual(threads.length + 1);

    reads = 0;
    selectThreadRelationshipShells(threadId, null as Projection, threads);
    expect(reads).toBeLessThanOrEqual(1);
  });

  it("selects no family for a thread with no opener, opened thread or group", () => {
    const threads = [shell("current"), shell("tagged", null, { tags: ["group:fleet"] })];
    expect(
      selectThreadRelationshipShells(threadId, null as Projection, threads).map(
        (thread) => thread.id,
      ),
    ).toEqual(["current"]);
  });

  it("returns the same elements when an unrelated thread streams", () => {
    const before = [
      shell("current", null, { openedByThreadId: "opener", tags: ["group:fleet"] }),
      shell("opener", null, { openedByThreadId: "root" }),
      shell("root"),
      shell("sibling", null, { openedByThreadId: "opener" }),
      shell("member", null, { tags: ["group:fleet"] }),
      shell("unrelated", null, { title: "before" }),
    ];
    const after = before.map((thread) =>
      thread.id === "unrelated" ? shell("unrelated", null, { title: "after" }) : thread,
    );
    expect(
      arrayElementsEqual(
        selectThreadRelationshipShells(threadId, null as Projection, before),
        selectThreadRelationshipShells(threadId, null as Projection, after),
      ),
    ).toBe(true);
  });
});
