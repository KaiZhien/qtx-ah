import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildChain, type QueryResult } from './supabaseChainMock'
import type { Actor } from '@/modules/shared/authz/catalog'

const signInWithPassword = vi.fn()
const signOut = vi.fn()
let fromImpl: (table: string) => unknown

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: { signInWithPassword, signOut },
    from: (table: string) => fromImpl(table),
  }),
}))

const resolvePlatformLogin = vi.fn()
vi.mock('@/modules/shared/auth/firstLogin', () => ({
  resolvePlatformLogin: (authUserId: string, email: string) =>
    resolvePlatformLogin(authUserId, email),
}))

const loadActor = vi.fn()
vi.mock('@/modules/shared/authz/actor', () => ({
  loadActor: (authUserId: string) => loadActor(authUserId),
}))

const redirect = vi.fn((url: string): never => {
  throw new Error(`NEXT_REDIRECT:${url}`)
})
vi.mock('next/navigation', () => ({
  redirect: (url: string) => redirect(url),
}))

import { loginAction } from '@/app/login/actions'

const form = (fields: Record<string, string>): FormData => {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  return fd
}

const appUserRow = (row: Record<string, unknown> | null): QueryResult =>
  ({ data: row, error: null })

const actor = (over: Partial<Actor> = {}): Actor => ({
  id: 'app-user-1', roleKey: 'super_admin',
  permissions: new Set(), moduleAccess: new Set(['admin']), active: true,
  ...over,
})

beforeEach(() => {
  signInWithPassword.mockReset()
  signOut.mockReset()
  redirect.mockClear()
  fromImpl = () => buildChain(appUserRow(null))
  // The legacy tests below predate the platform, so the platform lookup has to
  // resolve to "not a platform user" for them to reach the legacy path at all.
  resolvePlatformLogin.mockReset()
  resolvePlatformLogin.mockResolvedValue(null)
  loadActor.mockReset()
})

describe('loginAction', () => {
  it('returns the supabase error message on invalid credentials', async () => {
    signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: 'Invalid login credentials' },
    })
    const result = await loginAction(form({ email: 'a@quantumtx.com', password: 'wrong' }))
    expect(result).toEqual({ error: 'Invalid login credentials' })
    expect(signOut).not.toHaveBeenCalled()
    expect(redirect).not.toHaveBeenCalled()
  })

  it('signs out and returns awaiting-activation when no active app_user row exists', async () => {
    signInWithPassword.mockResolvedValue({
      data: { user: { id: 'user-1' }, session: {} },
      error: null,
    })
    fromImpl = () => buildChain(appUserRow(null))
    const result = await loginAction(form({ email: 'a@quantumtx.com', password: 'right' }))
    expect(signOut).toHaveBeenCalled()
    expect(result?.error).toMatch(/awaiting admin activation/i)
    expect(redirect).not.toHaveBeenCalled()
  })

  it('redirects to /legacy when the app_user row is active', async () => {
    signInWithPassword.mockResolvedValue({
      data: { user: { id: 'user-1' }, session: {} },
      error: null,
    })
    fromImpl = () => buildChain(appUserRow({ id: 'user-1', role: 'engineer', active: true }))
    await expect(
      loginAction(form({ email: 'a@quantumtx.com', password: 'right' })),
    ).rejects.toThrow('NEXT_REDIRECT:/legacy')
    expect(redirect).toHaveBeenCalledWith('/legacy')
    expect(signOut).not.toHaveBeenCalled()
  })
})

/**
 * THE PLATFORM HAD NO WORKING LOGIN AT ALL until these.
 *
 * This one action serves two deployments off two differently-shaped schemas. The
 * legacy DLMS `app_user.id` IS the auth user's id; the platform's is its own uuid
 * with the auth link in `auth_user_id`, and every platform table is RLS-enabled
 * with no policy for `authenticated` — so the legacy read above (anon client,
 * `.eq('id', authUserId)`) can only ever return null on the platform, which sent
 * every platform user, including the seeded bootstrap Super Admin, to
 * "awaiting admin activation" forever.
 *
 * So the platform is resolved FIRST and legacy is the fallback: a platform match
 * decides the outcome, and only a non-match may fall through to a legacy read
 * whose semantics are wrong for platform rows.
 */
describe('loginAction — QTX Operations Platform', () => {
  const signedIn = () =>
    signInWithPassword.mockResolvedValue({
      data: { user: { id: 'auth-1' }, session: {} },
      error: null,
    })

  it('redirects an active, already-linked platform actor to the platform home', async () => {
    signedIn()
    resolvePlatformLogin.mockResolvedValue('app-user-1')
    loadActor.mockResolvedValue(actor())

    await expect(
      loginAction(form({ email: 'reetmitra8@gmail.com', password: 'right' })),
    ).rejects.toThrow('NEXT_REDIRECT:/')
    expect(redirect).toHaveBeenCalledWith('/')
    expect(redirect).not.toHaveBeenCalledWith('/legacy')
    expect(signOut).not.toHaveBeenCalled()
  })

  it('links the app_user row on first login, then redirects to the platform home', async () => {
    signedIn()
    resolvePlatformLogin.mockResolvedValue('app-user-1')
    loadActor.mockResolvedValue(actor())

    await expect(
      loginAction(form({ email: 'Reetmitra8@Gmail.com', password: 'right' })),
    ).rejects.toThrow('NEXT_REDIRECT:/')
    // The email is passed through because it is the ONLY join key an unlinked row
    // has — auth_user_id is still NULL at this point, by definition.
    expect(resolvePlatformLogin).toHaveBeenCalledWith('auth-1', 'Reetmitra8@Gmail.com')
    expect(loadActor).toHaveBeenCalledWith('auth-1')
  })

  it('signs out a linked but DEACTIVATED platform user with the awaiting-activation message', async () => {
    signedIn()
    resolvePlatformLogin.mockResolvedValue('app-user-1')
    loadActor.mockResolvedValue(actor({ active: false }))

    const result = await loginAction(form({ email: 'off@quantumtx.com', password: 'right' }))
    expect(signOut).toHaveBeenCalled()
    expect(result?.error).toMatch(/awaiting admin activation/i)
    expect(redirect).not.toHaveBeenCalled()
  })

  it('signs out when the platform row resolves to no actor at all', async () => {
    signedIn()
    resolvePlatformLogin.mockResolvedValue('app-user-1')
    loadActor.mockResolvedValue(null)

    const result = await loginAction(form({ email: 'ghost@quantumtx.com', password: 'right' }))
    expect(signOut).toHaveBeenCalled()
    expect(result?.error).toMatch(/awaiting admin activation/i)
    expect(redirect).not.toHaveBeenCalled()
  })

  it('falls through to the legacy check when no platform row matches', async () => {
    signedIn()
    resolvePlatformLogin.mockResolvedValue(null)
    fromImpl = () => buildChain(appUserRow({ id: 'auth-1', role: 'engineer', active: true }))

    await expect(
      loginAction(form({ email: 'a@quantumtx.com', password: 'right' })),
    ).rejects.toThrow('NEXT_REDIRECT:/legacy')
    expect(resolvePlatformLogin).toHaveBeenCalledWith('auth-1', 'a@quantumtx.com')
    expect(loadActor).not.toHaveBeenCalled()
    expect(signOut).not.toHaveBeenCalled()
  })

  it('signs out with a generic message, leaking nothing, when the link write fails', async () => {
    signedIn()
    resolvePlatformLogin.mockRejectedValue(
      new Error('connect ECONNREFUSED 10.0.0.4:6543 — db.qtx-ops.supabase.co'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await loginAction(form({ email: 'reetmitra8@gmail.com', password: 'right' }))
    expect(signOut).toHaveBeenCalled()
    expect(result?.error).toBe('Something went wrong — please try again')
    expect(result?.error).not.toMatch(/ECONNREFUSED|supabase\.co/)
    expect(redirect).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })

  it('signs out with the generic message when actor resolution itself fails', async () => {
    signedIn()
    resolvePlatformLogin.mockResolvedValue('app-user-1')
    loadActor.mockRejectedValue(new Error('loadActor failed: permission denied for function'))
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {})

    const result = await loginAction(form({ email: 'reetmitra8@gmail.com', password: 'right' }))
    expect(signOut).toHaveBeenCalled()
    expect(result?.error).toBe('Something went wrong — please try again')
    expect(redirect).not.toHaveBeenCalled()
    consoleError.mockRestore()
  })
})
