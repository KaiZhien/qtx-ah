import type { Actor, RoleKey } from '@/modules/shared/authz/catalog'

export class LastSuperAdminError extends Error {
  constructor() {
    super('This is the last active Super Administrator — promote someone else first')
    this.name = 'LastSuperAdminError'
  }
}

export class SelfEscalationError extends Error {
  constructor() {
    super('You cannot change your own role or module access — ask another Super Administrator')
    this.name = 'SelfEscalationError'
  }
}

/**
 * Prevents locking everyone out of user administration (spec §3.3).
 *
 * Pure and caller-fed: the service reads the current Super Admin ids inside the
 * same transaction that performs the write, so the count cannot go stale between
 * check and commit.
 */
export function assertNotLastSuperAdmin(input: {
  targetUserId: string
  targetRoleKey: RoleKey
  activeSuperAdminIds: string[]
}): void {
  if (input.targetRoleKey !== 'super_admin') return
  const remaining = input.activeSuperAdminIds.filter((id) => id !== input.targetUserId)
  if (remaining.length === 0) throw new LastSuperAdminError()
}

/**
 * Separation of duties (spec §11.1): even a Super Admin cannot grant themselves
 * powers. Two people are always involved in a privilege change.
 */
export function assertNotSelfEscalation(actor: Actor, targetUserId: string): void {
  if (actor.id === targetUserId) throw new SelfEscalationError()
}
