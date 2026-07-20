import { z } from 'zod'
import { withTransaction, OptimisticLockError } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

export class BuyerNotFoundError extends Error {
  constructor(buyerId: string) {
    super(`Buyer ${buyerId} not found`)
    this.name = 'BuyerNotFoundError'
  }
}

export type BuyerListItem = {
  id: string
  name: string
  country: string | null
  contactName: string | null
  contactEmail: string | null
  contactPhone: string | null
  createdAt: Date
}

export type BuyerDetail = BuyerListItem & {
  billingAddress: string | null
  notes: string | null
  version: number
}

export type BuyerOption = { id: string; name: string }

const listFilterSchema = z.object({
  q: z.string().max(100).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
})
export type BuyerFilter = z.input<typeof listFilterSchema>

/**
 * Buyer list (finance module, basic portions). Reads gated on view_finance —
 * NOT view_records — because a buyer record IS financial-adjacent data (spec
 * §3.2: Viewer never holds view_finance, even with Finance module access).
 * Keyset pagination on (created_at, id), same convention as
 * modules/manufacturing/services/deviceReadService.listDevices.
 */
export async function listBuyers(
  actor: Actor, filter: BuyerFilter,
): Promise<{ items: BuyerListItem[]; nextCursor: string | null }> {
  authorize(actor, 'view_finance', 'finance')
  const f = listFilterSchema.parse(filter)

  return withTransaction(actor.id, async (tx) => {
    const conditions = ['deleted_at IS NULL']
    const params: unknown[] = []
    const p = (v: unknown) => { params.push(v); return `$${params.length}` }

    if (f.q) {
      conditions.push(`name ILIKE ${p(`%${f.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`)} ESCAPE '\\'`)
    }
    if (f.cursor) {
      const [ts, id] = Buffer.from(f.cursor, 'base64url').toString().split('|')
      conditions.push(`(created_at, id) < (${p(new Date(ts))}, ${p(id)})`)
    }

    const { rows } = await tx.query<{
      id: string; name: string; country: string | null; contact_name: string | null
      contact_email: string | null; contact_phone: string | null; created_at: Date
    }>(
      `SELECT id, name, country, contact_name, contact_email, contact_phone, created_at
         FROM buyer
        WHERE ${conditions.join(' AND ')}
        ORDER BY created_at DESC, id DESC
        LIMIT ${p(f.limit + 1)}`, params)

    const hasMore = rows.length > f.limit
    const page = hasMore ? rows.slice(0, f.limit) : rows
    const last = page[page.length - 1]

    return {
      items: page.map((r) => ({
        id: r.id, name: r.name, country: r.country, contactName: r.contact_name,
        contactEmail: r.contact_email, contactPhone: r.contact_phone, createdAt: r.created_at,
      })),
      nextCursor: hasMore && last
        ? Buffer.from(`${last.created_at.toISOString()}|${last.id}`).toString('base64url')
        : null,
    }
  })
}

/** Returns null for unknown ids so the page can 404 without a thrown error path. */
export async function getBuyer(actor: Actor, buyerId: string): Promise<BuyerDetail | null> {
  authorize(actor, 'view_finance', 'finance')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      id: string; name: string; country: string | null; contact_name: string | null
      contact_email: string | null; contact_phone: string | null; billing_address: string | null
      notes: string | null; created_at: Date; version: number
    }>(
      `SELECT id, name, country, contact_name, contact_email, contact_phone,
              billing_address, notes, created_at, version
         FROM buyer WHERE id = $1 AND deleted_at IS NULL`, [buyerId])
    const r = rows[0]
    if (!r) return null
    return {
      id: r.id, name: r.name, country: r.country, contactName: r.contact_name,
      contactEmail: r.contact_email, contactPhone: r.contact_phone,
      billingAddress: r.billing_address, notes: r.notes, createdAt: r.created_at, version: r.version,
    }
  })
}

/**
 * Full active-buyer list for pickers (invoice create form). LIMIT 200 is a
 * basic-scope stopgap — fine at the buyer counts this build expects; a
 * searchable combobox replaces this if the buyer list outgrows it.
 */
export async function listBuyerOptions(actor: Actor): Promise<BuyerOption[]> {
  authorize(actor, 'view_finance', 'finance')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ id: string; name: string }>(
      `SELECT id, name FROM buyer WHERE deleted_at IS NULL ORDER BY name LIMIT 200`)
    return rows
  })
}

const createSchema = z.object({
  name: z.string().min(1).max(300),
  country: z.string().max(100).optional(),
  contactName: z.string().max(200).optional(),
  contactEmail: z.string().email().max(200).optional(),
  contactPhone: z.string().max(50).optional(),
  billingAddress: z.string().max(2000).optional(),
  notes: z.string().max(5000).optional(),
})
export type CreateBuyerInput = z.input<typeof createSchema>

export async function createBuyer(actor: Actor, input: CreateBuyerInput): Promise<{ buyerId: string }> {
  authorize(actor, 'manage_finance', 'finance')
  const data = createSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO buyer (name, country, contact_name, contact_email, contact_phone,
                           billing_address, notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id`,
      [data.name, data.country ?? null, data.contactName ?? null, data.contactEmail ?? null,
       data.contactPhone ?? null, data.billingAddress ?? null, data.notes ?? null, actor.id])
    return { buyerId: rows[0].id }
  })
}

const updateSchema = z.object({
  buyerId: z.string().uuid(),
  version: z.number().int().nonnegative(),
  name: z.string().min(1).max(300).optional(),
  country: z.string().max(100).nullish(),
  contactName: z.string().max(200).nullish(),
  contactEmail: z.string().email().max(200).nullish(),
  contactPhone: z.string().max(50).nullish(),
  billingAddress: z.string().max(2000).nullish(),
  notes: z.string().max(5000).nullish(),
})
export type UpdateBuyerInput = z.input<typeof updateSchema>

// camelCase input key -> buyer column, same convention as
// deviceWriteService.UPDATE_COLUMNS: only keys present in the input are written.
const UPDATE_COLUMNS: Record<string, string> = {
  name: 'name', country: 'country', contactName: 'contact_name', contactEmail: 'contact_email',
  contactPhone: 'contact_phone', billingAddress: 'billing_address', notes: 'notes',
}

export async function updateBuyer(actor: Actor, input: UpdateBuyerInput): Promise<{ version: number }> {
  authorize(actor, 'manage_finance', 'finance')
  const data = updateSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    const { rows: cur } = await tx.query<{ version: number }>(
      `SELECT version FROM buyer WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [data.buyerId])
    if (cur.length === 0) throw new BuyerNotFoundError(data.buyerId)
    if (cur[0].version !== data.version) throw new OptimisticLockError('buyer', data.buyerId)

    const sets: string[] = []
    const params: unknown[] = []
    const p = (v: unknown) => { params.push(v); return `$${params.length}` }

    for (const [key, col] of Object.entries(UPDATE_COLUMNS)) {
      if (key in data && (data as Record<string, unknown>)[key] !== undefined) {
        sets.push(`${col} = ${p((data as Record<string, unknown>)[key])}`)
      }
    }

    const setSql = [...sets, `updated_at = now()`, `updated_by = ${p(actor.id)}`,
                    `version = version + 1`].join(', ')
    const { rows } = await tx.query<{ version: number }>(
      `UPDATE buyer SET ${setSql} WHERE id = ${p(data.buyerId)} AND version = ${p(data.version)}
        RETURNING version`, params)
    if (rows.length === 0) throw new OptimisticLockError('buyer', data.buyerId)
    return { version: rows[0].version }
  })
}
