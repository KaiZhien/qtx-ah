import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import { withTransaction } from '@/lib/db/tx'
import { getPool } from '@/lib/db/pool'

let db: Client
let actorId: string

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  const { rows } = await db.query(`SELECT id FROM app_user WHERE email = 'reetmitra8@gmail.com'`)
  actorId = rows[0].id
  await db.query(`CREATE TABLE IF NOT EXISTS tx_probe (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    label text NOT NULL UNIQUE,
    created_by uuid REFERENCES app_user(id),
    updated_by uuid REFERENCES app_user(id))`)
  await db.query(`SELECT fn_attach_audit('tx_probe')`)
})
afterAll(async () => {
  await db.query('DROP TABLE IF EXISTS tx_probe')
  await db.end()
  await getPool().end()
})

describe('withTransaction', () => {
  it('commits every statement together', async () => {
    await withTransaction(actorId, async (tx) => {
      await tx.query(`INSERT INTO tx_probe (label) VALUES ('commit-a')`)
      await tx.query(`INSERT INTO tx_probe (label) VALUES ('commit-b')`)
    })
    const { rows } = await db.query(`SELECT label FROM tx_probe WHERE label LIKE 'commit-%' ORDER BY label`)
    expect(rows.map((r) => r.label)).toEqual(['commit-a', 'commit-b'])
  })

  it('ROLLS BACK every statement when any one throws — the §14 guarantee', async () => {
    await expect(
      withTransaction(actorId, async (tx) => {
        await tx.query(`INSERT INTO tx_probe (label) VALUES ('rollback-a')`)
        await tx.query(`INSERT INTO tx_probe (label) VALUES ('rollback-a')`)  // unique violation
      }),
    ).rejects.toThrow()

    const { rows } = await db.query(`SELECT count(*)::int AS n FROM tx_probe WHERE label = 'rollback-a'`)
    expect(rows[0].n).toBe(0)   // the FIRST insert must be gone too
  })

  it('rolls back when application code throws after successful statements', async () => {
    await expect(
      withTransaction(actorId, async (tx) => {
        await tx.query(`INSERT INTO tx_probe (label) VALUES ('app-throw')`)
        throw new Error('business rule violated')
      }),
    ).rejects.toThrow('business rule violated')
    const { rows } = await db.query(`SELECT count(*)::int AS n FROM tx_probe WHERE label = 'app-throw'`)
    expect(rows[0].n).toBe(0)
  })

  it('attributes audit rows to the actor via the GUC, with no updated_by column set', async () => {
    await withTransaction(actorId, async (tx) => {
      await tx.query(`INSERT INTO tx_probe (label) VALUES ('guc-actor')`)
    })
    const { rows } = await db.query(
      `SELECT actor_id FROM audit_log WHERE table_name = 'tx_probe'
        AND new_values->>'label' = 'guc-actor'`)
    expect(rows).toHaveLength(1)
    expect(rows[0].actor_id).toBe(actorId)
  })

  it('does not leak the GUC into the next transaction on the same pooled connection', async () => {
    await withTransaction(actorId, async (tx) => {
      await tx.query(`INSERT INTO tx_probe (label) VALUES ('leak-1')`)
    })
    const other = (await db.query(
      `INSERT INTO app_user (email, full_name, role_id, active)
       SELECT 'leak@test.local', 'Leak Probe', r.id, true FROM role r WHERE r.key = 'viewer'
       RETURNING id`)).rows[0].id
    await withTransaction(other, async (tx) => {
      await tx.query(`INSERT INTO tx_probe (label) VALUES ('leak-2')`)
    })
    const { rows } = await db.query(
      `SELECT actor_id FROM audit_log WHERE table_name = 'tx_probe'
        AND new_values->>'label' = 'leak-2'`)
    expect(rows[0].actor_id).toBe(other)   // NOT the previous actor
  })

  it('returns the callback value', async () => {
    const out = await withTransaction(actorId, async (tx) => {
      const { rows } = await tx.query<{ n: number }>(`SELECT 42::int AS n`)
      return rows[0].n
    })
    expect(out).toBe(42)
  })
})
