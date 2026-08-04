import { getPool } from '@/lib/db/pool'
import { MAX_ATTEMPTS } from '@/modules/shared/outbox/services/outboxService'

/**
 * THE single definition of "how deep is the outbox queue" (spec §8.5's Admin-dashboard
 * job-queue health widget, and spec §13's `/api/health` queue depth).
 *
 * ONE FUNCTION, TWO CONSUMERS, and the reason is a real failure mode rather than tidiness:
 * the dashboard and the health check computing these numbers separately is exactly how an
 * operator ends up trusting a green health check while the dashboard shows a backlog. They
 * must not be able to disagree, so neither of them owns the query.
 *
 * `parked` is `attempts >= MAX_ATTEMPTS`, imported from the drain rather than restated as
 * a literal `5` — the cap is the drain's property, and a hand-written 5 here would go quietly
 * wrong the day it moves.
 *
 * NOT A SERVER-COMPONENT-CALLS-HTTP ARRANGEMENT. The dashboard calls this function
 * directly; it does not fetch `/api/health`. A server component making an HTTP request to
 * its own deployment to read its own database is a round trip, an auth problem and an
 * outage-amplifier for no benefit.
 */

export type QueueHealth = {
  /** Rows still owed processing: `processed_at IS NULL`. Includes the parked ones. */
  unprocessed: number
  /**
   * Rows at or beyond the attempts cap. **A SUBSET of `unprocessed`, not a separate
   * bucket** — they are still unprocessed, they are simply no longer being retried. A
   * dashboard showing them as two adjacent totals should say so, or it reads as though
   * the backlog were `unprocessed + parked`.
   */
  parked: number
  /**
   * When the oldest unprocessed event occurred, or null when there are none.
   *
   * The number that actually tells an operator whether the SCHEDULE is working, which
   * neither count does: a steady `unprocessed: 3` is healthy if the oldest is 30 seconds
   * old and means the drain has stopped running if it is 30 hours old.
   */
  oldestUnprocessedAt: Date | null
}

/**
 * Probes for the table, THEN counts — deliberately two statements, not one.
 *
 * The obvious single-statement form wraps each count in
 * `CASE WHEN to_regclass('public.outbox') IS NULL THEN NULL ELSE (SELECT …) END`
 * and DOES NOT WORK. `to_regclass` is a runtime function, but `FROM outbox` is resolved
 * at PARSE-ANALYSIS — before any CASE branch is evaluated — so a missing table raises
 * `relation "outbox" does not exist` and the guard never runs. Reproduce it with:
 *
 *   SELECT CASE WHEN to_regclass('public.zzz') IS NULL THEN NULL
 *               ELSE (SELECT count(*) FROM zzz) END;   -- ERROR, not NULL
 *
 * That is not a hypothetical: the outbox migration is committed and NOT YET APPLIED to
 * cloud, so on the next deploy this is the live path. The single-statement version made
 * `/api/health` answer 503 "database unreachable" on a database that was perfectly fine —
 * turning the diagnostic into the thing needing diagnosis, which is precisely what this
 * function exists to avoid.
 *
 * A missing table returns **null** (UNKNOWN), never zeros. Zero is the reading an operator
 * stands down on, and it would be false. Same discipline as `DrainResult.parked`.
 *
 * Throws only if the database itself is unreachable; each caller decides what that means
 * (the health route reports `degraded`; the dashboard renders the widget as unavailable).
 */
export async function getQueueHealth(): Promise<QueueHealth | null> {
  const pool = getPool()

  // Statement 1: does the table exist? Names it as a STRING, so nothing is parse-resolved.
  const probe = await pool.query<{ present: boolean }>(
    `SELECT to_regclass('public.outbox') IS NOT NULL AS present`)
  if (!probe.rows[0]?.present) return null

  // Statement 2: only reached once the table is known to exist.
  const { rows } = await pool.query<{
    unprocessed: number; parked: number; oldest: Date | null
  }>(
    `SELECT
       count(*) FILTER (WHERE processed_at IS NULL)::int AS unprocessed,
       count(*) FILTER (WHERE processed_at IS NULL AND attempts >= $1)::int AS parked,
       min(occurred_at) FILTER (WHERE processed_at IS NULL) AS oldest
     FROM outbox`,
    [MAX_ATTEMPTS])

  const row = rows[0]
  if (!row) return null
  return {
    unprocessed: row.unprocessed,
    parked: row.parked,
    oldestUnprocessedAt: row.oldest,
  }
}
