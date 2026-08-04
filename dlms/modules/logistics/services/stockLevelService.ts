import { z } from 'zod'
import { withTransaction } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'
import { STOCK_TRANSFER_STATUSES, type StockTransferStatus } from '@/modules/logistics/domain/transferStatus'

/**
 * Read-only views over stock_level (spec §6.3 "Logistics stock").
 *
 * ── stock_level is for BATCH-tracked component types ONLY ───────────────────
 * A serialized component's whereabouts is component_unit.location_id, and it is
 * never also counted here. Do not "helpfully" UNION the two into a single
 * "stock on hand" number: they answer different questions (how much of a
 * commodity vs. where one specific part is), and summing them double-counts
 * nothing today only because nothing writes serialized rows into stock_level —
 * which is exactly the invariant fn_stock_level_batch_only exists to keep true.
 *
 * All writes to stock_level go through stockTransferService, never here.
 */

export type StockLevelRow = {
  id: string
  locationId: string
  locationCode: string
  locationName: string
  componentTypeId: string
  componentTypeCode: string
  componentTypeName: string
  qty: number
  version: number
}

const filterSchema = z.object({
  locationId: z.string().uuid().optional(),
  componentTypeId: z.string().uuid().optional(),
  /** A location that shipped everything out keeps a qty=0 row; usually noise. */
  includeZero: z.boolean().default(false),
})
export type StockLevelFilter = z.input<typeof filterSchema>

export async function listStockLevels(
  actor: Actor, filter: StockLevelFilter = {},
): Promise<StockLevelRow[]> {
  authorize(actor, 'view_records', 'logistics')
  const f = filterSchema.parse(filter)

  return withTransaction(actor.id, async (tx) => {
    const conditions = ['l.deleted_at IS NULL', 'ct.deleted_at IS NULL']
    const params: unknown[] = []
    const p = (v: unknown) => { params.push(v); return `$${params.length}` }

    if (f.locationId) conditions.push(`s.location_id = ${p(f.locationId)}`)
    if (f.componentTypeId) conditions.push(`s.component_type_id = ${p(f.componentTypeId)}`)
    if (!f.includeZero) conditions.push('s.qty > 0')

    const { rows } = await tx.query<{
      id: string; location_id: string; location_code: string; location_name: string
      component_type_id: string; component_type_code: string; component_type_name: string
      qty: string; version: number
    }>(
      `SELECT s.id, s.location_id, l.code AS location_code, l.name AS location_name,
              s.component_type_id, ct.code AS component_type_code, ct.name AS component_type_name,
              s.qty::text AS qty, s.version
         FROM stock_level s
         JOIN stock_location l ON l.id = s.location_id
         JOIN component_type ct ON ct.id = s.component_type_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY l.name, ct.code`, params)

    return rows.map((r) => ({
      id: r.id,
      locationId: r.location_id,
      locationCode: r.location_code,
      locationName: r.location_name,
      componentTypeId: r.component_type_id,
      componentTypeCode: r.component_type_code,
      componentTypeName: r.component_type_name,
      // numeric arrives as a string from node-postgres precisely so it does not
      // silently lose precision; Number() here is for DISPLAY only. Never feed
      // this back into an arithmetic write — the posting path does its maths in
      // SQL against the numeric column.
      qty: Number(r.qty),
      version: r.version,
    }))
  })
}

export type StockByLocationRow = {
  locationId: string
  locationCode: string
  locationName: string
  componentTypeCount: number
}

/**
 * One row per location holding batch stock, with the number of DISTINCT
 * component types held there. Backs the stock landing page and the Logistics
 * dashboard tile.
 *
 * Deliberately does NOT return a summed quantity. An earlier version did, and
 * it was wrong twice over:
 *   1. it accumulated `+= Number(qty)` in JS floats, so two types holding 0.100
 *      and 0.200 rendered as 0.30000000000000004 straight onto the dashboard;
 *   2. more fundamentally the figure was MEANINGLESS — it added incommensurable
 *      units, so 5 screws plus 3 boards read as a stock total of "8".
 * Fixing only the arithmetic would have kept a precise nonsense number. A count
 * of component types is a real quantity; a cross-type sum is not. If a
 * per-type total is ever wanted, group by component_type and label the unit.
 *
 * House rule (CLAUDE.md): flat select + JS reduce, no DB views/RPC.
 */
export async function getStockByLocation(actor: Actor): Promise<StockByLocationRow[]> {
  authorize(actor, 'view_records', 'logistics')

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      location_id: string; location_code: string; location_name: string
    }>(
      `SELECT s.location_id, l.code AS location_code, l.name AS location_name
         FROM stock_level s
         JOIN stock_location l ON l.id = s.location_id
         JOIN component_type ct ON ct.id = s.component_type_id
        WHERE l.deleted_at IS NULL AND ct.deleted_at IS NULL AND s.qty > 0
        ORDER BY l.name`)

    const byLocation = new Map<string, StockByLocationRow>()
    for (const r of rows) {
      const existing = byLocation.get(r.location_id)
      if (existing) {
        existing.componentTypeCount += 1
      } else {
        byLocation.set(r.location_id, {
          locationId: r.location_id,
          locationCode: r.location_code,
          locationName: r.location_name,
          componentTypeCount: 1,
        })
      }
    }
    return [...byLocation.values()]
  })
}

export type TransferStatusCount = { status: StockTransferStatus; count: number }

/** Transfer counts by status — same shape and rationale as getDoStatusCounts. */
export async function getTransferStatusCounts(actor: Actor): Promise<TransferStatusCount[]> {
  authorize(actor, 'view_records', 'logistics')
  return withTransaction(actor.id, async (tx) => {
    // No status_option-style vocabulary for transfer status (it is the fixed
    // transferStatus.ts graph) — unnest the fixed list so every status appears
    // with a zero count rather than only the ones in use.
    const { rows } = await tx.query<{ status: StockTransferStatus; count: string }>(
      `SELECT s.status, count(t.id)::text AS count
         FROM unnest($1::text[]) AS s(status)
         LEFT JOIN stock_transfer t ON t.status = s.status AND t.deleted_at IS NULL
        GROUP BY s.status`, [STOCK_TRANSFER_STATUSES as unknown as string[]])
    const order = new Map(STOCK_TRANSFER_STATUSES.map((s, i) => [s, i]))
    return rows
      .map((r) => ({ status: r.status, count: Number(r.count) }))
      .sort((a, b) => (order.get(a.status) ?? 0) - (order.get(b.status) ?? 0))
  })
}
