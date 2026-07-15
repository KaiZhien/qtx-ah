// Shared Supabase-builder mock for mutation-layer service tests.
// Extends the thenable buildChain pattern from analytics.test.ts to cover the
// full set of builder methods the services chain (insert/update/delete/upsert/
// single/maybeSingle/eq/is/…). NOT a test file itself (no *.test.ts suffix).

import { vi } from 'vitest'

export type QueryResult = { data: unknown; error: unknown }

const CHAIN_METHODS = [
  'select', 'insert', 'update', 'delete', 'upsert',
  'eq', 'is', 'in', 'not', 'or', 'ilike', 'gte', 'lte', 'order', 'range', 'limit',
  'single', 'maybeSingle',
] as const

/**
 * Build a thenable query-builder stub. Every builder method returns the same
 * chain (so calls compose), and awaiting the chain resolves to `result`.
 * Builder-method call args are recorded into `captures` under `${table}.${method}`.
 */
export function buildChain(
  result: QueryResult,
  table = '',
  captures?: Record<string, unknown[][]>,
): Record<string, unknown> {
  const chain: Record<string, unknown> = {}
  for (const m of CHAIN_METHODS) {
    chain[m] = vi.fn((...args: unknown[]) => {
      if (captures) {
        const key = `${table}.${m}`
        ;(captures[key] ??= []).push(args)
      }
      return chain
    })
  }
  // Thenable: `await supabase.from(...).select(...)...` resolves to `result`
  chain.then = (resolve: (v: unknown) => unknown, reject?: (e: unknown) => unknown) =>
    Promise.resolve(result).then(resolve, reject)
  return chain
}

/**
 * Build a `from(table)` implementation backed by a per-table result queue.
 * Each call to `from(table)` consumes the next queued result for that table
 * (clamping to the last entry once exhausted). Useful when one service call
 * queries the same table several times in sequence.
 */
export function makeFrom(
  tableResults: Record<string, QueryResult[]>,
  captures?: Record<string, unknown[][]>,
): (table: string) => unknown {
  const counters: Record<string, number> = {}
  return (table: string) => {
    const queue = tableResults[table] ?? [{ data: null, error: null }]
    const idx = counters[table] ?? 0
    counters[table] = idx + 1
    const result = queue[Math.min(idx, queue.length - 1)]
    return buildChain(result, table, captures)
  }
}
