import type { ThreadId } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";

const RESERVATION_RETENTION = Duration.days(30);

export interface ThreadDraftReservation {
  readonly title: string;
  readonly projectTitle: string | null;
}

/**
 * A client reserves a draft's thread id when the draft's reference leaves it, so an agent given
 * that reference learns it names a draft. Created at every start, not by a numbered migration,
 * for the reason `ThreadReferenceIndexes.ts` gives. Rows for threads that now exist, deleted
 * ones included, and rows a draft has not rewritten in 30 days go at the same start.
 */
export const ensureThreadDraftReservations = Effect.fn("Sqlite.ensureThreadDraftReservations")(
  function* (sql: SqlClient.SqlClient) {
    yield* sql`
      CREATE TABLE IF NOT EXISTS thread_draft_reservations (
        thread_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        project_title TEXT,
        updated_at TEXT NOT NULL
      )
    `;
    const cutoff = DateTime.formatIso(
      DateTime.subtractDuration(yield* DateTime.now, RESERVATION_RETENTION),
    );
    yield* sql`
      DELETE FROM thread_draft_reservations
      WHERE updated_at < ${cutoff}
        OR thread_id IN (SELECT thread_id FROM orchestration_v2_projection_threads)
    `;
  },
);

/**
 * The title and project name go into a message an agent reads, so they are one plain line:
 * control, format and line-separator characters become spaces.
 */
function plainLine(value: string): string {
  return value
    .replace(/[\p{Cc}\p{Cf}\u2028\u2029]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** A thread that exists already is no draft, so reserving its id changes nothing. */
export const reserveThreadDraft = Effect.fn("ThreadDraftReservations.reserve")(function* (
  sql: SqlClient.SqlClient,
  input: {
    readonly threadId: ThreadId;
    readonly title: string;
    readonly projectTitle: string | null;
  },
) {
  const now = DateTime.formatIso(yield* DateTime.now);
  const title = plainLine(input.title);
  const projectTitle = input.projectTitle === null ? null : plainLine(input.projectTitle) || null;
  yield* sql`
    INSERT INTO thread_draft_reservations (thread_id, title, project_title, updated_at)
    SELECT ${input.threadId}, ${title}, ${projectTitle}, ${now}
    WHERE NOT EXISTS (
      SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id = ${input.threadId}
    )
    ON CONFLICT (thread_id) DO UPDATE SET
      title = excluded.title,
      project_title = excluded.project_title,
      updated_at = excluded.updated_at
  `;
});

export const releaseThreadDraft = Effect.fn("ThreadDraftReservations.release")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
) {
  yield* sql`DELETE FROM thread_draft_reservations WHERE thread_id = ${threadId}`;
});

/** Never a thread that exists or existed: a deleted thread must not read as a draft. */
export const findThreadDraft = Effect.fn("ThreadDraftReservations.find")(function* (
  sql: SqlClient.SqlClient,
  threadId: ThreadId,
) {
  const rows = yield* sql<{ readonly title: string; readonly project_title: string | null }>`
    SELECT title, project_title FROM thread_draft_reservations
    WHERE thread_id = ${threadId}
      AND NOT EXISTS (
        SELECT 1 FROM orchestration_v2_projection_threads WHERE thread_id = ${threadId}
      )
  `;
  const row = rows[0];
  return row === undefined
    ? null
    : ({ title: row.title, projectTitle: row.project_title } satisfies ThreadDraftReservation);
});
