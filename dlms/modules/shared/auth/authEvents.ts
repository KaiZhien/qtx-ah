import { createAdminClient } from '@/lib/supabase/server'

export type AuthEventInput = {
  userId?: string
  email?: string
  eventType:
    | 'login_success' | 'login_failure' | 'lockout' | 'logout'
    | 'mfa_enrolled' | 'mfa_reset' | 'password_reset'
    | 'permission_denied' | 'session_revoked'
  detail?: Record<string, unknown>
  ipAddress?: string
  userAgent?: string
}

type AuthEventRow = {
  user_id: string | null
  email: string | null
  event_type: AuthEventInput['eventType']
  detail: Record<string, unknown> | null
  ip_address: string | null
  user_agent: string | null
}

/**
 * The generated Database type (lib/types/database.types.ts) is generated from
 * the existing DLMS Supabase project and has no entry for auth_event, which
 * belongs to the separate ops-platform project this table was added to (Task
 * 2's platform_audit migration). Typing the insert call site directly, rather
 * than widening or hand-editing the generated types file, keeps that drift
 * contained to this one function — same approach as
 * modules/shared/authz/actor.ts's ResolveActorRpc.
 */
type AuthEventInsert = (
  table: 'auth_event',
) => { insert: (row: AuthEventRow) => Promise<{ error: { message: string } | null }> }

/**
 * Writes the security trail the Admin console reads (spec §11.1).
 *
 * Never throws: a failure to record a login must not prevent the login itself,
 * and a failure to record a denial must not turn a 403 into a 500. Losses are
 * logged for the operator instead.
 */
export async function recordAuthEvent(input: AuthEventInput): Promise<void> {
  try {
    const supabase = createAdminClient()
    const from = supabase.from.bind(supabase) as unknown as AuthEventInsert
    const { error } = await from('auth_event').insert({
      user_id: input.userId ?? null,
      email: input.email ?? null,
      event_type: input.eventType,
      detail: input.detail ?? null,
      ip_address: input.ipAddress ?? null,
      user_agent: input.userAgent ?? null,
    })
    if (error) throw new Error(error.message)
  } catch (err) {
    // `instanceof`, not a cast. This catch is the last line of the never-throws
    // contract above, so it has to survive whatever was thrown: `(err as Error)
    // .message` logged `undefined` for a thrown string or object — losing the one
    // fact the operator needs — and raised a TypeError *inside the catch* for a
    // thrown null or undefined, which escapes and takes the login down with it.
    console.error(JSON.stringify({
      level: 'error', msg: 'auth_event write failed',
      eventType: input.eventType, err: err instanceof Error ? err.message : String(err),
    }))
  }
}
