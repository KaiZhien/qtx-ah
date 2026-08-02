import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

/**
 * GET /api/health (spec §13) — app, database ping and queue depth.
 *
 * `middleware.ts`'s PUBLIC_PATHS has listed `/api/health` since it was written, for a route
 * that did not exist. This closes that drift, and the tests below are about the two ways a
 * health check goes wrong: reporting green when the database is unreachable, and reporting
 * a queue depth of zero when it does not actually know.
 */

const { query } = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('@/lib/db/pool', () => ({ getPool: () => ({ query }) }))

import { GET } from '@/app/api/health/route'

beforeEach(() => { query.mockReset() })
afterEach(() => { vi.restoreAllMocks() })

describe('GET /api/health', () => {
  it('reports ok with the queue depth when the database answers', async () => {
    query.mockResolvedValue({ rows: [{ pending: 4, parked: 1 }] })
    const res = await GET()
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      status: 'ok', app: 'ok', database: 'ok', queue: { pending: 4, parked: 1 },
    })
  })

  it('is a 503, not a 200, when the database is unreachable', async () => {
    // A monitor that has to parse a body to discover the database is down will eventually
    // be pointed at the status code instead, and find a green one.
    query.mockRejectedValue(new Error('ECONNREFUSED 10.0.0.1:5432'))
    vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await GET()
    expect(res.status).toBe(503)
    expect(await res.json()).toMatchObject({ status: 'degraded', database: 'unreachable' })
  })

  it('never leaks the database error to an UNAUTHENTICATED caller', async () => {
    // This endpoint has no credential by design, and a Postgres error string carries host
    // names, role names and schema details.
    query.mockRejectedValue(new Error('ECONNREFUSED 10.0.0.1:5432 role "qtx_owner"'))
    const errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
    const res = await GET()
    const body = JSON.stringify(await res.json())
    expect(body).not.toContain('ECONNREFUSED')
    expect(body).not.toContain('qtx_owner')
    // Logged where the operator actually is.
    expect(String(errorLog.mock.calls[0][0])).toContain('ECONNREFUSED')
  })

  it('reports queue UNKNOWN (null) — never zero — when the outbox table is absent', async () => {
    // The case that actually happens here: the outbox migration is committed but not yet
    // applied to cloud. Reporting `pending: 0` would be a false all-clear, and reporting the
    // whole database as unreachable would turn the diagnostic into the thing needing
    // diagnosis. Same discipline as DrainResult.parked.
    query.mockResolvedValue({ rows: [{ pending: null, parked: null }] })
    const res = await GET()
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.database).toBe('ok')
    expect(body.queue).toBeNull()
  })

  it('carries a timestamp so a cached response would be obvious', async () => {
    query.mockResolvedValue({ rows: [{ pending: 0, parked: 0 }] })
    const body = await (await GET()).json()
    expect(Date.parse(body.checkedAt)).not.toBeNaN()
  })
})
