import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'

// Task R1 (spec §11.1): the qtx-ops-platform schema is live on a cloud Supabase
// project, where every public-schema table is exposed via the auto-generated
// PostgREST API to anyone holding the anon key UNLESS RLS is enabled. This file
// proves the migration's deny-via-REST posture actually denies REST-equivalent
// access (SET ROLE anon / authenticated against this harness's own anon/
// authenticated roles — see setup.ts for why those roles and their default
// privileges exist here) while leaving the owner connection — the only path the
// app itself uses (withTransaction) — untouched.

let db: Client
let userId: string
let variantId: string
let deviceId: string
let taskId: string

// Only these four are exercised for SELECT-denial: brief calls out device, task,
// app_user, and role_permission by name as the representative sample (a plain
// table, a table with FK-heavy children, the identity table, and the most
// security-sensitive table). Group 5 below separately checks relrowsecurity on
// all 14 to catch a table accidentally left out of the migration.
const SELECT_DENIAL_TABLES = ['device', 'task', 'app_user', 'role_permission']

const ALL_14_TABLES = [
  'role', 'permission', 'app_user', 'role_permission', 'user_permission_override',
  'task', 'task_link', 'task_comment', 'status_option', 'phase_option',
  'device_variant', 'device', 'device_status_history', 'status_transition',
]

/** Runs `fn` with the connection's role temporarily switched, always resetting after. */
async function asRole<T>(role: 'anon' | 'authenticated', fn: () => Promise<T>): Promise<T> {
  await db.query(`SET ROLE ${role}`)
  try {
    return await fn()
  } finally {
    await db.query('RESET ROLE')
  }
}

beforeAll(async () => {
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  userId = (await db.query(`SELECT id FROM app_user WHERE email = 'reetmitra8@gmail.com'`)).rows[0].id
  variantId = (await db.query(`SELECT id FROM device_variant WHERE code = 'basic'`)).rows[0].id

  const { rows: deviceRows } = await db.query(
    `INSERT INTO device (device_sn, variant_id, status, created_by, updated_by)
     VALUES ('QTX-RLS-00001', $1, 'in_stock', $2, $2) RETURNING id`,
    [variantId, userId],
  )
  deviceId = deviceRows[0].id

  const { rows: taskRows } = await db.query(
    `INSERT INTO task (title, status, created_by) VALUES ('RLS probe task', 'open', $1) RETURNING id`,
    [userId],
  )
  taskId = taskRows[0].id
})
afterAll(async () => { await db.end() })

describe('platform RLS — deny-via-REST posture (Task R1)', () => {
  describe('anon is denied all reads', () => {
    for (const table of SELECT_DENIAL_TABLES) {
      it(`sees zero rows in ${table}, though rows exist as owner`, async () => {
        const n = await asRole('anon', async () => {
          const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${table}`)
          return rows[0].n
        })
        expect(n).toBe(0)
      })
    }
  })

  describe('authenticated is denied all reads', () => {
    // The app never runs as authenticated against these tables (only
    // supabase.auth.getUser() uses that JWT, never a table read) — denying
    // this path is correct, not a regression.
    for (const table of SELECT_DENIAL_TABLES) {
      it(`sees zero rows in ${table}, though rows exist as owner`, async () => {
        const n = await asRole('authenticated', async () => {
          const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${table}`)
          return rows[0].n
        })
        expect(n).toBe(0)
      })
    }
  })

  describe('authenticated cannot write via the REST-equivalent path', () => {
    it('rejects an INSERT into device (no INSERT policy exists)', async () => {
      await db.query('SET ROLE authenticated')
      try {
        await expect(
          db.query(
            `INSERT INTO device (device_sn, variant_id, status, created_by) VALUES ($1, $2, 'in_stock', $3)`,
            ['QTX-RLS-REJECT', variantId, userId],
          ),
        ).rejects.toThrow(/row-level security/i)
      } finally {
        await db.query('RESET ROLE')
      }
    })

    it('silently updates zero rows on an existing device (row is invisible under RLS)', async () => {
      await db.query('SET ROLE authenticated')
      let result
      try {
        result = await db.query(
          `UPDATE device SET remarks = 'tampered-by-authenticated' WHERE id = $1`,
          [deviceId],
        )
      } finally {
        await db.query('RESET ROLE')
      }
      expect(result.rowCount).toBe(0)

      // Confirm as owner the row genuinely wasn't touched — proves the zero
      // rowCount above means "denied", not "coincidentally matched nothing".
      const { rows } = await db.query(`SELECT remarks FROM device WHERE id = $1`, [deviceId])
      expect(rows[0].remarks).not.toBe('tampered-by-authenticated')
    })

    it('silently deletes zero rows on an existing device (row is invisible under RLS)', async () => {
      await db.query('SET ROLE authenticated')
      let result
      try {
        result = await db.query(`DELETE FROM device WHERE id = $1`, [deviceId])
      } finally {
        await db.query('RESET ROLE')
      }
      expect(result.rowCount).toBe(0)

      const { rows } = await db.query(`SELECT count(*)::int AS n FROM device WHERE id = $1`, [deviceId])
      expect(rows[0].n).toBe(1)
    })
  })

  describe('the owner connection is unaffected — this is the app path', () => {
    it('still sees the seeded device row by id', async () => {
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM device WHERE id = $1`, [deviceId])
      expect(rows[0].n).toBe(1)
    })

    it('still sees the seeded task row by id', async () => {
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM task WHERE id = $1`, [taskId])
      expect(rows[0].n).toBe(1)
    })
  })

  describe('RLS is enabled on every one of the 14 platform tables', () => {
    it('reports relrowsecurity = true for each table', async () => {
      const { rows } = await db.query(
        `SELECT relname, relrowsecurity FROM pg_class WHERE relname = ANY($1::text[]) AND relkind = 'r'`,
        [ALL_14_TABLES],
      )
      const byName = new Map(rows.map((r) => [r.relname as string, r.relrowsecurity as boolean]))
      for (const table of ALL_14_TABLES) {
        expect(byName.get(table)).toBe(true)
      }
    })
  })
})
