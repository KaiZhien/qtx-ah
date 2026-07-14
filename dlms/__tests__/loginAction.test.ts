import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildChain, type QueryResult } from './supabaseChainMock'

const signInWithPassword = vi.fn()
const signOut = vi.fn()
let fromImpl: (table: string) => unknown

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: { signInWithPassword, signOut },
    from: (table: string) => fromImpl(table),
  }),
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

beforeEach(() => {
  signInWithPassword.mockReset()
  signOut.mockReset()
  redirect.mockClear()
  fromImpl = () => buildChain(appUserRow(null))
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

  it('redirects to / when the app_user row is active', async () => {
    signInWithPassword.mockResolvedValue({
      data: { user: { id: 'user-1' }, session: {} },
      error: null,
    })
    fromImpl = () => buildChain(appUserRow({ id: 'user-1', role: 'engineer', active: true }))
    await expect(
      loginAction(form({ email: 'a@quantumtx.com', password: 'right' })),
    ).rejects.toThrow('NEXT_REDIRECT:/')
    expect(redirect).toHaveBeenCalledWith('/')
    expect(signOut).not.toHaveBeenCalled()
  })
})
