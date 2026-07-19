import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'

let db: Client
let userId: string

beforeAll(async () => {
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  const { rows } = await db.query(`
    INSERT INTO app_user (auth_user_id, email, full_name, role_id, module_access, active)
    SELECT gen_random_uuid(), 'ov@test.local', 'Override Test', r.id,
           ARRAY['manufacturing']::text[], true
      FROM role r WHERE r.key = 'viewer' RETURNING id, auth_user_id`)
  userId = rows[0].id
})
afterAll(async () => { await db.end() })

const resolve = async () => {
  const { rows } = await db.query(
    `SELECT * FROM fn_resolve_actor((SELECT auth_user_id FROM app_user WHERE id = $1))`, [userId])
  return rows[0]
}

describe('fn_resolve_actor', () => {
  it('returns the role grants for a user with no overrides', async () => {
    const a = await resolve()
    expect(a.role_permissions.sort()).toEqual(['download_files', 'view_records'])
    expect(a.granted_overrides).toEqual([])
  })

  it('reports an active grant override', async () => {
    await db.query(`
      INSERT INTO user_permission_override (user_id, permission_id, granted, reason, created_by)
      SELECT $1, p.id, true, 'covering for the manager this week', $1
        FROM permission p WHERE p.key = 'export_data'`, [userId])
    expect((await resolve()).granted_overrides).toEqual(['export_data'])
  })

  it('ignores an EXPIRED override — a lapsed grant stops working immediately', async () => {
    await db.query(`UPDATE user_permission_override SET expires_at = now() - interval '1 minute'
                     WHERE user_id = $1`, [userId])
    expect((await resolve()).granted_overrides).toEqual([])
  })
})
