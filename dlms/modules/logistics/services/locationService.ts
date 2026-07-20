import { z } from 'zod'
import { withTransaction, OptimisticLockError } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

export type StockLocationRow = {
  id: string
  code: string
  name: string
  country: string | null
  address: string | null
  notes: string | null
  active: boolean
  version: number
}

export class LocationNotFoundError extends Error {
  constructor(id: string) {
    super(`Stock location ${id} not found`)
    this.name = 'LocationNotFoundError'
  }
}

export class DuplicateLocationCodeError extends Error {
  constructor(code: string) {
    super(`A stock location with code "${code}" already exists`)
    this.name = 'DuplicateLocationCodeError'
  }
}

// stock_location.code is UNIQUE (no partial index — never soft-deleted out of
// the uniqueness check, unlike device_sn/do_no) → Postgres error 23505.
function rethrowDbError(err: unknown, code: string | null | undefined): never {
  if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505'
      && code) throw new DuplicateLocationCodeError(code)
  throw err
}

/** The location catalogue (spec §6.3 "Logistics stock", Basic scope: CRUD only). */
export async function listLocations(
  actor: Actor, opts: { includeInactive?: boolean } = {},
): Promise<StockLocationRow[]> {
  authorize(actor, 'view_records', 'logistics')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      id: string; code: string; name: string; country: string | null
      address: string | null; notes: string | null; active: boolean; version: number
    }>(
      `SELECT id, code, name, country, address, notes, active, version
         FROM stock_location
        WHERE deleted_at IS NULL ${opts.includeInactive ? '' : 'AND active'}
        ORDER BY name`)
    return rows
  })
}

/** Returns null for unknown ids so the caller can 404 without a thrown error path. */
export async function getLocation(actor: Actor, id: string): Promise<StockLocationRow | null> {
  authorize(actor, 'view_records', 'logistics')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      id: string; code: string; name: string; country: string | null
      address: string | null; notes: string | null; active: boolean; version: number
    }>(
      `SELECT id, code, name, country, address, notes, active, version
         FROM stock_location WHERE id = $1 AND deleted_at IS NULL`, [id])
    return rows[0] ?? null
  })
}

const createSchema = z.object({
  code: z.string().min(1).max(50),
  name: z.string().min(1).max(200),
  country: z.string().max(100).optional(),
  address: z.string().max(500).optional(),
  notes: z.string().max(2000).optional(),
})
export type CreateLocationInput = z.input<typeof createSchema>

export async function createLocation(
  actor: Actor, input: CreateLocationInput,
): Promise<{ id: string }> {
  authorize(actor, 'create_records', 'logistics')
  const data = createSchema.parse(input)
  return withTransaction(actor.id, async (tx) => {
    try {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO stock_location (code, name, country, address, notes, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING id`,
        [data.code, data.name, data.country ?? null, data.address ?? null, data.notes ?? null, actor.id])
      return { id: rows[0].id }
    } catch (err) {
      rethrowDbError(err, data.code)
    }
  })
}

const updateSchema = z.object({
  code: z.string().min(1).max(50).optional(),
  name: z.string().min(1).max(200).optional(),
  country: z.string().max(100).nullish(),
  address: z.string().max(500).nullish(),
  notes: z.string().max(2000).nullish(),
  active: z.boolean().optional(),
})
export type UpdateLocationInput = z.input<typeof updateSchema>

/**
 * Partial update under optimistic concurrency — only keys present in the
 * input are written, matching updateDevice's convention (omit = untouched,
 * explicit null = cleared).
 */
export async function updateLocation(
  actor: Actor, id: string, input: UpdateLocationInput, version: number,
): Promise<{ version: number }> {
  authorize(actor, 'edit_records', 'logistics')
  const data = updateSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    const { rows: cur } = await tx.query<{ version: number }>(
      `SELECT version FROM stock_location WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [id])
    if (cur.length === 0) throw new LocationNotFoundError(id)
    if (cur[0].version !== version) throw new OptimisticLockError('stock_location', id)

    const sets: string[] = []
    const params: unknown[] = []
    const p = (v: unknown) => { params.push(v); return `$${params.length}` }

    if (data.code !== undefined) sets.push(`code = ${p(data.code)}`)
    if (data.name !== undefined) sets.push(`name = ${p(data.name)}`)
    if ('country' in data) sets.push(`country = ${p(data.country ?? null)}`)
    if ('address' in data) sets.push(`address = ${p(data.address ?? null)}`)
    if ('notes' in data) sets.push(`notes = ${p(data.notes ?? null)}`)
    if (data.active !== undefined) sets.push(`active = ${p(data.active)}`)

    const setSql = [...sets, `updated_at = now()`, `updated_by = ${p(actor.id)}`,
                    `version = version + 1`].join(', ')
    try {
      const { rows } = await tx.query<{ version: number }>(
        `UPDATE stock_location SET ${setSql} WHERE id = ${p(id)} AND version = ${p(version)}
          RETURNING version`, params)
      if (rows.length === 0) throw new OptimisticLockError('stock_location', id)
      return { version: rows[0].version }
    } catch (err) {
      rethrowDbError(err, data.code)
    }
  })
}
