import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// The scheduling surface (spec §7.3) — the gap RB-09 recorded as "nothing
// schedules the drain".
//
// Two things had to become true and stay true:
//   1. Vercel Cron can actually drive the drain. It issues GET with
//      `Bearer $CRON_SECRET`; the route was POST-only with its own secret, so a
//      cron entry would have answered 405 forever.
//   2. The POST path and its OUTBOX_DRAIN_SECRET are UNCHANGED, including
//      fail-closed-when-unset. Adding a second door must not widen the first.
// ---------------------------------------------------------------------------

const { drainOutbox } = vi.hoisted(() => ({ drainOutbox: vi.fn() }))
vi.mock('@/modules/shared/outbox/services/outboxService', () => ({ drainOutbox }))

const { sweepTaskReminders } = vi.hoisted(() => ({ sweepTaskReminders: vi.fn() }))
vi.mock('@/modules/shared/notifications/services/reminderService', () => ({ sweepTaskReminders }))

const { expireOverrides } = vi.hoisted(() => ({ expireOverrides: vi.fn() }))
vi.mock('@/modules/shared/outbox/jobs/expireOverrides', () => ({ expireOverrides }))

import { GET as drainGet, POST as drainPost } from '@/app/api/outbox/drain/route'
import { GET as cronGet } from '@/app/api/cron/[job]/route'
import { JOBS } from '@/modules/shared/outbox/jobs/registry'

const DRAIN_SECRET = 'operator-drain-secret'
const CRON_SECRET = 'vercel-cron-secret'
const RESULT = {
  claimed: 1, processed: 1, failed: 0, failures: [], parked: 0, emailed: 0, notified: 2,
}

const req = (url: string, method: string, authorization?: string): NextRequest =>
  new NextRequest(`http://localhost:3001${url}`, {
    method,
    headers: authorization === undefined ? {} : { authorization },
  })

let errorLog: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  drainOutbox.mockReset().mockResolvedValue(RESULT)
  sweepTaskReminders.mockReset().mockResolvedValue({ scanned: 0, due: 0, created: 0, emailed: 0 })
  expireOverrides.mockReset().mockResolvedValue({ expired: 0 })
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
  vi.spyOn(console, 'info').mockImplementation(() => {})
  process.env.OUTBOX_DRAIN_SECRET = DRAIN_SECRET
  process.env.CRON_SECRET = CRON_SECRET
})

afterEach(() => {
  vi.restoreAllMocks()
  delete process.env.OUTBOX_DRAIN_SECRET
  delete process.env.CRON_SECRET
})

describe('GET /api/outbox/drain — the Vercel Cron entry point', () => {
  it('drains on the correct CRON_SECRET', async () => {
    const res = await drainGet(req('/api/outbox/drain', 'GET', `Bearer ${CRON_SECRET}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(RESULT)
    expect(drainOutbox).toHaveBeenCalledTimes(1)
  })

  it('refuses EVERY request when CRON_SECRET is unset, and does not drain', async () => {
    // The property the whole slice turns on: a second entry point must inherit
    // fail-closed, not quietly default open because it was added later.
    delete process.env.CRON_SECRET
    const res = await drainGet(req('/api/outbox/drain', 'GET', `Bearer ${CRON_SECRET}`))
    expect(res.status).toBe(401)
    expect(drainOutbox).not.toHaveBeenCalled()
    expect(String(errorLog.mock.calls[0][0])).toContain('CRON_SECRET is not set')
  })

  it('treats an empty CRON_SECRET as unset', async () => {
    process.env.CRON_SECRET = ''
    const res = await drainGet(req('/api/outbox/drain', 'GET', 'Bearer '))
    expect(res.status).toBe(401)
    expect(drainOutbox).not.toHaveBeenCalled()
  })

  it('refuses a wrong secret of a different length without throwing', async () => {
    const res = await drainGet(req('/api/outbox/drain', 'GET', 'Bearer x'))
    expect(res.status).toBe(401)
    expect(drainOutbox).not.toHaveBeenCalled()
  })

  it('does NOT accept the drain secret — the two credentials stay separate', async () => {
    // Collapsing them would mean rotating one silently rotated the other's blast radius.
    const res = await drainGet(req('/api/outbox/drain', 'GET', `Bearer ${DRAIN_SECRET}`))
    expect(res.status).toBe(401)
    expect(drainOutbox).not.toHaveBeenCalled()
  })

  it('does NOT let the cron secret through the POST path either', async () => {
    const res = await drainPost(req('/api/outbox/drain', 'POST', `Bearer ${CRON_SECRET}`))
    expect(res.status).toBe(401)
    expect(drainOutbox).not.toHaveBeenCalled()
  })

  it('still refuses POST when OUTBOX_DRAIN_SECRET is unset, even with CRON_SECRET set', async () => {
    delete process.env.OUTBOX_DRAIN_SECRET
    const res = await drainPost(req('/api/outbox/drain', 'POST', `Bearer ${DRAIN_SECRET}`))
    expect(res.status).toBe(401)
    expect(drainOutbox).not.toHaveBeenCalled()
  })
})

describe('the ?limit= operator control', () => {
  // RB-09 advises "use a bigger limit" for a backlog; before this there was no way to.
  it('passes a valid limit through to the drain', async () => {
    await drainGet(req('/api/outbox/drain?limit=500', 'GET', `Bearer ${CRON_SECRET}`))
    expect(drainOutbox).toHaveBeenCalledWith({ limit: 500 })
  })

  it('works on the POST path too', async () => {
    await drainPost(req('/api/outbox/drain?limit=250', 'POST', `Bearer ${DRAIN_SECRET}`))
    expect(drainOutbox).toHaveBeenCalledWith({ limit: 250 })
  })

  it('defaults when absent', async () => {
    await drainGet(req('/api/outbox/drain', 'GET', `Bearer ${CRON_SECRET}`))
    expect(drainOutbox).toHaveBeenCalledWith({})
  })

  it.each(['0', '-5', 'abc', '1e9', '99999', '1.5'])(
    'IGNORES the junk limit %s and still drains', async (raw) => {
      // Deliberately not a 400: failing a scheduled drain over a malformed query string
      // would stop the handoffs to protect a preference.
      const res = await drainGet(
        req(`/api/outbox/drain?limit=${raw}`, 'GET', `Bearer ${CRON_SECRET}`))
      expect(res.status).toBe(200)
      expect(drainOutbox).toHaveBeenCalledWith({})
    })
})

describe('GET /api/cron/[job] — the scheduled-job runner', () => {
  it('runs a registered job on the correct secret', async () => {
    const res = await cronGet(
      req('/api/cron/task-reminders', 'GET', `Bearer ${CRON_SECRET}`),
      { params: { job: 'task-reminders' } })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ job: 'task-reminders' })
    expect(sweepTaskReminders).toHaveBeenCalledTimes(1)
  })

  it('runs the override-expiry job', async () => {
    const res = await cronGet(
      req('/api/cron/expire-overrides', 'GET', `Bearer ${CRON_SECRET}`),
      { params: { job: 'expire-overrides' } })
    expect(res.status).toBe(200)
    expect(expireOverrides).toHaveBeenCalledTimes(1)
  })

  it('refuses every request when CRON_SECRET is unset, and runs nothing', async () => {
    delete process.env.CRON_SECRET
    const res = await cronGet(
      req('/api/cron/task-reminders', 'GET', `Bearer ${CRON_SECRET}`),
      { params: { job: 'task-reminders' } })
    expect(res.status).toBe(401)
    expect(sweepTaskReminders).not.toHaveBeenCalled()
  })

  it('checks the secret BEFORE the job lookup, so jobs cannot be enumerated', async () => {
    // An unauthenticated 404-vs-401 difference would list which jobs exist.
    const res = await cronGet(
      req('/api/cron/no-such-job', 'GET', 'Bearer wrong'),
      { params: { job: 'no-such-job' } })
    expect(res.status).toBe(401)
  })

  it('404s an unknown job for an AUTHENTICATED caller, naming the known ones', async () => {
    const res = await cronGet(
      req('/api/cron/no-such-job', 'GET', `Bearer ${CRON_SECRET}`),
      { params: { job: 'no-such-job' } })
    expect(res.status).toBe(404)
    expect((await res.json()).known).toEqual(JOBS.map((j) => j.name))
  })

  it('500s when a job throws', async () => {
    sweepTaskReminders.mockRejectedValue(new Error('principal missing'))
    const res = await cronGet(
      req('/api/cron/task-reminders', 'GET', `Bearer ${CRON_SECRET}`),
      { params: { job: 'task-reminders' } })
    expect(res.status).toBe(500)
    expect(await res.json()).toMatchObject({ error: 'principal missing' })
  })
})

// ---------------------------------------------------------------------------
// Convention pins: facts about the source, not behaviours. Same genre as the
// PUBLIC_PATHS pin in outboxDrainRoute.test.ts — every test above calls the
// handler directly, so all of them stay green while the endpoint is dead in
// production.
// ---------------------------------------------------------------------------

const dlmsRoot = join(__dirname, '..', '..', '..')

describe('middleware PUBLIC_PATHS', () => {
  const source = readFileSync(join(dlmsRoot, 'middleware.ts'), 'utf8')
  const declaration = /const PUBLIC_PATHS = \[([^\]]*)\]/.exec(source)
  const entries = declaration![1].split(',')
    .map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean)

  it.each(['/api/cron', '/api/health', '/api/outbox/drain'])(
    'lists %s, so the session gate does not 307 it to /login', (path) => {
      expect(entries).toContain(path)
    })
})

describe('vercel.json cron entries', () => {
  const vercel = JSON.parse(readFileSync(join(dlmsRoot, 'vercel.json'), 'utf8')) as {
    crons?: { path: string; schedule: string }[]
  }

  it('exists and declares crons — without them NOTHING schedules the drain', () => {
    expect(vercel.crons?.length).toBeGreaterThan(0)
  })

  it('schedules the drain', () => {
    expect(vercel.crons!.map((c) => c.path)).toContain('/api/outbox/drain')
  })

  /**
   * The drift pin that matters. Vercel reads its schedule from vercel.json and the pg-boss
   * worker reads it from the registry; nothing but this test stops the two describing
   * different cadences, and the symptom would be a job that runs at the wrong time on one
   * deployment only.
   */
  it('matches the job registry, path for path and schedule for schedule', () => {
    const byPath = new Map(vercel.crons!.map((c) => [c.path, c.schedule]))
    for (const job of JOBS) {
      const path = job.name === 'outbox-drain' ? '/api/outbox/drain' : `/api/cron/${job.name}`
      expect(byPath.get(path), `no vercel.json cron for job ${job.name}`).toBe(job.schedule)
    }
    expect(byPath.size).toBe(JOBS.length)
  })
})
