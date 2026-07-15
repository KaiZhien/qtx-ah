import { describe, it, expect, beforeEach, vi } from 'vitest'

// signUpAction has NO getCurrentUser / can() gate — it is a pre-auth registration
// action. It reads a domain allowlist and drives Supabase Auth + a service-role insert.
const signUp = vi.fn()
const insert = vi.fn()
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { signUp: (...a: unknown[]) => signUp(...a) } }),
  createAdminClient: () => ({ from: () => ({ insert: (...a: unknown[]) => insert(...a) }) }),
}))

import { signUpAction } from '@/app/signup/actions'

const form = (fields: Record<string, string>): FormData => {
  const fd = new FormData()
  for (const [k, v] of Object.entries(fields)) fd.set(k, v)
  return fd
}

beforeEach(() => {
  signUp.mockReset()
  insert.mockReset()
})

// Error convention: RESULT ({ error } | { success, needsConfirmation }); never throws.

describe('signUpAction', () => {
  it('rejects non-@quantumtx.com addresses before touching Supabase', async () => {
    const out = await signUpAction(form({ email: 'a@gmail.com', password: 'pw' }))
    expect(out).toEqual({ error: 'Sign-up is restricted to @quantumtx.com email addresses.' })
    expect(signUp).not.toHaveBeenCalled()
  })

  it('normalizes email (trim + lowercase) before the domain check and signUp', async () => {
    signUp.mockResolvedValue({ data: { user: null }, error: null })
    await signUpAction(form({ email: '  Alice@Quantumtx.COM ', password: 'pw' }))
    expect(signUp).toHaveBeenCalledWith({ email: 'alice@quantumtx.com', password: 'pw' })
  })

  it('surfaces the Supabase auth error message', async () => {
    signUp.mockResolvedValue({ data: { user: null }, error: { message: 'User already registered' } })
    const out = await signUpAction(form({ email: 'a@quantumtx.com', password: 'pw' }))
    expect(out).toEqual({ error: 'User already registered' })
    expect(insert).not.toHaveBeenCalled()
  })

  it('inserts an inactive engineer app_user row on successful signUp', async () => {
    signUp.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null })
    insert.mockResolvedValue({ error: null })
    const out = await signUpAction(form({ email: 'a@quantumtx.com', password: 'pw' }))
    expect(insert).toHaveBeenCalledWith({
      id: 'auth-1',
      email: 'a@quantumtx.com',
      role: 'engineer',
      active: false,
    })
    expect(out).toEqual({ success: true, needsConfirmation: true })
  })

  it('returns the profile-setup error when the app_user insert fails', async () => {
    signUp.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null })
    insert.mockResolvedValue({ error: { message: 'db down' } })
    const out = await signUpAction(form({ email: 'a@quantumtx.com', password: 'pw' }))
    expect(out).toEqual({ error: 'Account created but profile setup failed. Contact an admin.' })
  })
})
