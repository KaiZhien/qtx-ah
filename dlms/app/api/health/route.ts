import { NextResponse } from 'next/server'
import { getQueueHealth, type QueueHealth } from '@/modules/shared/outbox/services/queueHealth'
import { authorizeSharedSecret, CRON_SECRET_ENV } from '@/modules/shared/outbox/services/cronAuth'

/**
 * GET /api/health — app liveness, a database ping and the outbox queue depth (spec §13).
 *
 * This route is why `middleware.ts`'s PUBLIC_PATHS already contained `/api/health`: the
 * entry has been there since the middleware was written, for a route that did not exist —
 * pre-existing drift recorded in the handoff notes and closed here. (Left as-is, the entry
 * was harmless but misleading: it read as though a health check existed.)
 *
 * THE QUEUE NUMBERS COME FROM getQueueHealth(), NOT FROM A QUERY HERE, and the Admin
 * dashboard's job-queue widget (spec §8.5) calls the same function. Two independent
 * implementations of "how deep is the queue" is precisely how an operator ends up trusting
 * a green health check while the dashboard shows a backlog.
 *
 * UNAUTHENTICATED, on purpose and within limits. A health check that needs a credential
 * cannot be used by the thing that needs it most — an uptime monitor, a load balancer, a
 * deploy gate. What an anonymous caller may safely learn is bounded to whether the app is
 * up, whether its database answers, and a one-word verdict on the queue.
 *
 * THE QUEUE COUNTS ARE BEHIND THE SHARED SECRET. `unprocessed`, `parked` and a precise
 * `oldestUnprocessedAt` are internal operational volume plus an activity timestamp, on a
 * public URL with no credential — free to withhold and worth withholding. Present the
 * CRON_SECRET bearer token and the numbers appear; otherwise `queueStatus` alone says
 * whether anything is wrong. The Admin dashboard is unaffected: it calls getQueueHealth()
 * directly and never touches this route.
 *
 * QUEUE STALENESS IS THE POINT OF THE ENDPOINT, not a nicety. The standing gap on this
 * platform is that NOTHING SCHEDULED THE DRAIN, and its every symptom is an absence: crons
 * fire and 401 on an unset CRON_SECRET, or Vercel Hobby silently drops the extra entries,
 * and the backlog just grows with no task, no notification and no error anywhere. Neither
 * count detects it — a steady `unprocessed: 3` is healthy at 30 seconds old and means the
 * drain died at 30 hours old. Thresholding the oldest unprocessed event makes the dead
 * schedule announce itself on an endpoint monitors already poll, and covers the unset-secret
 * and dropped-cron cases identically.
 *
 * THREE STATES, TWO STATUS CODES, deliberately:
 *   ok         200 — everything answering, queue moving
 *   degraded   200 — the app IS serving; something operational needs a human (a stale queue)
 *   unhealthy  503 — the database did not answer; this instance cannot do its job
 * A stale queue must not 503: the app is serving fine, and a deploy gate or load balancer
 * keyed on this route would take a healthy deployment out of rotation because a cron is
 * misconfigured. It must also not be silent, hence `degraded`.
 */
export const runtime = 'nodejs'

/** Never cached: a cached health check is an actively harmful one. */
export const dynamic = 'force-dynamic'

/**
 * How old the oldest unprocessed event may get before the queue reads as stale.
 *
 * The drain is scheduled every 5 minutes (`vercel.json`), so 30 minutes is six missed runs
 * — comfortably past a transient blip or one slow batch, comfortably short of a shift.
 * Raising it hides a dead schedule for longer; lowering it makes a legitimately slow batch
 * page someone.
 */
const QUEUE_STALE_AFTER_MS = 30 * 60 * 1000

type Health = {
  status: 'ok' | 'degraded' | 'unhealthy'
  app: 'ok'
  database: 'ok' | 'unreachable'
  /**
   * The queue verdict every caller gets, credential or not.
   * `unknown` means the outbox migration is committed but not yet applied — NOT that the
   * queue is empty. Zero is the reading an operator stands down on, and it would be false.
   */
  queueStatus: 'ok' | 'stale' | 'unknown'
  /** Counts, ONLY for a caller presenting the CRON_SECRET bearer token. */
  queue?: QueueHealth | null
  checkedAt: string
}

export async function GET(req: Request) {
  const body: Health = {
    status: 'ok', app: 'ok', database: 'unreachable', queueStatus: 'unknown',
    checkedAt: new Date().toISOString(),
  }

  try {
    const queue = await getQueueHealth()
    // Reached only if the query succeeded, so the ping and the depth are one round trip
    // and cannot report a database that answered one and not the other.
    body.database = 'ok'

    if (queue === null) {
      // Table absent (migration unapplied). NOT an app fault and NOT a 503 — the previous
      // shape reported this as "database unreachable" on a perfectly healthy database.
      body.queueStatus = 'unknown'
    } else {
      const oldest = queue.oldestUnprocessedAt
      const stale = oldest !== null
        && Date.now() - oldest.getTime() > QUEUE_STALE_AFTER_MS
      body.queueStatus = stale ? 'stale' : 'ok'
      if (stale) body.status = 'degraded'
    }

    if (authorizeSharedSecret(req, CRON_SECRET_ENV)) body.queue = queue
  } catch (err) {
    body.status = 'unhealthy'
    // The error is LOGGED, never returned. This endpoint is unauthenticated, and a Postgres
    // error string leaks host names, role names and schema details to anyone who asks.
    console.error(JSON.stringify({
      level: 'error', msg: 'health check could not reach the database',
      err: err instanceof Error ? err.message : String(err),
    }))
  }

  return NextResponse.json(body, { status: body.status === 'unhealthy' ? 503 : 200 })
}
