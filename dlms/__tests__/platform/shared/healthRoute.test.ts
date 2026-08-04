import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * GET /api/health (spec §13) — app, database ping and queue depth.
 *
 * `middleware.ts`'s PUBLIC_PATHS has listed `/api/health` since it was written, for a route
 * that did not exist. This closes that drift, and the tests below are about the four ways a
 * health check goes wrong: reporting green when the database is unreachable, reporting a
 * queue depth of zero when it does not actually know, reporting the DATABASE as broken when
 * only a table is missing, and staying silent while the drain schedule is dead.
 */

const { getQueueHealth } = vi.hoisted(() => ({ getQueueHealth: vi.fn() }))
vi.mock('@/modules/shared/outbox/services/queueHealth', () => ({ getQueueHealth }))

import { GET } from '@/app/api/health/route'

/** Anonymous caller — the uptime monitor / load balancer / deploy gate. */
const anon = () => new Request('http://localhost/api/health')
/** Operator presenting the shared secret. */
const withSecret = (token: string) =>
  new Request('http://localhost/api/health', { headers: { authorization: `Bearer ${token}` } })

beforeEach(() => { getQueueHealth.mockReset(); process.env.CRON_SECRET = 'test-cron-secret' })
afterEach(() => { vi.restoreAllMocks(); delete process.env.CRON_SECRET })

describe('GET /api/health', () => {
  it('reports ok when the database answers and the queue is moving', async () => {
    getQueueHealth.mockResolvedValue({
      unprocessed: 4, parked: 1, oldestUnprocessedAt: new Date(),
    })
    const res = await GET(anon())
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      status: 'ok', app: 'ok', database: 'ok', queueStatus: 'ok',
    })
  })

  it('is a 503, not a 200, when the database is unreachable', async () => {
    // A monitor that has to parse a body to discover the database is down will eventually
    // be pointed at the status code instead, and find a green one.
    getQueueHealth.mockRejectedValue(new Error('ECONNREFUSED 10.0.0.1:5432'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await GET(anon())
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ status: 'unhealthy', database: 'unreachable' })
  })

  it('never leaks the database error to an UNAUTHENTICATED caller', async () => {
    // This endpoint has no credential by design, and a Postgres error string carries host
    // names, role names and schema details.
    getQueueHealth.mockRejectedValue(new Error('ECONNREFUSED 10.0.0.1:5432 role "qtx_owner"'))
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await GET(anon())
    const body = JSON.stringify(await res.json())
    expect(body).not.toContain('ECONNREFUSED')
    expect(body).not.toContain('qtx_owner')
    // Logged where the operator actually is.
    expect(String(errorLog.mock.calls[0][0])).toContain('ECONNREFUSED')
  })

  it('reports queue UNKNOWN — never zero, and never as a database fault', async () => {
    // The case that actually happens here: the outbox migration is committed but not yet
    // applied to cloud. Reporting `unprocessed: 0` would be a false all-clear, and reporting
    // the whole database as unreachable would turn the diagnostic into the thing needing
    // diagnosis. Same discipline as DrainResult.parked.
    getQueueHealth.mockResolvedValue(null)
    const res = await GET(anon())
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.database).toBe('ok')
    expect(body.status).toBe('ok')
    expect(body.queueStatus).toBe('unknown')
  })

  it('DEGRADES — at 200, not 503 — when the oldest unprocessed event has gone stale', async () => {
    // The dead-schedule detector. Its only symptom is an absence: an unset CRON_SECRET 401s
    // every cron, or Vercel Hobby silently drops the extra entries, and the backlog grows
    // with no task, no notification and no error. Neither COUNT reveals it — only the age.
    getQueueHealth.mockResolvedValue({
      unprocessed: 3, parked: 0,
      oldestUnprocessedAt: new Date(Date.now() - 6 * 60 * 60 * 1000),
    })
    const res = await GET(anon())
    // NOT 503: the app is serving fine. A deploy gate or load balancer keyed on this route
    // must not pull a healthy deployment out of rotation because a cron is misconfigured.
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'degraded', queueStatus: 'stale' })
  })

  it('a small BUT FRESH backlog is not stale', async () => {
    getQueueHealth.mockResolvedValue({
      unprocessed: 3, parked: 0, oldestUnprocessedAt: new Date(Date.now() - 60 * 1000),
    })
    expect(await (await GET(anon())).json()).toMatchObject({ status: 'ok', queueStatus: 'ok' })
  })

  it('withholds the queue COUNTS from an anonymous caller', async () => {
    // Volume and a precise activity timestamp are internal operational detail on a public
    // URL. The verdict is free to publish; the numbers are free to withhold.
    getQueueHealth.mockResolvedValue({
      unprocessed: 42, parked: 7, oldestUnprocessedAt: new Date(),
    })
    const body = await (await GET(anon())).json()
    expect(body.queue).toBeUndefined()
    expect(JSON.stringify(body)).not.toContain('42')
  })

  it('returns the counts to a caller presenting the shared secret', async () => {
    getQueueHealth.mockResolvedValue({
      unprocessed: 42, parked: 7, oldestUnprocessedAt: new Date(),
    })
    const body = await (await GET(withSecret('test-cron-secret'))).json()
    expect(body.queue).toMatchObject({ unprocessed: 42, parked: 7 })
  })

  it('withholds the counts from a WRONG secret', async () => {
    getQueueHealth.mockResolvedValue({
      unprocessed: 42, parked: 7, oldestUnprocessedAt: new Date(),
    })
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const body = await (await GET(withSecret('not-the-secret'))).json()
    expect(body.queue).toBeUndefined()
  })

  it('carries a timestamp so a cached response would be obvious', async () => {
    getQueueHealth.mockResolvedValue({ unprocessed: 0, parked: 0, oldestUnprocessedAt: null })
    const body = await (await GET(anon())).json()
    expect(Date.parse(body.checkedAt)).not.toBeNaN()
  })
})
