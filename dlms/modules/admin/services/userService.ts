import { z } from 'zod'
import { withTransaction, OptimisticLockError } from '@/lib/db/tx'
import { getPool } from '@/lib/db/pool'
import { authorize } from '@/modules/shared/authz/authorize'
import { assertNotLastSuperAdmin, assertNotSelfEscalation } from '@/modules/admin/domain/userGuards'
import { MODULES, ROLES } from '@/modules/shared/authz/catalog'
import type { Actor, ModuleKey, RoleKey } from '@/modules/shared/authz/catalog'

const inviteSchema = z.object({
  email: z.string().email().max(255),
  fullName: z.string().min(1).max(200),
  roleKey: z.enum(ROLES),
  department: z.string().max(100).optional(),
  moduleAccess: z.array(z.enum(MODULES)),
})
export type InviteUserInput = z.infer<typeof inviteSchema>

/**
 * Namespaces the transaction-scoped advisory lock that serializes every
 * mutation able to change the active-Super-Admin set (deactivation in
 * setUserActive, role change away from super_admin in updateUserAccess).
 *
 * Locking only the target row (FOR UPDATE OF u) cannot prevent a race across
 * DISTINCT targets: two concurrent transactions deactivating/demoting two
 * different super admins never contend on that row lock, so under READ
 * COMMITTED each one's unlocked count-of-active-super-admins read is blind to
 * the other's uncommitted change, and both can pass the last-admin guard and
 * commit, leaving zero. Taking this lock first, in both functions, before the
 * target SELECT and the count read, forces those operations to run one at a
 * time so the count read and the write are atomic across targets.
 * pg_advisory_xact_lock auto-releases at COMMIT/ROLLBACK — no manual unlock,
 * and since it is always acquired first and is the only lock taken, there is
 * no deadlock risk.
 */
export const SUPER_ADMIN_SET_LOCK = 0x5341_444d

/**
 * Creates the app_user row for an invited employee.
 *
 * The Supabase Auth invite is sent by the caller (server action) AFTER this
 * commits: an auth account with no app_user row is a ghost that can sign in and
 * resolve to nothing, whereas an app_user row with no auth account is simply a
 * pending invite the Super Admin can see and re-send.
 */
export async function inviteUser(actor: Actor, input: InviteUserInput): Promise<{ userId: string }> {
  authorize(actor, 'manage_users', 'admin')
  const data = inviteSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO app_user (email, full_name, role_id, department, module_access,
                             active, invited_at, created_by, updated_by)
       SELECT $1, $2, r.id, $3, $4, true, now(), $5, $5
         FROM role r WHERE r.key = $6
       RETURNING id`,
      [data.email, data.fullName, data.department ?? null, data.moduleAccess, actor.id, data.roleKey],
    )
    if (rows.length === 0) throw new Error(`Unknown role: ${data.roleKey}`)
    return { userId: rows[0].id }
  })
}

export type UserListRow = {
  id: string
  email: string
  fullName: string
  roleKey: RoleKey
  department: string | null
  moduleAccess: ModuleKey[]
  active: boolean
  mfaEnrolled: boolean
  lastLoginAt: string | null
  invitedAt: string | null
  authUserId: string | null
  version: number
}

/**
 * Lists every non-deleted user for the console table.
 *
 * A plain pooled read, not withTransaction: nothing here is written or
 * attributed, so there is no actor GUC to set and no transaction to hold open.
 */
export async function listUsers(actor: Actor): Promise<UserListRow[]> {
  authorize(actor, 'manage_users', 'admin')

  const { rows } = await getPool().query<{
    id: string
    email: string
    full_name: string
    role_key: RoleKey
    department: string | null
    module_access: string[]
    active: boolean
    mfa_enrolled: boolean
    last_login_at: string | null
    invited_at: string | null
    auth_user_id: string | null
    version: number
  }>(
    `SELECT u.id, u.email, u.full_name, r.key AS role_key, u.department, u.module_access,
            u.active, u.mfa_enrolled, u.last_login_at, u.invited_at, u.auth_user_id, u.version
       FROM app_user u JOIN role r ON r.id = u.role_id
      WHERE u.deleted_at IS NULL
      ORDER BY u.created_at DESC`,
  )

  return rows.map((r) => ({
    id: r.id,
    email: r.email,
    fullName: r.full_name,
    roleKey: r.role_key,
    department: r.department,
    moduleAccess: r.module_access as ModuleKey[],
    active: r.active,
    mfaEnrolled: r.mfa_enrolled,
    lastLoginAt: r.last_login_at,
    invitedAt: r.invited_at,
    authUserId: r.auth_user_id,
    version: r.version,
  }))
}

/**
 * Activates or deactivates an account.
 *
 * The Super Admin count is read INSIDE the transaction with FOR UPDATE on the
 * target, behind the SUPER_ADMIN_SET_LOCK advisory lock, so two concurrent
 * deactivations of DIFFERENT super admins cannot both pass the last-admin
 * check and leave the system with zero administrators (same-target
 * concurrency was already covered by the row lock + version check).
 *
 * Returns the target's auth_user_id so callers can revoke the live Supabase
 * session without trusting a client-supplied id for someone else's account.
 */
export async function setUserActive(
  actor: Actor, userId: string, active: boolean, version: number,
): Promise<{ authUserId: string | null }> {
  authorize(actor, 'manage_users', 'admin')

  return withTransaction(actor.id, async (tx) => {
    // Serialize every mutation that can change the active-super-admin set, so the
    // count read and the write are atomic across DIFFERENT targets. Locking only the
    // target row cannot prevent two concurrent deactivations of distinct super admins
    // from each seeing the other as still active and both passing the last-admin guard.
    await tx.query('SELECT pg_advisory_xact_lock($1)', [SUPER_ADMIN_SET_LOCK])

    const target = await tx.query<{ version: number; role_key: RoleKey; auth_user_id: string | null }>(
      `SELECT u.version, r.key AS role_key, u.auth_user_id FROM app_user u JOIN role r ON r.id = u.role_id
        WHERE u.id = $1 AND u.deleted_at IS NULL FOR UPDATE OF u`, [userId])
    if (target.rows.length === 0) throw new Error(`User ${userId} not found`)
    if (target.rows[0].version !== version) throw new OptimisticLockError('app_user', userId)

    if (!active) {
      const admins = await tx.query<{ id: string }>(
        `SELECT u.id FROM app_user u JOIN role r ON r.id = u.role_id
          WHERE r.key = 'super_admin' AND u.active AND u.deleted_at IS NULL`)
      assertNotLastSuperAdmin({
        targetUserId: userId,
        targetRoleKey: target.rows[0].role_key,
        activeSuperAdminIds: admins.rows.map((r) => r.id),
      })
    }

    await tx.query(
      `UPDATE app_user SET active = $1, updated_at = now(), updated_by = $2, version = version + 1
        WHERE id = $3`, [active, actor.id, userId])

    return { authUserId: target.rows[0].auth_user_id }
  })
}

const accessSchema = z.object({
  roleKey: z.enum(ROLES).optional(),
  department: z.string().max(100).optional(),
  moduleAccess: z.array(z.enum(MODULES)).optional(),
})
export type UpdateAccessInput = z.infer<typeof accessSchema>

/** Changes role, department, and/or module access in one audited transaction. */
export async function updateUserAccess(
  actor: Actor, userId: string, input: UpdateAccessInput, version: number,
): Promise<void> {
  authorize(actor, 'manage_users', 'admin')
  assertNotSelfEscalation(actor, userId)
  const data = accessSchema.parse(input)

  await withTransaction(actor.id, async (tx) => {
    // Serialize every mutation that can change the active-super-admin set, so the
    // count read and the write are atomic across DIFFERENT targets. Locking only the
    // target row cannot prevent two concurrent deactivations of distinct super admins
    // from each seeing the other as still active and both passing the last-admin guard.
    await tx.query('SELECT pg_advisory_xact_lock($1)', [SUPER_ADMIN_SET_LOCK])

    const target = await tx.query<{ version: number; role_key: RoleKey }>(
      `SELECT u.version, r.key AS role_key FROM app_user u JOIN role r ON r.id = u.role_id
        WHERE u.id = $1 AND u.deleted_at IS NULL FOR UPDATE OF u`, [userId])
    if (target.rows.length === 0) throw new Error(`User ${userId} not found`)
    if (target.rows[0].version !== version) throw new OptimisticLockError('app_user', userId)

    // Demoting the last Super Admin is the same lockout as deactivating them.
    if (data.roleKey && data.roleKey !== 'super_admin') {
      const admins = await tx.query<{ id: string }>(
        `SELECT u.id FROM app_user u JOIN role r ON r.id = u.role_id
          WHERE r.key = 'super_admin' AND u.active AND u.deleted_at IS NULL`)
      assertNotLastSuperAdmin({
        targetUserId: userId,
        targetRoleKey: target.rows[0].role_key,
        activeSuperAdminIds: admins.rows.map((r) => r.id),
      })
    }

    await tx.query(
      `UPDATE app_user SET
         role_id = COALESCE((SELECT id FROM role WHERE key = $1), role_id),
         department = COALESCE($2, department),
         module_access = COALESCE($3, module_access),
         updated_at = now(), updated_by = $4, version = version + 1
       WHERE id = $5`,
      [data.roleKey ?? null, data.department ?? null, data.moduleAccess ?? null, actor.id, userId])
  })
}
