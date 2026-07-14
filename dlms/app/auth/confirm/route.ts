import { type NextRequest, NextResponse } from 'next/server'
import type { EmailOtpType } from '@supabase/supabase-js'
import { createClient } from '@/lib/supabase/server'

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url)
  const tokenHash = searchParams.get('token_hash')
  const type = searchParams.get('type') as EmailOtpType | null

  if (!tokenHash || !type) {
    return NextResponse.redirect(new URL('/login?confirm=invalid', request.url))
  }

  const supabase = createClient()
  const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash })

  if (error) {
    // Email-security scanners routinely open the link and consume the one-time
    // token (error code otp_expired) before the user clicks — an expected case,
    // so surface it as "already used" rather than an error.
    return NextResponse.redirect(new URL('/login?confirm=used', request.url))
  }

  // verifyOtp establishes a session, but DLMS requires an admin to activate the
  // account before login — drop the session so the user must sign in by password.
  await supabase.auth.signOut()
  return NextResponse.redirect(new URL('/login?confirm=success', request.url))
}
