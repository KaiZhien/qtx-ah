import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import { setUserActive, updateUserAccess } from '@/modules/admin/services/userService'
import { PermissionError } from '@/modules/shared/authz/authorize'
import { LastSuperAdminError, SelfEscalationError } from '@/modules/admin/domain/userGuards'
import type { Actor } from '@/modules/shared/authz/catalog'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client
let saId: string
let opId: string

const actorOf = (id: string, roleKey: Actor['roleKey'], perms: string[]): Actor => ({
  id, roleKey,
  permissions: new Set(perms as never), moduleAccess: new Set(['admin']), active: true,
})

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  saId = (await db.query(`SELECT id FROM app_user WHERE email = 'reetmitra8@gmail.com'`)).rows[0].id
  opId = (await db.query(`
    INSERT INTO app_user (email, full_name, role_id, module_access, active)
    SELECT 'op@test.local', 'Op Test', r.id, ARRAY['manufacturing']::text[], true
      FROM role r WHERE r.key = 'operator' RETURNING id`)).rows[0].id
})
afterAll(async () => { await db.end(); await getPool().end() })

const versionOf = async (id: string) =>
  (await db.query(`SELECT version FROM app_user WHERE id = $1`, [id])).rows[0].version

describe('userService.setUserActive', () => {
  it('refuses a caller without manage_users', async () => {
    const mgr = actorOf('mgr-1', 'manager', ['view_records'])
    await expect(setUserActive(mgr, opId, false, await versionOf(opId)))
      .rejects.toThrow(PermissionError)
  })

  it('deactivates a user and audits the change with the acting Super Admin', async () => {
    const sa = actorOf(saId, 'super_admin', ['manage_users'])
    await setUserActive(sa, opId, false, await versionOf(opId))

    const { rows } = await db.query(`SELECT active FROM app_user WHERE id = $1`, [opId])
    expect(rows[0].active).toBe(false)

    const audit = await db.query(
      `SELECT actor_id, changed_columns FROM audit_log
        WHERE table_name = 'app_user' AND row_id = $1 ORDER BY occurred_at DESC LIMIT 1`, [opId])
    expect(audit.rows[0].actor_id).toBe(saId)
    expect(audit.rows[0].changed_columns).toContain('active')

    await setUserActive(sa, opId, true, await versionOf(opId))   // restore
  })

  it('rejects a stale version rather than clobbering a concurrent edit', async () => {
    const sa = actorOf(saId, 'super_admin', ['manage_users'])
    const stale = (await versionOf(opId)) - 1
    await expect(setUserActive(sa, opId, false, stale)).rejects.toThrow(/modified by someone else/i)
  })

  it('refuses to deactivate the last Super Admin', async () => {
    const sa = actorOf(saId, 'super_admin', ['manage_users'])
    await expect(setUserActive(sa, saId, false, await versionOf(saId)))
      .rejects.toThrow(LastSuperAdminError)
  })
})

describe('userService.updateUserAccess', () => {
  it('blocks self-escalation even for a Super Admin', async () => {
    const sa = actorOf(saId, 'super_admin', ['manage_users'])
    await expect(updateUserAccess(sa, saId, { roleKey: 'super_admin' }, await versionOf(saId)))
      .rejects.toThrow(SelfEscalationError)
  })

  it('changes a role and module access together', async () => {
    const sa = actorOf(saId, 'super_admin', ['manage_users'])
    await updateUserAccess(sa, opId,
      { roleKey: 'manager', moduleAccess: ['manufacturing', 'maintenance'] }, await versionOf(opId))
    const { rows } = await db.query(
      `SELECT r.key, u.module_access FROM app_user u JOIN role r ON r.id = u.role_id
        WHERE u.id = $1`, [opId])
    expect(rows[0].key).toBe('manager')
    expect(rows[0].module_access.sort()).toEqual(['maintenance', 'manufacturing'])
  })
})
