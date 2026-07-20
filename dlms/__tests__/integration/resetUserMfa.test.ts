import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'

const listFactors = vi.fn()
const deleteFactor = vi.fn()
const authEventInsert = vi.fn(async () => ({ error: null }))

// createAdminClient serves BOTH the admin MFA API and recordAuthEvent's insert.
vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({
    auth: { admin: { mfa: { listFactors, deleteFactor } } },
    from: (_t: string) => ({ insert: authEventInsert }),
  }),
  createClient: () => ({}),
  createReadClient: () => ({}),
}))

import { resetUserMfa } from '@/modules/admin/services/userService'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

let db: Client
let adminId: string, targetId: string
const AUTH_UID = '11111111-2222-3333-4444-555555555555'

const admin = (): Actor => ({
  id: adminId, roleKey: 'admin',
  permissions: new Set(['manage_users']), moduleAccess: new Set(['admin']), active: true,
})
const nobody = (): Actor => ({
  id: adminId, roleKey: 'operator',
  permissions: new Set([]), moduleAccess: new Set(['admin']), active: true,
})

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  adminId = (await db.query(`SELECT id FROM app_user WHERE email='reetmitra8@gmail.com'`)).rows[0].id
})
afterAll(async () => {
  if (targetId) await db.query(`DELETE FROM app_user WHERE id=$1`, [targetId])
  await db.end(); await getPool().end()
})
beforeEach(async () => {
  listFactors.mockReset(); deleteFactor.mockReset(); authEventInsert.mockClear()
  listFactors.mockResolvedValue({ data: { factors: [{ id: 'factor-1' }] }, error: null })
  deleteFactor.mockResolvedValue({ error: null })
  // fresh target each test: an MFA-enrolled admin WITH a linked auth id
  if (targetId) await db.query(`DELETE FROM app_user WHERE id=$1`, [targetId])
  targetId = (await db.query(
    `INSERT INTO app_user (email, full_name, role_id, active, mfa_enrolled, auth_user_id, created_by, updated_by)
     VALUES ('mfa-target@example.com', 'MFA Target', (SELECT id FROM role WHERE key='admin'), true, true, $1, $2, $2)
     RETURNING id`, [AUTH_UID, adminId])).rows[0].id
})

describe('resetUserMfa', () => {
  it('refuses an actor without manage_users', async () => {
    await expect(resetUserMfa(nobody(), targetId)).rejects.toThrow(PermissionError)
  })

  it('deletes the target factors, clears the flag, and writes an mfa_reset event', async () => {
    await resetUserMfa(admin(), targetId)
    expect(listFactors).toHaveBeenCalledWith({ userId: AUTH_UID })
    expect(deleteFactor).toHaveBeenCalledWith({ id: 'factor-1', userId: AUTH_UID })
    const row = await db.query(`SELECT mfa_enrolled FROM app_user WHERE id=$1`, [targetId])
    expect(row.rows[0].mfa_enrolled).toBe(false)
    expect(authEventInsert).toHaveBeenCalledWith(expect.objectContaining({ event_type: 'mfa_reset' }))
  })

  it('throws for a user with no linked auth identity, and touches no factors', async () => {
    await db.query(`UPDATE app_user SET auth_user_id = NULL WHERE id=$1`, [targetId])
    await expect(resetUserMfa(admin(), targetId)).rejects.toThrow(/linked login/i)
    expect(deleteFactor).not.toHaveBeenCalled()
    const row = await db.query(`SELECT mfa_enrolled FROM app_user WHERE id=$1`, [targetId])
    expect(row.rows[0].mfa_enrolled).toBe(true) // unchanged
  })
})
