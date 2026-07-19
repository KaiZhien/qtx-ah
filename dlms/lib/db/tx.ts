import type { PoolClient, QueryResult, QueryResultRow } from 'pg'
import { getPool } from './pool'

export type Tx = {
  query: <R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ) => Promise<QueryResult<R>>
}

export class OptimisticLockError extends Error {
  readonly table: string
  readonly id: string
  constructor(table: string, id: string) {
    super(`${table} ${id} was modified by someone else — reload and try again`)
    this.name = 'OptimisticLockError'
    this.table = table
    this.id = id
  }
}

/**
 * Runs `fn` inside one database transaction with the acting user carried in a
 * transaction-local GUC that fn_audit reads.
 *
 * SET LOCAL (not SET) is essential: the value dies with the transaction, so a
 * pooled connection handed to the next request cannot attribute that request's
 * writes to the previous actor. set_config's third argument `true` is what makes
 * it LOCAL.
 *
 * Any throw — from Postgres or from application code — rolls back everything.
 * The client is always released, and a rollback failure is logged rather than
 * masking the original error the caller needs to see.
 */
export async function withTransaction<T>(
  actorId: string,
  fn: (tx: Tx) => Promise<T>,
  opts: { sessionId?: string } = {},
): Promise<T> {
  const client: PoolClient = await getPool().connect()
  try {
    await client.query('BEGIN')
    await client.query('SELECT set_config($1, $2, true)', ['app.actor_id', actorId])
    if (opts.sessionId) {
      await client.query('SELECT set_config($1, $2, true)', ['app.session_id', opts.sessionId])
    }
    const result = await fn({ query: (text, values) => client.query(text, values) as never })
    await client.query('COMMIT')
    return result
  } catch (err) {
    try {
      await client.query('ROLLBACK')
    } catch (rollbackErr) {
      console.error(JSON.stringify({
        level: 'error', msg: 'ROLLBACK failed', err: (rollbackErr as Error).message,
      }))
    }
    throw err
  } finally {
    client.release()
  }
}
