import { redirect } from 'next/navigation'
import { getCurrentActor } from '@/modules/shared/auth/session'
import { createClient } from '@/lib/supabase/server'
import { mfaGateStatus, mfaStepFor, type AalLevel } from '@/modules/shared/auth/mfaPolicy'
import { MfaEnrollChallenge } from '@/components/auth/MfaEnrollChallenge'

/**
 * The MFA enrollment/challenge destination. Lives OUTSIDE the (platform) route
 * group so the platform layout's gate never redirects it back to itself. A
 * signed-in but not-yet-AAL2 MFA-required user lands here; everyone else is
 * bounced straight through.
 */
export default async function MfaPage() {
  const actor = await getCurrentActor()
  if (!actor) redirect('/login')

  const supabase = createClient()
  const { data: aal } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
  const currentLevel = (aal?.currentLevel ?? null) as AalLevel | null

  if (mfaGateStatus({ roleKey: actor.roleKey, currentLevel }) === 'satisfied') redirect('/')

  const { data: factors } = await supabase.auth.mfa.listFactors()
  const hasVerifiedFactor = (factors?.totp ?? []).some((f) => f.status === 'verified')
  const step = mfaStepFor({ hasVerifiedFactor, currentLevel })

  // step is 'enroll' | 'challenge' here (never 'done' — that path redirected above).
  return <MfaEnrollChallenge initialStep={step === 'challenge' ? 'challenge' : 'enroll'} />
}
