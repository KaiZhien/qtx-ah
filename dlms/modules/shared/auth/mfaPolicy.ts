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
