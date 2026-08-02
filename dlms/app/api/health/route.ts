import { NextResponse } from 'next/server'
import { getPool } from '@/lib/db/pool'

/**
 * GET /api/health — app liveness, a database ping and the outbox queue depth (spec §13).
 *
 * This route is why `middleware.ts`'s PUBLIC_PATHS already contained `/api/health`: the
 * entry has been there since the middleware was written, for a route that did not exist —
 * pre-existing drift recorded in the handoff notes and closed here. (Left as-is, the entry
 * was harmless but misleading: it read as though a health check existed.)
 *
 * UNAUTHENTICATED, on purpose and within limits. A health check that needs a credential
 * cannot be used by the thing that needs it most — an uptime monitor, a load balancer, a
 * deploy gate. What it may therefore disclose is bounded to what an anonymous caller may
 * safely learn: whether the app is up, whether its database answers, and HOW MANY rows are
 * waiting in a queue. No row contents, no identities, no configuration, no error strings
 * from the database (see below).
 *
 * DEGRADED IS A 503, NOT A 200. The point of the endpoint is to be machine-read: a monitor
 * that has to parse a body to discover the database is down will eventually be pointed at
 * the status code instead, and find a green one.
 */
export const runtime = 'nodejs'

/** Never cached: a cached health check is an actively harmful one. */
export const dynamic = 'force-dynamic'

type Health = {
  status: 'ok' | 'degraded'
  app: 'ok'
  database: 'ok' | 'unreachable'
  /** Unprocessed outbox rows, and how many of those are parked. Null when unknown. */
  queue: { pending: number; parked: number } | null
  checkedAt: string
}

export async function GET() {
  const body: Health = {
    status: 'ok', app: 'ok', database: 'unreachable', queue: null,
    checkedAt: new Date().toISOString(),
  }

  try {
    // One round trip for the ping AND the depth. A second query would double the cost of an
    // endpoint that gets polled every few seconds, and could report a database that answered
    // the first and not the second.
    //
    // `to_regclass` guards the case that actually happens on this project: the outbox
    // migration is committed but NOT YET APPLIED to cloud (four migrations sit unapplied).
    // Querying `outbox` directly would make /api/health report the whole database as
    // unreachable on a deployment whose database is perfectly fine — turning the diagnostic
    // into the thing that needs diagnosing.
    const { rows } = await getPool().query<{ pending: number | null; parked: number | null }>(
      `SELECT
         CASE WHEN to_regclass('public.outbox') IS NULL THEN NULL ELSE
           (SELECT count(*)::int FROM outbox WHERE processed_at IS NULL) END AS pending,
         CASE WHEN to_regclass('public.outbox') IS NULL THEN NULL ELSE
           (SELECT count(*)::int FROM outbox WHERE processed_at IS NULL AND attempts >= 5) END
           AS parked`)

    body.database = 'ok'
    const row = rows[0]
    // A missing outbox table leaves `queue: null` — UNKNOWN, not zero. Same discipline as
    // DrainResult.parked: zero is the reading an operator stands down on, and it would be
    // false here.
    if (row?.pending !== null && row?.pending !== undefined
        && row?.parked !== null && row?.parked !== undefined) {
      body.queue = { pending: row.pending, parked: row.parked }
    }
  } catch (err) {
    body.status = 'degraded'
    // The error is LOGGED, never returned. This endpoint is unauthenticated, and a Postgres
    // error string leaks host names, role names and schema details to anyone who asks.
    console.error(JSON.stringify({
      level: 'error', msg: 'health check could not reach the database',
      err: err instanceof Error ? err.message : String(err),
    }))
  }

  return NextResponse.json(body, { status: body.status === 'ok' ? 200 : 503 })
}
