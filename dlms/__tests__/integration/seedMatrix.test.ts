import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import { ROLES, PERMISSION_MATRIX } from '@/modules/shared/authz/catalog'

let db: Client
beforeAll(async () => {
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
})
afterAll(async () => { await db.end() })

describe('seeded role_permission matches the spec §3.2 matrix in code', () => {
  for (const roleKey of ROLES) {
    it(`${roleKey} grants match exactly`, async () => {
      const { rows } = await db.query(
        `SELECT p.key FROM role_permission rp
           JOIN role r ON r.id = rp.role_id
           JOIN permission p ON p.id = rp.permission_id
          WHERE r.key = $1 ORDER BY p.key`,
        [roleKey],
      )
      expect(rows.map((r) => r.key)).toEqual([...PERMISSION_MATRIX[roleKey]].sort())
    })
  }
})
