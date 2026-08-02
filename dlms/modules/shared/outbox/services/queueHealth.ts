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
 * Reads all three in ONE round trip.
 *
 * `to_regclass` guards the case that actually happens on this project: the outbox
 * migration is committed but not yet applied to cloud. Querying `outbox` directly would
 * make both consumers report a hard failure on a deployment whose database is perfectly
 * fine — so a missing table returns **null** (UNKNOWN), never zeros. Zero is the reading
 * an operator stands down on, and it would be false. Same discipline as
 * `DrainResult.parked`.
 *
 * Throws only if the database itself is unreachable; each caller decides what that means
 * (the health route reports `degraded`; the dashboard renders the widget as unavailable).
 */
export async function getQueueHealth(): Promise<QueueHealth | null> {
  const { rows } = await getPool().query<{
    unprocessed: number | null; parked: number | null; oldest: Date | null
  }>(
    `SELECT
       CASE WHEN to_regclass('public.outbox') IS NULL THEN NULL ELSE
         (SELECT count(*)::int FROM outbox WHERE processed_at IS NULL) END AS unprocessed,
       CASE WHEN to_regclass('public.outbox') IS NULL THEN NULL ELSE
         (SELECT count(*)::int FROM outbox
           WHERE processed_at IS NULL AND attempts >= $1) END AS parked,
       CASE WHEN to_regclass('public.outbox') IS NULL THEN NULL ELSE
         (SELECT min(occurred_at) FROM outbox WHERE processed_at IS NULL) END AS oldest`,
    [MAX_ATTEMPTS])

  const row = rows[0]
  if (!row || row.unprocessed === null || row.parked === null) return null
  return {
    unprocessed: row.unprocessed,
    parked: row.parked,
    oldestUnprocessedAt: row.oldest,
  }
}
