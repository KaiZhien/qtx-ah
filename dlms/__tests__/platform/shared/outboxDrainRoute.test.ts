import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { NextRequest } from 'next/server'

// ---------------------------------------------------------------------------
// POST /api/outbox/drain — the drain's only HTTP entry point (spec §5.5,
// docs/runbooks/RB-09-outbox-drain.md).
//
// The drain itself is covered end to end by __tests__/integration/outboxService
// .test.ts against real Postgres. Nothing covered the ROUTE: its shared-secret
// gate is the whole authentication (there is no session here — the automation
// principal has no login path by construction), and the branch that matters most
// is the one that is hardest to notice going wrong. An unset OUTBOX_DRAIN_SECRET
// must REFUSE; the tempting alternative — "no secret configured, so no
// authentication required" — turns a forgotten environment variable into a
// publicly drainable endpoint, and a deployment that silently works without its
// credential is one nobody notices is missing.
//
// The service is mocked, not exercised: this file is about the gate. Mocking it
// also keeps the pg pool out of a unit-test process.
// ---------------------------------------------------------------------------

// vi.hoisted, not a bare const: vi.mock is hoisted above every top-level
// binding, and this factory names the spy directly (rather than reaching it
// through a lazy closure the way authConfirm.test.ts does), so the spy has to be
// created in the hoisted scope too.
const { drainOutbox } = vi.hoisted(() => ({ drainOutbox: vi.fn() }))
vi.mock('@/modules/shared/outbox/services/outboxService', () => ({ drainOutbox }))

import { POST } from '@/app/api/outbox/drain/route'

const SECRET = 'correct-horse-battery-staple'
const RESULT = { claimed: 3, processed: 3, failed: 0, failures: [], parked: 0 }

const post = (authorization?: string): NextRequest =>
  new NextRequest('http://localhost:3001/api/outbox/drain', {
    method: 'POST',
    headers: authorization === undefined ? {} : { authorization },
  })

let errorLog: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  drainOutbox.mockReset().mockResolvedValue(RESULT)
  // console.error is where the unset-secret misconfiguration is reported, so it
  // is asserted on below rather than merely silenced.
  errorLog = vi.spyOn(console, 'error').mockImplementation(() => {})
  process.env.OUTBOX_DRAIN_SECRET = SECRET
})

afterEach(() => {
  errorLog.mockRestore()
  delete process.env.OUTBOX_DRAIN_SECRET
})

describe('POST /api/outbox/drain — the shared-secret gate', () => {
  it('refuses every request when OUTBOX_DRAIN_SECRET is unset, and does not drain', async () => {
    delete process.env.OUTBOX_DRAIN_SECRET

    // Even a caller presenting a plausible token gets nothing: with no expected
    // value there is nothing to be right about.
    const res = await POST(post(`Bearer ${SECRET}`))

    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
    expect(drainOutbox).not.toHaveBeenCalled()

    // The misconfiguration is reported where the operator actually is — the
    // server's log stream — because the 401 body deliberately cannot say it.
    expect(errorLog).toHaveBeenCalledTimes(1)
    expect(String(errorLog.mock.calls[0][0])).toContain('OUTBOX_DRAIN_SECRET is not set')
  })

  it('treats an empty OUTBOX_DRAIN_SECRET as unset, not as a secret to match', async () => {
    process.env.OUTBOX_DRAIN_SECRET = ''
    const res = await POST(post('Bearer '))
    expect(res.status).toBe(401)
    expect(drainOutbox).not.toHaveBeenCalled()
  })

  it('refuses a wrong secret, and does not drain', async () => {
    const res = await POST(post('Bearer wrong-secret'))
    expect(res.status).toBe(401)
    expect(await res.json()).toEqual({ error: 'Unauthorized' })
    expect(drainOutbox).not.toHaveBeenCalled()
  })

  /**
   * The comparison SHA-256s both sides first precisely so a length mismatch is
   * an ordinary 401 rather than timingSafeEqual's differing-length THROW (which
   * would surface as a 500 and leak the expected secret's length).
   */
  it('refuses a wrong secret of a different length without throwing', async () => {
    const res = await POST(post('Bearer x'))
    expect(res.status).toBe(401)
    expect(drainOutbox).not.toHaveBeenCalled()
  })

  it.each([
    ['no Authorization header at all', undefined],
    ['a non-Bearer scheme', 'Basic dXNlcjpwYXNz'],
    ['a Bearer scheme with an empty token', 'Bearer '],
  ])('refuses %s, and does not drain', async (_label, header) => {
    const res = await POST(post(header))
    expect(res.status).toBe(401)
    expect(drainOutbox).not.toHaveBeenCalled()
  })

  it('runs the drain and returns its result on the correct secret', async () => {
    const res = await POST(post(`Bearer ${SECRET}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual(RESULT)
    expect(drainOutbox).toHaveBeenCalledTimes(1)
  })

  /** RFC 7235 makes the scheme case-insensitive; the route matches it that way. */
  it('accepts the correct secret under a lower-case scheme', async () => {
    const res = await POST(post(`bearer ${SECRET}`))
    expect(res.status).toBe(200)
    expect(drainOutbox).toHaveBeenCalledTimes(1)
  })

  /**
   * A poison EVENT is a 200 with `failed`/`failures` in the body — the drain
   * that recorded it did its job, and failing the response would make a
   * scheduler retry the whole batch over one bad row. `parked: null` means
   * UNKNOWN and must reach the client as JSON null, never as 0.
   */
  it('returns 200 with the failures in the body when events failed', async () => {
    drainOutbox.mockResolvedValue({
      claimed: 2, processed: 1, failed: 1,
      failures: [{ outboxId: 'abc', error: 'No handoff template registered' }],
      parked: null,
    })
    const res = await POST(post(`Bearer ${SECRET}`))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ failed: 1, parked: null })
  })

  /** 500 is reserved for the drain throwing: an unresolvable automation principal. */
  it('returns 500 with the message when the drain throws', async () => {
    drainOutbox.mockRejectedValue(new Error('The outbox automation principal does not exist'))
    const res = await POST(post(`Bearer ${SECRET}`))
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({
      error: 'The outbox automation principal does not exist',
    })
  })
})

// ---------------------------------------------------------------------------
// Convention pin, same genre as actionAalPinning.test.ts and the
// *.clientSelection.test.ts files: a fact about the source, not a behaviour.
//
// Every test above runs the handler directly, so all of them stay green if the
// middleware entry disappears — and in production the request would then never
// reach the handler at all: the session gate answers it with a 307 to /login,
// because the drain's callers (a cron, a scheduler, an operator with curl) have
// no Supabase session by design. That is a fully-green suite with a dead
// endpoint, which is exactly what this pin exists to prevent.
// ---------------------------------------------------------------------------
describe('middleware PUBLIC_PATHS', () => {
  const source = readFileSync(join(__dirname, '..', '..', '..', 'middleware.ts'), 'utf8')
  const declaration = /const PUBLIC_PATHS = \[([^\]]*)\]/.exec(source)

  it('still declares a PUBLIC_PATHS array (the scan below is not vacuous)', () => {
    expect(declaration, `PUBLIC_PATHS not found in middleware.ts:\n${source}`).not.toBeNull()
  })

  it('lists /api/outbox/drain, so the session gate does not 307 it to /login', () => {
    const entries = declaration![1]
      .split(',')
      .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean)
    expect(entries).toContain('/api/outbox/drain')
  })
})
