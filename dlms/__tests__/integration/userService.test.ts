import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import { setUserActive, updateUserAccess, SUPER_ADMIN_SET_LOCK } from '@/modules/admin/services/userService'
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

/**
 * Races `p` against a `ms` timer and reports whether the timer won — i.e.
 * whether `p` was still unsettled after `ms`. Used only to prove a promise is
 * BLOCKED (on the advisory lock); the real outcome is asserted separately by
 * awaiting `p` itself once the blocker is released.
 */
const stillPending = async (p: Promise<unknown>, ms: number): Promise<boolean> => {
  const timeout = Symbol('timeout')
  const winner = await Promise.race([
    p.then(() => 'settled' as const, () => 'settled' as const),
    new Promise((resolve) => setTimeout(() => resolve(timeout), ms)),
  ])
  return winner === timeout
}

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

/**
 * Proves the distinct-target race described in userService.ts's
 * SUPER_ADMIN_SET_LOCK comment: two concurrent deactivations of DIFFERENT
 * super admins never contend on FOR UPDATE OF u (they lock different rows),
 * so without a shared lock each transaction's unlocked admin-count read is
 * blind to the other's uncommitted change and both can pass the last-admin
 * guard. A second pg Client (C1) holds SUPER_ADMIN_SET_LOCK itself to stand
 * in for "another in-flight super-admin mutation", so the service call is
 * forced to block on a REAL cross-connection advisory-lock wait — nothing
 * here is simulated with sleeps-as-synchronization.
 */
describe('userService.setUserActive — last-Super-Admin race across distinct targets', () => {
  let saAId: string
  let saBId: string

  beforeAll(async () => {
    const insertSuperAdmin = async (email: string) => (await db.query(`
      INSERT INTO app_user (email, full_name, role_id, active)
      SELECT $1, $1, r.id, true FROM role r WHERE r.key = 'super_admin' RETURNING id`,
      [email])).rows[0].id
    saAId = await insertSuperAdmin('sa-a@test.local')
    saBId = await insertSuperAdmin('sa-b@test.local')
    // The seeded bootstrap Super Admin (saId) would otherwise stay a third active
    // admin for the whole test, masking the race (removing either saA or saB would
    // always still leave 2 standing). Stand it down so saA/saB are the ONLY active
    // super admins while this describe block runs; restored in afterAll.
    await db.query(`UPDATE app_user SET active = false WHERE id = $1`, [saId])
  })

  afterAll(async () => {
    await db.query(`UPDATE app_user SET active = true WHERE id IN ($1, $2, $3)`, [saId, saAId, saBId])
  })

  it('blocks the second cross-target deactivation until the first commits, then rejects it as the last admin', async () => {
    const sa = actorOf(saId, 'super_admin', ['manage_users'])
    const versionB = await versionOf(saBId)

    const c1 = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    await c1.connect()
    try {
      await c1.query('BEGIN')
      // Stands in for Txn A already past its own guard check and about to write —
      // holding the SAME key the service uses is what forces mutual exclusion.
      await c1.query('SELECT pg_advisory_xact_lock($1)', [SUPER_ADMIN_SET_LOCK])

      const pending = setUserActive(sa, saBId, false, versionB)
      pending.catch(() => {}) // attach now so the eventual rejection below is never "unhandled"

      expect(await stillPending(pending, 150)).toBe(true)

      // Release the lock by committing C1's deactivation of saA. Only now can the
      // blocked service call proceed to read the (now-accurate) admin count.
      await c1.query(`UPDATE app_user SET active = false, version = version + 1 WHERE id = $1`, [saAId])
      await c1.query('COMMIT')

      await expect(pending).rejects.toThrow(LastSuperAdminError)

      const rows = (await db.query(
        `SELECT id, active FROM app_user WHERE id IN ($1, $2) ORDER BY id`, [saAId, saBId],
      )).rows
      const saARow = rows.find((r) => r.id === saAId)!
      const saBRow = rows.find((r) => r.id === saBId)!
      expect(saARow.active).toBe(false)
      expect(saBRow.active).toBe(true) // rejected before its UPDATE ran
      expect(rows.filter((r) => r.active).length).toBeGreaterThanOrEqual(1)
    } finally {
      await c1.query('ROLLBACK').catch(() => {})
      await c1.end()
      await db.query(`UPDATE app_user SET active = true WHERE id = $1`, [saAId]) // restore
    }
  })
})
