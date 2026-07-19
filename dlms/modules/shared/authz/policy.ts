import type { Actor, ModuleKey, Permission } from './catalog'

/**
 * THE authorization rule (spec §3.2): module access ∧ permission, gated on active.
 *
 * Pure by design — no I/O, no DB, no session. The Actor arrives with its
 * permissions already resolved (role grants ± overrides) so this function stays
 * trivially testable and every caller gets identical semantics.
 *
 * Order matters: the active check precedes everything so a deactivated account
 * can never act, whatever its role. super_admin bypasses the MODULE gate only —
 * it never bypasses the permission set, because a Super Admin whose grants were
 * edited away should genuinely lose the ability.
 */
export function can(actor: Actor, permission: Permission, module?: ModuleKey): boolean {
  if (!actor.active) return false
  if (module && actor.roleKey !== 'super_admin' && !actor.moduleAccess.has(module)) return false
  return actor.permissions.has(permission)
}
