import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client, type PoolConfig } from 'pg'

// getPool() (lib/db/pool.ts) is a max:10 pool sized for production traffic. Two
// sequential connect() calls against it are NOT guaranteed to return the same
// physical connection, so the no-leak test's "same pooled connection" precondition
// would never actually be established. Forcing every Pool built in this file down
// to max:1 makes reuse deterministic: with only one physical connection possible,
// connect() can only ever hand back that one — which is exactly what the test
// below needs to prove a leak would be observable if `tx.ts` ever regressed.
vi.mock('pg', async (importOriginal) => {
  const actual = await importOriginal<typeof import('pg')>()
  class SingleConnectionPool extends actual.Pool {
    constructor(config?: PoolConfig) {
      super({ ...config, max: 1 })
    }
  }
  return { ...actual, Pool: SingleConnectionPool }
})

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

  it('does not leak the GUC onto the reused pooled connection after COMMIT', async () => {
    await withTransaction(actorId, async (tx) => {
      await tx.query(`INSERT INTO tx_probe (label) VALUES ('leak-1')`)
    })

    // getPool() is backed by the max:1 pool mocked at the top of this file, so this
    // connect() is guaranteed to return the exact physical connection withTransaction
    // just released above — there is no second connection it could be instead.
    const client = await getPool().connect()
    try {
      // Deliberately NO set_config here: the only way to observe whether actorId
      // survived past COMMIT on the shared connection is to read the GUC without
      // ever setting it ourselves. A transaction-LOCAL set_config (tx.ts's `true`
      // third argument) is discarded at COMMIT, so this reads back '' — a
      // session-level set_config (the `false` regression) would instead still
      // read back actorId here.
      const { rows } = await client.query<{ actor: string }>(
        `SELECT current_setting('app.actor_id', true) AS actor`)
      expect(rows[0].actor).toBe('')
    } finally {
      client.release()
    }
  })

  it('returns the callback value', async () => {
    const out = await withTransaction(actorId, async (tx) => {
      const { rows } = await tx.query<{ n: number }>(`SELECT 42::int AS n`)
      return rows[0].n
    })
    expect(out).toBe(42)
  })
})
