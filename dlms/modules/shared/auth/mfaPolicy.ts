import type { RoleKey } from '@/modules/shared/authz/catalog'

/**
 * Which roles must complete a TOTP challenge to hold a session (spec D35).
 *
 * The list is the set of roles that can approve, export, or reshape the system —
 * the powers whose misuse a stolen password would enable. Kept as an explicit
 * Set rather than derived from permissions so that adding a permission to a role
 * can never silently relax its login requirement.
 */
const MFA_REQUIRED: ReadonlySet<RoleKey> = new Set<RoleKey>(['super_admin', 'admin', 'finance'])

export function requiresMfa(roleKey: RoleKey): boolean {
  return MFA_REQUIRED.has(roleKey)
}

/** Supabase authenticator assurance level. aal1 = password; aal2 = password + verified TOTP. */
export type AalLevel = 'aal1' | 'aal2'

/**
 * The gate (spec §5.1): does this actor still owe a second factor to enter the
 * platform? Non-MFA roles are always satisfied. For an MFA role, only a live
 * aal2 session satisfies it — a null level (AAL read failed / absent) fails
 * closed to 'required'.
 */
export function mfaGateStatus(
  input: { roleKey: RoleKey; currentLevel: AalLevel | null },
): 'satisfied' | 'required' {
  if (!requiresMfa(input.roleKey)) return 'satisfied'
  return input.currentLevel === 'aal2' ? 'satisfied' : 'required'
}

/**
 * What the /mfa screen should do given the user's factor + session state.
 * 'done' once aal2 (the page redirects away); otherwise enroll a first factor
 * or challenge an existing one. A null level fails closed toward enrolling.
 */
export function mfaStepFor(
  input: { hasVerifiedFactor: boolean; currentLevel: AalLevel | null },
): 'enroll' | 'challenge' | 'done' {
  if (input.currentLevel === 'aal2') return 'done'
  return input.hasVerifiedFactor ? 'challenge' : 'enroll'
}
