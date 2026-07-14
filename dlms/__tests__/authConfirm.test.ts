import { describe, it, expect, beforeEach, vi } from 'vitest'
import { NextRequest } from 'next/server'

const verifyOtp = vi.fn()
const signOut = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { verifyOtp, signOut } }),
}))

import { GET } from '@/app/auth/confirm/route'

const req = (qs: string): NextRequest =>
  new NextRequest(`http://localhost:3001/auth/confirm${qs}`)

beforeEach(() => {
  verifyOtp.mockReset()
  signOut.mockReset()
})

describe('GET /auth/confirm', () => {
  it('redirects to /login?confirm=invalid when token_hash is missing (no verify)', async () => {
    const res = await GET(req('?type=email'))
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('/login?confirm=invalid')
    expect(verifyOtp).not.toHaveBeenCalled()
  })

  it('redirects to /login?confirm=invalid when type is missing (no verify)', async () => {
    const res = await GET(req('?token_hash=abc'))
    expect(res.headers.get('location')).toContain('/login?confirm=invalid')
    expect(verifyOtp).not.toHaveBeenCalled()
  })

  it('on success: verifies OTP, signs out, then redirects to /login?confirm=success', async () => {
    verifyOtp.mockResolvedValue({ error: null })
    const res = await GET(req('?token_hash=abc&type=email'))
    expect(verifyOtp).toHaveBeenCalledWith({ type: 'email', token_hash: 'abc' })
    expect(signOut).toHaveBeenCalled()
    expect(res.status).toBe(307)
    expect(res.headers.get('location')).toContain('/login?confirm=success')
  })

  it('on error (scanner already consumed the token): redirects to /login?confirm=used', async () => {
    verifyOtp.mockResolvedValue({ error: { message: 'Token has expired or is invalid', code: 'otp_expired' } })
    const res = await GET(req('?token_hash=abc&type=email'))
    expect(signOut).not.toHaveBeenCalled()
    expect(res.headers.get('location')).toContain('/login?confirm=used')
  })
})
