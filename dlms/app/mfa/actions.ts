'use server'

import { requireActor } from '@/modules/shared/auth/session'
import { createClient } from '@/lib/supabase/server'
import { withTransaction } from '@/lib/db/tx'
import { recordAuthEvent } from '@/modules/shared/auth/authEvents'

/**
 * Stamps the display-only `mfa_enrolled` flag after the client verifies a factor
 * and the session is genuinely AAL2. Idempotent (the WHERE clause no-ops when
 * already set, so no version churn) and non-authoritative — the gate reads live
 * AAL, never this flag. A failure here is logged, not surfaced as fatal.
 */
export async function markMfaEnrolledAction(): Promise<{ ok: true } | { error: string }> {
  try {
    const actor = await requireActor()
    const supabase = createClient()
    const { data } = await supabase.auth.mfa.getAuthenticatorAssuranceLevel()
    if (data?.currentLevel !== 'aal2') return { ok: true } // not actually elevated → nothing to stamp

    const updated = await withTransaction(actor.id, async (tx) => {
      const res = await tx.query(
        `UPDATE app_user
            SET mfa_enrolled = true, updated_at = now(), updated_by = $1, version = version + 1
          WHERE id = $1 AND mfa_enrolled = false`, [actor.id])
      return res.rowCount ?? 0
    })
    if (updated > 0) {
      await recordAuthEvent({ userId: actor.id, eventType: 'mfa_enrolled' })
    }
    return { ok: true }
  } catch (err) {
    console.error(JSON.stringify({ level: 'error', msg: 'markMfaEnrolled failed', err: String(err) }))
    return { error: 'Could not record enrollment.' }
  }
}
