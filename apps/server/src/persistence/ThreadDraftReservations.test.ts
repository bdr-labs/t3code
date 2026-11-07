import { assert, it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as SqlitePersistence from "./Sqlite.ts";
import {
  ensureThreadDraftReservations,
  findThreadDraft,
  releaseThreadDraft,
  reserveThreadDraft,
} from "./ThreadDraftReservations.ts";

const draft = ThreadId.make("thread:draft");
const other = ThreadId.make("thread:other");
const DAY_MS = 86_400_000;

const insertThread = (sql: SqlClient.SqlClient, threadId: ThreadId, deletedAt: string | null) =>
  sql`
    INSERT INTO orchestration_v2_projection_threads (
      thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
      created_at, updated_at, deleted_at, payload_json
    ) VALUES (
      ${threadId}, 'project-1', 'Started', 'codex', 'full-access', 'default',
      '2026-11-07T00:00:00.000Z', '2026-11-07T00:00:00.000Z', ${deletedAt}, '{}'
    )
  `;

const count = (sql: SqlClient.SqlClient) =>
  sql<{ readonly n: number }>`SELECT COUNT(*) AS n FROM thread_draft_reservations`.pipe(
    Effect.map((rows) => rows[0]?.n ?? 0),
  );

it.layer(ProjectionStore.layer.pipe(Layer.provideMerge(SqlitePersistence.layerMemory)))(
  "ThreadDraftReservations",
  (it) => {
    it.effect("is created at setup and creating it again keeps its rows", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM thread_draft_reservations`;
        yield* reserveThreadDraft(sql, { threadId: draft, title: "Fix it", projectTitle: null });
        yield* ensureThreadDraftReservations(sql);
        assert.deepEqual(yield* findThreadDraft(sql, draft), {
          title: "Fix it",
          projectTitle: null,
        });
      }),
    );

    it.effect("stores the title and project as one plain line", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM thread_draft_reservations`;
        yield* reserveThreadDraft(sql, {
          threadId: draft,
          title: "Fix\u0000 the\nchips\u202e now\u2028",
          projectTitle: "\u0007\t",
        });
        assert.deepEqual(yield* findThreadDraft(sql, draft), {
          title: "Fix the chips now",
          projectTitle: null,
        });
      }),
    );

    it.effect("rewrites a draft's title and project and releases it", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM thread_draft_reservations`;
        yield* reserveThreadDraft(sql, {
          threadId: draft,
          title: "New thread",
          projectTitle: null,
        });
        yield* reserveThreadDraft(sql, {
          threadId: draft,
          title: "Fix it",
          projectTitle: "t3code",
        });
        assert.deepEqual(yield* findThreadDraft(sql, draft), {
          title: "Fix it",
          projectTitle: "t3code",
        });
        assert.equal(yield* count(sql), 1);
        yield* releaseThreadDraft(sql, draft);
        assert.equal(yield* findThreadDraft(sql, draft), null);
      }),
    );

    it.effect("never reads a thread that exists or existed as a draft", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const live = ThreadId.make("thread:live");
        const deleted = ThreadId.make("thread:deleted");
        yield* sql`DELETE FROM thread_draft_reservations`;
        yield* reserveThreadDraft(sql, { threadId: deleted, title: "Gone", projectTitle: null });
        yield* insertThread(sql, live, null);
        yield* insertThread(sql, deleted, "2026-11-07T01:00:00.000Z");
        // Reserving a live thread's id is a no-op that succeeds.
        yield* reserveThreadDraft(sql, { threadId: live, title: "Live", projectTitle: null });
        assert.equal(yield* findThreadDraft(sql, live), null);
        assert.equal(yield* findThreadDraft(sql, deleted), null);
        yield* ensureThreadDraftReservations(sql);
        assert.equal(yield* count(sql), 0);
      }),
    );

    it.effect("is never a thread to the titles that opener links and chips read", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        yield* reserveThreadDraft(sql, { threadId: draft, title: "Fix it", projectTitle: null });
        assert.deepEqual(yield* projections.getThreadTitles([draft]), {});
      }),
    );

    it.effect("prunes at start what no draft has rewritten in 30 days", () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* sql`DELETE FROM thread_draft_reservations`;
        yield* TestClock.setTime(Date.parse("2026-10-01T00:00:00.000Z"));
        yield* reserveThreadDraft(sql, { threadId: draft, title: "Old", projectTitle: null });
        yield* TestClock.adjust(`${29 * DAY_MS} millis`);
        yield* reserveThreadDraft(sql, { threadId: other, title: "Kept", projectTitle: null });
        yield* TestClock.adjust(`${2 * DAY_MS} millis`);
        yield* ensureThreadDraftReservations(sql);
        assert.equal(yield* findThreadDraft(sql, draft), null);
        assert.deepEqual(yield* findThreadDraft(sql, other), { title: "Kept", projectTitle: null });
      }),
    );
  },
);
