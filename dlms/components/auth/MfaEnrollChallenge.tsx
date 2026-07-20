'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { createBrowserClient } from '@/lib/supabase/client'
import { markMfaEnrolledAction } from '@/app/mfa/actions'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card'

/** Wrong/expired codes are the common case; anything else gets a generic line. */
function friendly(message: string): string {
  if (/invalid|verification|code/i.test(message)) return 'That code was not accepted. Try the current 6-digit code.'
  return 'Something went wrong with two-factor setup. Refresh and try again.'
}

export function MfaEnrollChallenge({ initialStep }: { initialStep: 'enroll' | 'challenge' }) {
  const router = useRouter()
  const [supabase] = useState(() => createBrowserClient())
  const step = initialStep
  const [factorId, setFactorId] = useState<string | null>(null)
  const [challengeId, setChallengeId] = useState<string | null>(null)
  const [qr, setQr] = useState<string | null>(null)
  const [secret, setSecret] = useState<string | null>(null)
  const [code, setCode] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Enroll: create a new TOTP factor and show its QR. Challenge: find the
  // verified factor and open a challenge. Runs once on mount.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      setError(null)
      if (step === 'enroll') {
        const { data, error } = await supabase.auth.mfa.enroll({ factorType: 'totp' })
        if (cancelled) return
        if (error) { setError(friendly(error.message)); return }
        setFactorId(data.id); setQr(data.totp.qr_code); setSecret(data.totp.secret)
      } else {
        const { data: list, error: le } = await supabase.auth.mfa.listFactors()
        if (cancelled) return
        if (le) { setError(friendly(le.message)); return }
        const totp = list.totp?.find((f) => f.status === 'verified') ?? list.totp?.[0]
        if (!totp) { setError('No authenticator is set up. Ask an admin to reset your MFA.'); return }
        setFactorId(totp.id)
        const { data: ch, error: ce } = await supabase.auth.mfa.challenge({ factorId: totp.id })
        if (cancelled) return
        if (ce) { setError(friendly(ce.message)); return }
        setChallengeId(ch.id)
      }
    })()
    return () => { cancelled = true }
  }, [step, supabase])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    if (!factorId) return
    setBusy(true); setError(null)
    try {
      // Enroll has no challenge yet; issue one now. Challenge pre-issued on mount.
      let chId = challengeId
      if (!chId) {
        const { data: ch, error: ce } = await supabase.auth.mfa.challenge({ factorId })
        if (ce) { setError(friendly(ce.message)); return }
        chId = ch.id
      }
      const { error: ve } = await supabase.auth.mfa.verify({ factorId, challengeId: chId, code: code.trim() })
      if (ve) { setError(friendly(ve.message)); setChallengeId(null); setCode(''); return } // consumed → re-challenge next submit
      await markMfaEnrolledAction()
      router.push('/'); router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader className="text-center">
          <CardTitle>{step === 'enroll' ? 'Set up two-factor authentication' : 'Enter your authentication code'}</CardTitle>
          <p className="text-sm text-muted-foreground">
            {step === 'enroll'
              ? 'Your role requires an authenticator app. Scan the code, then enter the 6-digit code to finish.'
              : 'Open your authenticator app and enter the current 6-digit code.'}
          </p>
        </CardHeader>
        <CardContent>
          {error && <p className="mb-4 text-sm text-destructive">{error}</p>}
          {step === 'enroll' && qr && (
            <div className="mb-4 flex flex-col items-center gap-2">
              {/* Supabase returns the QR as an SVG data-URI; safe to render as an image src. */}
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={qr} alt="Authenticator QR code" className="h-44 w-44" />
              {secret && <p className="font-mono text-xs text-muted-foreground break-all">Or enter manually: {secret}</p>}
            </div>
          )}
          <form onSubmit={submit} className="space-y-4">
            <div className="space-y-1">
              <Label htmlFor="mfa-code">6-digit code</Label>
              <Input
                id="mfa-code" inputMode="numeric" autoComplete="one-time-code" pattern="[0-9]*"
                maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required
              />
            </div>
            <Button type="submit" className="w-full" disabled={busy || code.trim().length < 6 || !factorId}>
              {busy ? 'Verifying…' : step === 'enroll' ? 'Verify and continue' : 'Verify'}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}
