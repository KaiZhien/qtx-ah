import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

// ---------------------------------------------------------------------------
// recordAuthEvent's one contract is that it NEVER throws: a failure to record a
// login must not prevent the login, and a failure to record a denial must not
// turn a 403 into a 500.
//
// Its catch read `(err as Error).message`, which is a cast, not a check. For a
// thrown string or object that silently logged `undefined` as the reason — the
// operator learns a security-trail write was lost but not why. For a thrown
// `null` or `undefined` it threw a TypeError INSIDE the catch block, which
// escapes the function and breaks the contract at exactly the moment it matters:
// the write already failed, and now the login fails too.
// ---------------------------------------------------------------------------

const mockInsert = vi.fn()
const mockFrom = vi.fn(() => ({ insert: mockInsert }))
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({ from: mockFrom }),
}))

const { recordAuthEvent } = await import('@/modules/shared/auth/authEvents')

let errorSpy: ReturnType<typeof vi.spyOn>

beforeEach(() => {
  mockInsert.mockReset().mockResolvedValue({ error: null })
  mockFrom.mockClear()
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { vi.restoreAllMocks() })

const logged = () => JSON.parse(errorSpy.mock.calls[0][0] as string)

describe('recordAuthEvent', () => {
  it('writes the event and logs nothing on the happy path', async () => {
    await recordAuthEvent({ eventType: 'login_success', userId: 'u1', email: 'a@b.c' })
    expect(mockFrom).toHaveBeenCalledWith('auth_event')
    expect(mockInsert).toHaveBeenCalledWith({
      user_id: 'u1', email: 'a@b.c', event_type: 'login_success',
      detail: null, ip_address: null, user_agent: null,
    })
    expect(errorSpy).not.toHaveBeenCalled()
  })

  it('logs the reason when the insert reports an error', async () => {
    mockInsert.mockResolvedValue({ error: { message: 'permission denied for table auth_event' } })
    await expect(recordAuthEvent({ eventType: 'lockout' })).resolves.toBeUndefined()
    expect(logged().err).toContain('permission denied')
    expect(logged().eventType).toBe('lockout')
  })

  it('logs the message of a thrown Error', async () => {
    mockInsert.mockRejectedValue(new Error('connection terminated'))
    await recordAuthEvent({ eventType: 'login_failure' })
    expect(logged().err).toBe('connection terminated')
  })

  it('records a usable reason for a thrown string instead of undefined', async () => {
    mockInsert.mockRejectedValue('ECONNRESET')
    await recordAuthEvent({ eventType: 'permission_denied' })
    expect(logged().err).toBe('ECONNRESET')
  })

  it.each([
    ['null', null, 'null'],
    ['undefined', undefined, 'undefined'],
    // A thrown plain object degrades to '[object Object]'. Accepted: it is what
    // every other error mapper in the app does with one, no worse than the
    // `undefined` it replaces, and no client in this codebase throws one.
    ['a plain object', { code: '42501' }, '[object Object]'],
  ])('survives %s without throwing, and says so', async (_label, thrown, expected) => {
    mockInsert.mockRejectedValue(thrown)
    await recordAuthEvent({ eventType: 'session_revoked' })
    expect(logged().err).toBe(expected)
  })

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('does not itself throw when %s is thrown', async (_label, thrown) => {
    // The whole point of the function. A TypeError raised inside the catch would
    // propagate to the caller — recordAuthEvent is awaited on the login path.
    mockInsert.mockRejectedValue(thrown)
    await expect(recordAuthEvent({ eventType: 'session_revoked' })).resolves.toBeUndefined()
    expect(errorSpy).toHaveBeenCalledTimes(1)
  })

  it('does not throw when the client itself cannot be built', async () => {
    mockFrom.mockImplementation(() => { throw 'no service role key' })
    await expect(recordAuthEvent({ eventType: 'logout' })).resolves.toBeUndefined()
    expect(logged().err).toContain('no service role key')
  })
})
