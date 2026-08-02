import { NextResponse } from 'next/server'
import { getQueueHealth, type QueueHealth } from '@/modules/shared/outbox/services/queueHealth'

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
 * deploy gate. What it may therefore disclose is bounded to what an anonymous caller may
 * safely learn: whether the app is up, whether its database answers, and how many rows are
 * waiting in a queue. No row contents, no identities, no configuration, and no error
 * strings from the database (see below).
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
  /**
   * Queue depth, or null when UNKNOWN — which on this project means the outbox migration
   * is committed but not yet applied. Never zeros in that case: zero is the reading an
   * operator stands down on, and it would be false.
   */
  queue: QueueHealth | null
  checkedAt: string
}

export async function GET() {
  const body: Health = {
    status: 'ok', app: 'ok', database: 'unreachable', queue: null,
    checkedAt: new Date().toISOString(),
  }

  try {
    body.queue = await getQueueHealth()
    // Reached only if the query succeeded, so the ping and the depth are one round trip
    // and cannot report a database that answered one and not the other.
    body.database = 'ok'
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
