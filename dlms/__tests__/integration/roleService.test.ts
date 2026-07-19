import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import { setRolePermission, addOverride } from '@/modules/admin/services/roleService'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client
let saId: string
let targetId: string

const sa = (): Actor => ({
  id: saId, roleKey: 'super_admin',
  permissions: new Set(['manage_roles_permissions']), moduleAccess: new Set(['admin']), active: true,
})

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  saId = (await db.query(`SELECT id FROM app_user WHERE email = 'reetmitra8@gmail.com'`)).rows[0].id
  targetId = (await db.query(`
    INSERT INTO app_user (email, full_name, role_id, module_access, active)
    SELECT 'ovr@test.local', 'Override Target', r.id, ARRAY['finance']::text[], true
      FROM role r WHERE r.key = 'viewer' RETURNING id`)).rows[0].id
})
afterAll(async () => { await db.end(); await getPool().end() })

const grantCount = async (roleKey: string, permKey: string) =>
  (await db.query(`SELECT count(*)::int AS n FROM role_permission rp
     JOIN role r ON r.id = rp.role_id JOIN permission p ON p.id = rp.permission_id
    WHERE r.key = $1 AND p.key = $2`, [roleKey, permKey])).rows[0].n

describe('roleService.setRolePermission', () => {
  it('refuses an Admin — only a Super Admin edits the permission fabric', async () => {
    const admin: Actor = {
      id: 'a-1', roleKey: 'admin',
      permissions: new Set(['manage_users']), moduleAccess: new Set(['admin']), active: true,
    }
    await expect(setRolePermission(admin, {
      roleKey: 'viewer', permissionKey: 'export_data', granted: true,
    })).rejects.toThrow(PermissionError)
  })

  it('grants a permission to a role and audits it', async () => {
    await setRolePermission(sa(), { roleKey: 'viewer', permissionKey: 'export_data', granted: true })
    expect(await grantCount('viewer', 'export_data')).toBe(1)

    const audit = await db.query(
      `SELECT actor_id FROM audit_log WHERE table_name = 'role_permission'
        ORDER BY occurred_at DESC LIMIT 1`)
    expect(audit.rows[0].actor_id).toBe(saId)
  })

  it('revokes a permission from a role', async () => {
    await setRolePermission(sa(), { roleKey: 'viewer', permissionKey: 'export_data', granted: false })
    expect(await grantCount('viewer', 'export_data')).toBe(0)
  })

  it('is idempotent — re-granting does not create a duplicate row', async () => {
    await setRolePermission(sa(), { roleKey: 'viewer', permissionKey: 'export_data', granted: true })
    await setRolePermission(sa(), { roleKey: 'viewer', permissionKey: 'export_data', granted: true })
    expect(await grantCount('viewer', 'export_data')).toBe(1)
    await setRolePermission(sa(), { roleKey: 'viewer', permissionKey: 'export_data', granted: false })
  })

  it('refuses to strip manage_roles_permissions from super_admin — no self-lockout', async () => {
    await expect(setRolePermission(sa(), {
      roleKey: 'super_admin', permissionKey: 'manage_roles_permissions', granted: false,
    })).rejects.toThrow(/super administrator/i)
  })
})

describe('roleService.addOverride', () => {
  it('requires a reason of real substance', async () => {
    await expect(addOverride(sa(), {
      userId: targetId, permissionKey: 'export_data', granted: true, reason: 'x',
    })).rejects.toThrow()
  })

  it('stores a time-boxed grant override', async () => {
    const expiresAt = new Date(Date.now() + 86_400_000)
    await addOverride(sa(), {
      userId: targetId, permissionKey: 'export_data', granted: true,
      reason: 'Covering month-end reporting while the manager is on leave', expiresAt,
    })
    const { rows } = await db.query(
      `SELECT o.granted, o.reason, o.expires_at FROM user_permission_override o
         JOIN permission p ON p.id = o.permission_id
        WHERE o.user_id = $1 AND p.key = 'export_data'`, [targetId])
    expect(rows[0].granted).toBe(true)
    expect(rows[0].expires_at).not.toBeNull()
  })

  it('replaces an existing override for the same user and permission', async () => {
    await addOverride(sa(), {
      userId: targetId, permissionKey: 'export_data', granted: false,
      reason: 'Revoked after the month-end cover ended',
    })
    const { rows } = await db.query(
      `SELECT count(*)::int AS n, bool_and(NOT o.granted) AS all_revoked
         FROM user_permission_override o JOIN permission p ON p.id = o.permission_id
        WHERE o.user_id = $1 AND p.key = 'export_data'`, [targetId])
    expect(rows[0].n).toBe(1)
    expect(rows[0].all_revoked).toBe(true)
  })
})
