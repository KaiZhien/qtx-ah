import { Pool } from 'pg'

let pool: Pool | undefined

/**
 * Singleton node-postgres pool over Supavisor's transaction-mode port (6543).
 *
 * Why direct pg rather than supabase-js for writes: supabase-js issues one HTTP
 * request per statement and cannot span a transaction, which the component
 * replacement workflow (spec §5.4) structurally requires. Reads stay on
 * supabase-js so RLS remains live enforcement (spec §7.2).
 *
 * max is small on purpose: Fargate runs 2–4 tasks, and Supabase's pooler is the
 * real connection budget. Statement timeout keeps a runaway query from pinning a
 * connection for the whole request budget.
 */
export function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: process.env.DATABASE_URL,
      max: 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 15_000,
      ssl: process.env.APP_ENV === 'development' ? undefined : { rejectUnauthorized: true },
    })
    pool.on('error', (err) => {
      console.error(JSON.stringify({ level: 'error', msg: 'idle pg client error', err: err.message }))
    })
  }
  return pool
}
