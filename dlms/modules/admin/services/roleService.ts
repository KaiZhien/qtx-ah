import { z } from 'zod'
import { withTransaction } from '@/lib/db/tx'
import { getPool } from '@/lib/db/pool'
import { authorize } from '@/modules/shared/authz/authorize'
import { PERMISSIONS, ROLES } from '@/modules/shared/authz/catalog'
import type { Actor, Permission, RoleKey } from '@/modules/shared/authz/catalog'

export class FabricLockoutError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'FabricLockoutError'
  }
}

const grantSchema = z.object({
  roleKey: z.enum(ROLES),
  permissionKey: z.enum(PERMISSIONS),
  granted: z.boolean(),
})
export type SetRolePermissionInput = z.infer<typeof grantSchema>

/**
 * Toggles one cell of the role × permission matrix.
 *
 * Idempotent by construction (ON CONFLICT DO NOTHING / DELETE), because the UI
 * is a checkbox grid and a double-click must not produce a duplicate grant or a
 * confusing error.
 *
 * The one hardcoded rule: super_admin cannot lose manage_roles_permissions. Any
 * other cell is the Super Admin's business, but that cell is the ladder they are
 * standing on.
 */
export async function setRolePermission(actor: Actor, input: SetRolePermissionInput): Promise<void> {
  authorize(actor, 'manage_roles_permissions', 'admin')
  const data = grantSchema.parse(input)

  if (data.roleKey === 'super_admin' && data.permissionKey === 'manage_roles_permissions'
      && !data.granted) {
    throw new FabricLockoutError(
      'The Super Administrator role must keep permission management — removing it would lock ' +
      'everyone out of the permission matrix permanently',
    )
  }

  await withTransaction(actor.id, async (tx) => {
    if (data.granted) {
      await tx.query(
        `INSERT INTO role_permission (role_id, permission_id, updated_by)
         SELECT r.id, p.id, $1 FROM role r, permission p WHERE r.key = $2 AND p.key = $3
         ON CONFLICT (role_id, permission_id) DO NOTHING`,
        [actor.id, data.roleKey, data.permissionKey])
    } else {
      await tx.query(
        `DELETE FROM role_permission rp USING role r, permission p
          WHERE rp.role_id = r.id AND rp.permission_id = p.id AND r.key = $1 AND p.key = $2`,
        [data.roleKey, data.permissionKey])
    }
  })
}

const overrideSchema = z.object({
  userId: z.string().uuid(),
  permissionKey: z.enum(PERMISSIONS),
  granted: z.boolean(),
  reason: z.string().min(3).max(500),
  expiresAt: z.date().optional(),
})
export type AddOverrideInput = z.infer<typeof overrideSchema>

/**
 * Sets a per-user exception to the role matrix (spec §3.4).
 *
 * Upserts rather than appends: a user has at most one standing override per
 * permission, so the current state is always a single readable row instead of a
 * pile the reader must replay. The history of the changes lives in audit_log.
 */
export async function addOverride(actor: Actor, input: AddOverrideInput): Promise<void> {
  authorize(actor, 'manage_roles_permissions', 'admin')
  const data = overrideSchema.parse(input)

  await withTransaction(actor.id, async (tx) => {
    await tx.query(
      `INSERT INTO user_permission_override
         (user_id, permission_id, granted, reason, expires_at, created_by, updated_by)
       SELECT $1, p.id, $2, $3, $4, $5, $5 FROM permission p WHERE p.key = $6
       ON CONFLICT (user_id, permission_id) DO UPDATE SET
         granted = EXCLUDED.granted, reason = EXCLUDED.reason, expires_at = EXCLUDED.expires_at,
         deleted_at = NULL, updated_at = now(), updated_by = EXCLUDED.updated_by,
         version = user_permission_override.version + 1`,
      [data.userId, data.granted, data.reason, data.expiresAt ?? null, actor.id, data.permissionKey])
  })
}

export type MatrixView = {
  roles: { id: string; key: RoleKey; name: string; isSystem: boolean }[]
  permissions: { id: string; key: Permission; name: string }[]
  grants: Record<string, string[]>
}

/** The full matrix for the admin grid, read in two queries. */
export async function getMatrix(actor: Actor): Promise<MatrixView> {
  authorize(actor, 'manage_roles_permissions', 'admin')
  return withTransaction(actor.id, async (tx) => {
    const roles = await tx.query<{ id: string; key: RoleKey; name: string; is_system: boolean }>(
      `SELECT id, key, name, is_system FROM role ORDER BY sort`)
    const permissions = await tx.query<{ id: string; key: Permission; name: string }>(
      `SELECT id, key, name FROM permission ORDER BY sort`)
    const grantRows = await tx.query<{ role_key: string; permission_key: string }>(
      `SELECT r.key AS role_key, p.key AS permission_key FROM role_permission rp
         JOIN role r ON r.id = rp.role_id JOIN permission p ON p.id = rp.permission_id`)

    const grants: Record<string, string[]> = {}
    for (const row of grantRows.rows) (grants[row.role_key] ??= []).push(row.permission_key)

    return {
      roles: roles.rows.map((r) => ({ id: r.id, key: r.key, name: r.name, isSystem: r.is_system })),
      permissions: permissions.rows,
      grants,
    }
  })
}

export type OverrideRow = {
  id: string
  permissionKey: Permission
  permissionName: string
  granted: boolean
  reason: string
  expiresAt: string | null
  createdAt: string
}

/**
 * Lists one user's standing permission-matrix exceptions for the admin console
 * (spec §3.4 "small list"). A plain pooled read, not withTransaction: nothing
 * here is written or attributed, matching userService.listUsers's rationale.
 */
export async function listOverrides(actor: Actor, userId: string): Promise<OverrideRow[]> {
  authorize(actor, 'manage_roles_permissions', 'admin')

  const { rows } = await getPool().query<{
    id: string
    permission_key: Permission
    permission_name: string
    granted: boolean
    reason: string
    expires_at: string | null
    created_at: string
  }>(
    `SELECT o.id, p.key AS permission_key, p.name AS permission_name, o.granted, o.reason,
            o.expires_at, o.created_at
       FROM user_permission_override o JOIN permission p ON p.id = o.permission_id
      WHERE o.user_id = $1 AND o.deleted_at IS NULL
      ORDER BY o.created_at DESC`,
    [userId],
  )

  return rows.map((r) => ({
    id: r.id,
    permissionKey: r.permission_key,
    permissionName: r.permission_name,
    granted: r.granted,
    reason: r.reason,
    expiresAt: r.expires_at,
    createdAt: r.created_at,
  }))
}

export type UserSummary = { id: string; email: string; fullName: string; roleKey: RoleKey }

/**
 * Minimal identity lookup for the per-user overrides page, authorized on the
 * SAME permission-fabric gate as the rest of this file (not manage_users) —
 * a caller who can edit overrides doesn't necessarily also manage user
 * accounts, and this page's own authority to exist rests on that gate alone.
 */
export async function getUserSummary(actor: Actor, userId: string): Promise<UserSummary | null> {
  authorize(actor, 'manage_roles_permissions', 'admin')

  const { rows } = await getPool().query<{ id: string; email: string; full_name: string; role_key: RoleKey }>(
    `SELECT u.id, u.email, u.full_name, r.key AS role_key FROM app_user u JOIN role r ON r.id = u.role_id
      WHERE u.id = $1 AND u.deleted_at IS NULL`,
    [userId],
  )
  const row = rows[0]
  return row ? { id: row.id, email: row.email, fullName: row.full_name, roleKey: row.role_key } : null
}
