import { z } from 'zod'
import { withTransaction, OptimisticLockError } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'
import {
  DO_STATUSES, evaluateDoStatusChange, InvalidDoStatusChangeError,
  messageForDoStatusChangeError, type DoStatus,
} from '@/modules/logistics/domain/doStatus'

export class DeliveryOrderNotFoundError extends Error {
  constructor(id: string) {
    super(`Delivery order ${id} not found`)
    this.name = 'DeliveryOrderNotFoundError'
  }
}

export class DuplicateDoNumberError extends Error {
  constructor(doNo: string) {
    super(`A delivery order with number "${doNo}" already exists`)
    this.name = 'DuplicateDoNumberError'
  }
}

// delivery_order_do_no_unique is a partial unique index (deleted_at IS NULL)
// → Postgres error 23505. Mirrors deviceWriteService.rethrowDbError.
function rethrowDbError(err: unknown, doNo: string | null | undefined): never {
  if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505'
      && doNo) throw new DuplicateDoNumberError(doNo)
  throw err
}

export type DeliveryOrderListItem = {
  id: string
  doNo: string
  status: DoStatus
  customer: string | null
  destination: string | null
  shipDate: Date | null
  deliveredDate: Date | null
  carrier: string | null
}

const filterSchema = z.object({
  status: z.array(z.enum(DO_STATUSES)).optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
})
export type DeliveryOrderFilter = z.input<typeof filterSchema>

/**
 * The delivery order list (spec Logistics §4.1/§6.3). Keyset pagination on
 * (created_at, id) — same rationale as deviceReadService.listDevices: OFFSET
 * would drift as DOs are created during a session.
 */
export async function listDeliveryOrders(
  actor: Actor, filter: DeliveryOrderFilter,
): Promise<{ items: DeliveryOrderListItem[]; nextCursor: string | null }> {
  authorize(actor, 'view_records', 'logistics')
  const f = filterSchema.parse(filter)

  return withTransaction(actor.id, async (tx) => {
    const conditions = ['deleted_at IS NULL']
    const params: unknown[] = []
    const p = (v: unknown) => { params.push(v); return `$${params.length}` }

    if (f.status?.length) conditions.push(`status = ANY(${p(f.status)})`)
    if (f.cursor) {
      const [ts, id] = Buffer.from(f.cursor, 'base64url').toString().split('|')
      conditions.push(`(created_at, id) < (${p(new Date(ts))}, ${p(id)})`)
    }

    const { rows } = await tx.query<{
      id: string; do_no: string; status: DoStatus; customer: string | null
      destination: string | null; ship_date: Date | null; delivered_date: Date | null
      carrier: string | null; created_at: Date
    }>(
      `SELECT id, do_no, status, customer, destination, ship_date, delivered_date, carrier, created_at
         FROM delivery_order
        WHERE ${conditions.join(' AND ')}
        ORDER BY created_at DESC, id DESC
        LIMIT ${p(f.limit + 1)}`, params)

    const hasMore = rows.length > f.limit
    const page = hasMore ? rows.slice(0, f.limit) : rows
    const last = page[page.length - 1]

    return {
      items: page.map((r) => ({
        id: r.id, doNo: r.do_no, status: r.status, customer: r.customer,
        destination: r.destination, shipDate: r.ship_date, deliveredDate: r.delivered_date,
        carrier: r.carrier,
      })),
      nextCursor: hasMore && last
        ? Buffer.from(`${last.created_at.toISOString()}|${last.id}`).toString('base64url')
        : null,
    }
  })
}

export type DeliveryOrderLineRow = {
  id: string
  lineNo: number
  deviceId: string | null
  deviceSn: string | null
  description: string | null
  quantity: number
}

export type DeliveryOrderDetail = DeliveryOrderListItem & {
  podReference: string | null
  podReceivedAt: Date | null
  importExportRef: string | null
  notes: string | null
  version: number
  lines: DeliveryOrderLineRow[]
}

/** Returns null for unknown ids so the page can 404 without a thrown error path. */
export async function getDeliveryOrder(actor: Actor, id: string): Promise<DeliveryOrderDetail | null> {
  authorize(actor, 'view_records', 'logistics')

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      id: string; do_no: string; status: DoStatus; customer: string | null
      destination: string | null; ship_date: Date | null; delivered_date: Date | null
      carrier: string | null; pod_reference: string | null; pod_received_at: Date | null
      import_export_ref: string | null; notes: string | null; version: number
    }>(
      `SELECT id, do_no, status, customer, destination, ship_date, delivered_date, carrier,
              pod_reference, pod_received_at, import_export_ref, notes, version
         FROM delivery_order WHERE id = $1 AND deleted_at IS NULL`, [id])
    const r = rows[0]
    if (!r) return null

    const { rows: lineRows } = await tx.query<{
      id: string; line_no: number; device_id: string | null; device_sn: string | null
      description: string | null; quantity: string
    }>(
      `SELECT l.id, l.line_no, l.device_id, d.device_sn, l.description, l.quantity
         FROM delivery_order_line l
         LEFT JOIN device d ON d.id = l.device_id
        WHERE l.delivery_order_id = $1
        ORDER BY l.line_no`, [id])

    return {
      id: r.id, doNo: r.do_no, status: r.status, customer: r.customer,
      destination: r.destination, shipDate: r.ship_date, deliveredDate: r.delivered_date,
      carrier: r.carrier, podReference: r.pod_reference, podReceivedAt: r.pod_received_at,
      importExportRef: r.import_export_ref, notes: r.notes, version: r.version,
      lines: lineRows.map((l) => ({
        id: l.id, lineNo: l.line_no, deviceId: l.device_id, deviceSn: l.device_sn,
        description: l.description, quantity: Number(l.quantity),
      })),
    }
  })
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')

const lineInputSchema = z.object({
  deviceId: z.string().uuid().optional(),
  description: z.string().max(500).optional(),
  quantity: z.number().positive().max(999999).default(1),
})
export type DeliveryOrderLineInput = z.input<typeof lineInputSchema>

const createSchema = z.object({
  doNo: z.string().min(1).max(100),
  customer: z.string().max(200).optional(),
  destination: z.string().max(200).optional(),
  shipDate: DATE.optional(),
  carrier: z.string().max(200).optional(),
  importExportRef: z.string().max(200).optional(),
  notes: z.string().max(5000).optional(),
  lines: z.array(lineInputSchema).max(200).default([]),
})
export type CreateDeliveryOrderInput = z.input<typeof createSchema>

/**
 * Create a delivery order at status 'draft' with its lines, in ONE transaction
 * — a DO is never created without its shipped items already attached, and a
 * failed line insert (e.g. an unknown device_id) rolls back the header too.
 */
export async function createDeliveryOrder(
  actor: Actor, input: CreateDeliveryOrderInput,
): Promise<{ id: string; status: DoStatus }> {
  authorize(actor, 'create_records', 'logistics')
  const data = createSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    let id: string
    try {
      const { rows } = await tx.query<{ id: string; status: DoStatus }>(
        `INSERT INTO delivery_order
           (do_no, customer, destination, ship_date, carrier, import_export_ref, notes,
            created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)
         RETURNING id, status`,
        [data.doNo, data.customer ?? null, data.destination ?? null, data.shipDate ?? null,
         data.carrier ?? null, data.importExportRef ?? null, data.notes ?? null, actor.id])
      id = rows[0].id
    } catch (err) {
      rethrowDbError(err, data.doNo)
    }

    let lineNo = 1
    for (const line of data.lines) {
      await tx.query(
        `INSERT INTO delivery_order_line
           (delivery_order_id, line_no, device_id, description, quantity, created_by)
         VALUES ($1,$2,$3,$4,$5,$6)`,
        [id!, lineNo, line.deviceId ?? null, line.description ?? null, line.quantity, actor.id])
      lineNo += 1
    }

    return { id: id!, status: 'draft' }
  })
}

const updateSchema = z.object({
  deliveryOrderId: z.string().uuid(),
  version: z.number().int().nonnegative(),
  doNo: z.string().min(1).max(100).optional(),
  customer: z.string().max(200).nullish(),
  destination: z.string().max(200).nullish(),
  shipDate: DATE.nullish(),
  deliveredDate: DATE.nullish(),
  carrier: z.string().max(200).nullish(),
  podReference: z.string().max(200).nullish(),
  podReceivedAt: z.string().min(1).max(40).nullish(),
  importExportRef: z.string().max(200).nullish(),
  notes: z.string().max(5000).nullish(),
})
export type UpdateDeliveryOrderInput = z.input<typeof updateSchema>

// The editable header columns. status is deliberately absent: it changes
// ONLY through changeDoStatus so the fixed transition graph and the
// delivered_date auto-stamp can never be bypassed — mirrors
// deviceWriteService.updateDevice's UPDATE_COLUMNS convention.
const UPDATE_COLUMNS: Record<string, string> = {
  doNo: 'do_no', customer: 'customer', destination: 'destination', shipDate: 'ship_date',
  deliveredDate: 'delivered_date', carrier: 'carrier', podReference: 'pod_reference',
  podReceivedAt: 'pod_received_at', importExportRef: 'import_export_ref', notes: 'notes',
}

/**
 * Edit a delivery order's header fields (never status) under optimistic
 * concurrency. Only keys present in the input are written — omitting a field
 * leaves it untouched, an explicit null clears it.
 */
export async function updateDeliveryOrder(
  actor: Actor, input: UpdateDeliveryOrderInput,
): Promise<{ version: number }> {
  authorize(actor, 'edit_records', 'logistics')
  const data = updateSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    const { rows: cur } = await tx.query<{ version: number }>(
      `SELECT version FROM delivery_order WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [data.deliveryOrderId])
    if (cur.length === 0) throw new DeliveryOrderNotFoundError(data.deliveryOrderId)
    if (cur[0].version !== data.version) throw new OptimisticLockError('delivery_order', data.deliveryOrderId)

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
    try {
      const { rows } = await tx.query<{ version: number }>(
        `UPDATE delivery_order SET ${setSql}
          WHERE id = ${p(data.deliveryOrderId)} AND version = ${p(data.version)}
          RETURNING version`, params)
      if (rows.length === 0) throw new OptimisticLockError('delivery_order', data.deliveryOrderId)
      return { version: rows[0].version }
    } catch (err) {
      rethrowDbError(err, data.doNo)
    }
  })
}

const changeStatusSchema = z.object({
  deliveryOrderId: z.string().uuid(),
  toStatus: z.enum(DO_STATUSES),
  version: z.number().int().nonnegative(),
})
export type ChangeDoStatusInput = z.input<typeof changeStatusSchema>

/**
 * Move a DO to a new status through the fixed fail-closed flow
 * (modules/logistics/domain/doStatus.ts). One transaction: lock the row,
 * validate the edge, update status + version, and — moving into 'delivered'
 * — stamp delivered_date with today if it isn't already set. A rejected move
 * writes nothing.
 */
export async function changeDoStatus(
  actor: Actor, input: ChangeDoStatusInput,
): Promise<{ status: DoStatus; version: number }> {
  authorize(actor, 'edit_records', 'logistics')
  const data = changeStatusSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ status: DoStatus; version: number }>(
      `SELECT status, version FROM delivery_order
        WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [data.deliveryOrderId])
    if (rows.length === 0) throw new DeliveryOrderNotFoundError(data.deliveryOrderId)
    const current = rows[0]
    if (current.version !== data.version) {
      throw new OptimisticLockError('delivery_order', data.deliveryOrderId)
    }

    const decision = evaluateDoStatusChange(current.status, data.toStatus)
    if (!decision.ok) {
      throw new InvalidDoStatusChangeError(
        decision.error, messageForDoStatusChangeError(current.status, data.toStatus))
    }

    const stampDelivered = data.toStatus === 'delivered'
    const { rows: updated } = await tx.query<{ version: number }>(
      `UPDATE delivery_order
          SET status = $1, updated_at = now(), updated_by = $2, version = version + 1,
              delivered_date = CASE WHEN $3 THEN COALESCE(delivered_date, CURRENT_DATE)
                                     ELSE delivered_date END
        WHERE id = $4 AND version = $5
        RETURNING version`,
      [data.toStatus, actor.id, stampDelivered, data.deliveryOrderId, data.version])
    if (updated.length === 0) throw new OptimisticLockError('delivery_order', data.deliveryOrderId)

    return { status: data.toStatus, version: updated[0].version }
  })
}

export type DoStatusCount = { status: DoStatus; count: number }

/** One grouped query behind the Logistics landing page's DO-counts-by-status widget. */
export async function getDoStatusCounts(actor: Actor): Promise<DoStatusCount[]> {
  authorize(actor, 'view_records', 'logistics')
  return withTransaction(actor.id, async (tx) => {
    // No status_option-style vocabulary table for DO status (it's the fixed
    // doStatus.ts graph, not admin-editable) — unnest the fixed list so every
    // status appears with a zero count rather than only ones in use.
    const { rows } = await tx.query<{ status: DoStatus; count: string }>(
      `SELECT s.status, count(d.id)::text AS count
         FROM unnest($1::text[]) AS s(status)
         LEFT JOIN delivery_order d ON d.status = s.status AND d.deleted_at IS NULL
        GROUP BY s.status`, [DO_STATUSES as unknown as string[]])
    const order = new Map(DO_STATUSES.map((s, i) => [s, i]))
    return rows
      .map((r) => ({ status: r.status, count: Number(r.count) }))
      .sort((a, b) => (order.get(a.status) ?? 0) - (order.get(b.status) ?? 0))
  })
}
