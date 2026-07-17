import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'

let db: Client

beforeAll(async () => {
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
})
afterAll(async () => { await db.end() })

describe('platform RBAC schema', () => {
  it('seeds exactly the six roles from spec §3.1', async () => {
    const { rows } = await db.query('SELECT key FROM role ORDER BY key')
    expect(rows.map((r) => r.key)).toEqual([
      'admin', 'finance', 'manager', 'operator', 'super_admin', 'viewer',
    ])
  })

  it('seeds exactly the 24 permissions from spec §3.2', async () => {
    const { rows } = await db.query('SELECT count(*)::int AS n FROM permission')
    expect(rows[0].n).toBe(24)
  })

  it('grants super_admin every permission', async () => {
    const { rows } = await db.query(`
      SELECT count(*)::int AS n FROM role_permission rp
      JOIN role r ON r.id = rp.role_id WHERE r.key = 'super_admin'`)
    expect(rows[0].n).toBe(24)
  })

  it('refuses to delete a system role', async () => {
    await expect(db.query(`DELETE FROM role WHERE key = 'super_admin'`))
      .rejects.toThrow(/system role/i)
  })

  it('requires a reason on every permission override', async () => {
    await expect(db.query(`
      INSERT INTO user_permission_override (user_id, permission_id, granted, reason)
      SELECT u.id, p.id, true, NULL FROM app_user u, permission p LIMIT 1`))
      .rejects.toThrow()
  })

  // Locks the §3.2 matrix total so a future edit to the seed is caught here rather
  // than discovered downstream. Verified against local Docker Postgres per-role:
  // super_admin=24, admin=20, manager=16, operator=10, finance=11, viewer=2 → 83.
  it('grants exactly 83 role_permission rows across the seeded matrix', async () => {
    const { rows } = await db.query('SELECT count(*)::int AS n FROM role_permission')
    expect(rows[0].n).toBe(83)
  })
})
