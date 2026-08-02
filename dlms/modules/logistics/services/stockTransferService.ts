import { z } from 'zod'
import { withTransaction, OptimisticLockError, type Tx } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'
import {
  STOCK_TRANSFER_STATUSES, evaluateTransferStatusChange, InvalidTransferStatusChangeError,
  messageForTransferStatusChangeError, type StockTransferStatus,
} from '@/modules/logistics/domain/transferStatus'
import {
  planStockPosting, fromScaledQty, lockKeyOf, StockPostingError,
} from '@/modules/logistics/domain/stockPosting'

/**
 * Stock transfers and the balance posting they drive (spec §6.3).
 *
 * ═════════════════════════════════════════════════════════════════════════════
 * THE POSTING CONTRACT — read this before changing receiveStockTransfer
 * ═════════════════════════════════════════════════════════════════════════════
 * 1. Stock moves EXACTLY ONCE, at receive, in ONE transaction. Dispatch posts
 *    nothing — that is why cancelling a dispatched transfer needs no reversal.
 * 2. Idempotency comes from the status transition being evaluated INSIDE the
 *    transaction with the header row already locked (`received` is a sink, so a
 *    second receive has no legal edge). Checking status before the lock, or
 *    before the transaction, is a race, not a guard.
 * 3. Locks are taken in the deterministic order computed by
 *    modules/logistics/domain/stockPosting.ts — all stock_level rows sorted by
 *    (location, component_type), THEN all component_unit rows sorted by id.
 *    Deviating from that order deadlocks two-way rebalancing. See RULE 1 there.
 * 4. Balance arithmetic happens in SQL against the numeric column, never in JS.
 * 5. stock_level accounts for BATCH-tracked types only; a serialized unit's
 *    location is component_unit.location_id. Never both.
 */

export class StockTransferNotFoundError extends Error {
  constructor(id: string) {
    super(`Stock transfer ${id} not found`)
    this.name = 'StockTransferNotFoundError'
  }
}

export class DuplicateTransferNumberError extends Error {
  constructor(transferNo: string) {
    super(`A stock transfer with number "${transferNo}" already exists`)
    this.name = 'DuplicateTransferNumberError'
  }
}

/**
 * Raised BEFORE the qty >= 0 CHECK constraint can fire, so the user is told
 * which component ran out where instead of seeing a raw Postgres 23514.
 */
export class InsufficientStockError extends Error {
  readonly componentTypeCode: string
  readonly locationCode: string
  constructor(componentTypeCode: string, locationCode: string, requested: string, available: string) {
    super(`Not enough ${componentTypeCode} at ${locationCode}: tried to move ${requested}, only ${available} on hand`)
    this.name = 'InsufficientStockError'
    this.componentTypeCode = componentTypeCode
    this.locationCode = locationCode
  }
}

/** A line used the wrong kind of reference for its component type's tracking_mode. */
export class TrackingModeMismatchError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TrackingModeMismatchError'
  }
}

/** A referenced location / component type / component unit does not exist (or is deleted). */
export class UnknownReferenceError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UnknownReferenceError'
  }
}

/** A serialized unit on the transfer is not actually at the source location. */
export class SerializedUnitNotAtSourceError extends Error {
  constructor(serialNo: string, locationCode: string) {
    super(`Unit ${serialNo} is not at ${locationCode} — it was moved since this transfer was raised`)
    this.name = 'SerializedUnitNotAtSourceError'
  }
}

// stock_transfer_no_unique is a partial unique index (deleted_at IS NULL) →
// Postgres 23505. Mirrors deliveryOrderService.rethrowDbError.
function rethrowDbError(err: unknown, transferNo: string | null | undefined): never {
  if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505'
      && transferNo) throw new DuplicateTransferNumberError(transferNo)
  throw err
}

// ─── Reads ──────────────────────────────────────────────────────────────────

export type StockTransferListItem = {
  id: string
  transferNo: string
  status: StockTransferStatus
  fromLocationName: string
  toLocationName: string
  lineCount: number
  createdAt: Date
}

const filterSchema = z.object({
  status: z.array(z.enum(STOCK_TRANSFER_STATUSES)).optional(),
  locationId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
})
export type StockTransferFilter = z.input<typeof filterSchema>

/** Keyset pagination on (created_at, id) — same rationale as listDeliveryOrders. */
export async function listStockTransfers(
  actor: Actor, filter: StockTransferFilter = {},
): Promise<{ items: StockTransferListItem[]; nextCursor: string | null }> {
  authorize(actor, 'view_records', 'logistics')
  const f = filterSchema.parse(filter)

  return withTransaction(actor.id, async (tx) => {
    const conditions = ['t.deleted_at IS NULL']
    const params: unknown[] = []
    const p = (v: unknown) => { params.push(v); return `$${params.length}` }

    if (f.status?.length) conditions.push(`t.status = ANY(${p(f.status)})`)
    if (f.locationId) {
      const id = p(f.locationId)
      conditions.push(`(t.from_location_id = ${id} OR t.to_location_id = ${id})`)
    }
    if (f.cursor) {
      const [ts, id] = Buffer.from(f.cursor, 'base64url').toString().split('|')
      conditions.push(`(t.created_at, t.id) < (${p(new Date(ts))}, ${p(id)})`)
    }

    const { rows } = await tx.query<{
      id: string; transfer_no: string; status: StockTransferStatus
      from_name: string; to_name: string; line_count: string; created_at: Date
    }>(
      `SELECT t.id, t.transfer_no, t.status,
              fl.name AS from_name, tl.name AS to_name,
              (SELECT count(*)::text FROM stock_transfer_line sl
                WHERE sl.stock_transfer_id = t.id) AS line_count,
              t.created_at
         FROM stock_transfer t
         JOIN stock_location fl ON fl.id = t.from_location_id
         JOIN stock_location tl ON tl.id = t.to_location_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY t.created_at DESC, t.id DESC
        LIMIT ${p(f.limit + 1)}`, params)

    const hasMore = rows.length > f.limit
    const page = hasMore ? rows.slice(0, f.limit) : rows
    const last = page[page.length - 1]

    return {
      items: page.map((r) => ({
        id: r.id, transferNo: r.transfer_no, status: r.status,
        fromLocationName: r.from_name, toLocationName: r.to_name,
        lineCount: Number(r.line_count), createdAt: r.created_at,
      })),
      nextCursor: hasMore && last
        ? Buffer.from(`${last.created_at.toISOString()}|${last.id}`).toString('base64url')
        : null,
    }
  })
}

export type StockTransferLineRow = {
  id: string
  lineNo: number
  kind: 'batch' | 'serialized'
  componentTypeId: string | null
  componentTypeCode: string | null
  componentTypeName: string | null
  qty: number | null
  componentUnitId: string | null
  serialNo: string | null
  notes: string | null
}

export type StockTransferDetail = {
  id: string
  transferNo: string
  status: StockTransferStatus
  fromLocationId: string
  fromLocationCode: string
  fromLocationName: string
  toLocationId: string
  toLocationCode: string
  toLocationName: string
  initiatedById: string
  initiatedByName: string | null
  dispatchedAt: Date | null
  receivedAt: Date | null
  carrier: string | null
  reference: string | null
  notes: string | null
  version: number
  lines: StockTransferLineRow[]
}

/** Returns null for unknown ids so the page can 404 without a thrown error path. */
export async function getStockTransfer(
  actor: Actor, id: string,
): Promise<StockTransferDetail | null> {
  authorize(actor, 'view_records', 'logistics')

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      id: string; transfer_no: string; status: StockTransferStatus
      from_location_id: string; from_code: string; from_name: string
      to_location_id: string; to_code: string; to_name: string
      initiated_by: string; initiated_by_name: string | null
      dispatched_at: Date | null; received_at: Date | null
      carrier: string | null; reference: string | null; notes: string | null; version: number
    }>(
      `SELECT t.id, t.transfer_no, t.status,
              t.from_location_id, fl.code AS from_code, fl.name AS from_name,
              t.to_location_id, tl.code AS to_code, tl.name AS to_name,
              t.initiated_by, u.full_name AS initiated_by_name,
              t.dispatched_at, t.received_at, t.carrier, t.reference, t.notes, t.version
         FROM stock_transfer t
         JOIN stock_location fl ON fl.id = t.from_location_id
         JOIN stock_location tl ON tl.id = t.to_location_id
         LEFT JOIN app_user u ON u.id = t.initiated_by
        WHERE t.id = $1 AND t.deleted_at IS NULL`, [id])
    const r = rows[0]
    if (!r) return null

    const { rows: lineRows } = await tx.query<{
      id: string; line_no: number; component_type_id: string | null
      ct_code: string | null; ct_name: string | null; qty: string | null
      component_unit_id: string | null; serial_no: string | null
      unit_ct_code: string | null; unit_ct_name: string | null; notes: string | null
    }>(
      `SELECT sl.id, sl.line_no, sl.component_type_id,
              ct.code AS ct_code, ct.name AS ct_name, sl.qty::text AS qty,
              sl.component_unit_id, cu.serial_no,
              uct.code AS unit_ct_code, uct.name AS unit_ct_name, sl.notes
         FROM stock_transfer_line sl
         LEFT JOIN component_type ct ON ct.id = sl.component_type_id
         LEFT JOIN component_unit cu ON cu.id = sl.component_unit_id
         LEFT JOIN component_type uct ON uct.id = cu.component_type_id
        WHERE sl.stock_transfer_id = $1
        ORDER BY sl.line_no`, [id])

    return {
      id: r.id, transferNo: r.transfer_no, status: r.status,
      fromLocationId: r.from_location_id, fromLocationCode: r.from_code, fromLocationName: r.from_name,
      toLocationId: r.to_location_id, toLocationCode: r.to_code, toLocationName: r.to_name,
      initiatedById: r.initiated_by, initiatedByName: r.initiated_by_name,
      dispatchedAt: r.dispatched_at, receivedAt: r.received_at,
      carrier: r.carrier, reference: r.reference, notes: r.notes, version: r.version,
      lines: lineRows.map((l) => ({
        id: l.id,
        lineNo: l.line_no,
        kind: l.component_unit_id ? 'serialized' : 'batch',
        componentTypeId: l.component_type_id,
        // A serialized line carries no component_type_id of its own — surface
        // the unit's type so the UI can label every line uniformly.
        componentTypeCode: l.ct_code ?? l.unit_ct_code,
        componentTypeName: l.ct_name ?? l.unit_ct_name,
        qty: l.qty === null ? null : Number(l.qty),
        componentUnitId: l.component_unit_id,
        serialNo: l.serial_no,
        notes: l.notes,
      })),
    }
  })
}

// ─── Pickers for the create form ────────────────────────────────────────────

export type TransferableBatchType = {
  componentTypeId: string
  code: string
  name: string
  /** On hand at the chosen source location. 0 when the location holds none. */
  availableQty: number
}

export type TransferableUnit = {
  componentUnitId: string
  serialNo: string
  componentTypeCode: string
  /** null for a unit whose location was never recorded (pre-L1 rows). */
  locationId: string | null
}

export type TransferOptions = {
  batchTypes: TransferableBatchType[]
  units: TransferableUnit[]
}

/**
 * What can be moved out of `fromLocationId`, for the create-transfer form.
 *
 * Deliberately NOT manufacturing's listComponentTypes: that function is gated
 * on `view_records` in the MANUFACTURING module, so a logistics clerk with only
 * logistics access would be denied the picker for a screen they are allowed to
 * use. This is the same catalogue read, re-gated on logistics. If a shared,
 * module-agnostic catalogue read ever lands, this should collapse into it.
 *
 * Batch types are listed even at zero quantity (so the form can say "0 on hand"
 * rather than hiding the type); serialized units are restricted to those AT the
 * source, plus unlocated ones, matching what receiveStockTransfer will accept.
 */
export async function listTransferOptions(
  actor: Actor, fromLocationId: string,
): Promise<TransferOptions> {
  authorize(actor, 'view_records', 'logistics')

  return withTransaction(actor.id, async (tx) => {
    const { rows: typeRows } = await tx.query<{
      id: string; code: string; name: string; qty: string | null
    }>(
      `SELECT ct.id, ct.code, ct.name, s.qty::text AS qty
         FROM component_type ct
         LEFT JOIN stock_level s
           ON s.component_type_id = ct.id AND s.location_id = $1
        WHERE ct.deleted_at IS NULL AND ct.active AND ct.tracking_mode = 'batch'
        ORDER BY ct.sort, ct.name`, [fromLocationId])

    const { rows: unitRows } = await tx.query<{
      id: string; serial_no: string; code: string; location_id: string | null
    }>(
      `SELECT cu.id, cu.serial_no, ct.code, cu.location_id
         FROM component_unit cu
         JOIN component_type ct ON ct.id = cu.component_type_id
        WHERE cu.deleted_at IS NULL AND ct.tracking_mode = 'serialized'
          AND (cu.location_id = $1 OR cu.location_id IS NULL)
        ORDER BY ct.code, cu.serial_no
        LIMIT 500`, [fromLocationId])

    return {
      batchTypes: typeRows.map((r) => ({
        componentTypeId: r.id, code: r.code, name: r.name, availableQty: Number(r.qty ?? 0),
      })),
      units: unitRows.map((r) => ({
        componentUnitId: r.id, serialNo: r.serial_no,
        componentTypeCode: r.code, locationId: r.location_id,
      })),
    }
  })
}

// ─── Create ─────────────────────────────────────────────────────────────────

const batchLineSchema = z.object({
  componentTypeId: z.string().uuid(),
  qty: z.number().positive().max(99999999),
  notes: z.string().max(500).optional(),
})
const serializedLineSchema = z.object({
  componentUnitId: z.string().uuid(),
  notes: z.string().max(500).optional(),
})

const createSchema = z.object({
  transferNo: z.string().min(1).max(100),
  fromLocationId: z.string().uuid(),
  toLocationId: z.string().uuid(),
  carrier: z.string().max(200).optional(),
  reference: z.string().max(200).optional(),
  notes: z.string().max(5000).optional(),
  batchLines: z.array(batchLineSchema).max(200).default([]),
  serializedLines: z.array(serializedLineSchema).max(200).default([]),
})
export type CreateStockTransferInput = z.input<typeof createSchema>

/**
 * Validates that every line uses the reference form its component type's
 * tracking_mode demands. tracking_mode is immutable once set, so this is a
 * stable fact about the type, not a moment-in-time check.
 *
 * This is the FIRST line of defence for the "one source of truth" invariant;
 * fn_stock_level_batch_only in the migration is the backstop.
 */
async function assertLineTrackingModes(
  tx: Tx,
  batchLines: readonly { componentTypeId: string }[],
  serializedLines: readonly { componentUnitId: string }[],
): Promise<void> {
  if (batchLines.length > 0) {
    const ids = [...new Set(batchLines.map((l) => l.componentTypeId))]
    const { rows } = await tx.query<{ id: string; code: string; tracking_mode: string }>(
      `SELECT id, code, tracking_mode FROM component_type
        WHERE id = ANY($1) AND deleted_at IS NULL`, [ids])
    const found = new Map(rows.map((r) => [r.id, r]))
    for (const id of ids) {
      const row = found.get(id)
      if (!row) throw new UnknownReferenceError(`Component type ${id} does not exist`)
      if (row.tracking_mode !== 'batch') {
        throw new TrackingModeMismatchError(
          `${row.code} is a serialized component — transfer it by unit serial number, not by quantity`)
      }
    }
  }

  if (serializedLines.length > 0) {
    const ids = [...new Set(serializedLines.map((l) => l.componentUnitId))]
    const { rows } = await tx.query<{ id: string; serial_no: string; tracking_mode: string; code: string }>(
      `SELECT cu.id, cu.serial_no, ct.tracking_mode, ct.code
         FROM component_unit cu
         JOIN component_type ct ON ct.id = cu.component_type_id
        WHERE cu.id = ANY($1) AND cu.deleted_at IS NULL`, [ids])
    const found = new Map(rows.map((r) => [r.id, r]))
    for (const id of ids) {
      const row = found.get(id)
      if (!row) throw new UnknownReferenceError(`Component unit ${id} does not exist`)
      if (row.tracking_mode !== 'serialized') {
        throw new TrackingModeMismatchError(
          `${row.code} is a batch component — transfer it by quantity, not by unit`)
      }
    }
  }
}

/**
 * Create a transfer at status 'draft' with its lines, in ONE transaction — a
 * transfer is never created without the items it moves, and a rejected line
 * rolls back the header too. Posts NO stock; that happens at receive.
 */
export async function createStockTransfer(
  actor: Actor, input: CreateStockTransferInput,
): Promise<{ id: string; status: StockTransferStatus }> {
  authorize(actor, 'create_records', 'logistics')
  const data = createSchema.parse(input)

  // Shape errors (same location, no lines, sub-milli quantities) surface from
  // the pure planner here, before a connection is taken — the plan itself is
  // recomputed at receive time from the persisted lines, never carried over.
  planStockPosting({
    fromLocationId: data.fromLocationId,
    toLocationId: data.toLocationId,
    batchLines: data.batchLines,
    serializedLines: data.serializedLines,
  })

  return withTransaction(actor.id, async (tx) => {
    const { rows: locs } = await tx.query<{ id: string }>(
      `SELECT id FROM stock_location WHERE id = ANY($1) AND deleted_at IS NULL`,
      [[data.fromLocationId, data.toLocationId]])
    if (locs.length !== 2) {
      throw new UnknownReferenceError('One of the selected stock locations does not exist')
    }

    await assertLineTrackingModes(tx, data.batchLines, data.serializedLines)

    let id: string
    try {
      const { rows } = await tx.query<{ id: string; status: StockTransferStatus }>(
        `INSERT INTO stock_transfer
           (transfer_no, from_location_id, to_location_id, initiated_by, carrier, reference,
            notes, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$4,$4)
         RETURNING id, status`,
        [data.transferNo, data.fromLocationId, data.toLocationId, actor.id,
         data.carrier ?? null, data.reference ?? null, data.notes ?? null])
      id = rows[0].id
    } catch (err) {
      rethrowDbError(err, data.transferNo)
    }

    let lineNo = 1
    for (const line of data.batchLines) {
      await tx.query(
        `INSERT INTO stock_transfer_line
           (stock_transfer_id, line_no, component_type_id, qty, notes, created_by)
         VALUES ($1,$2,$3,$4::numeric,$5,$6)`,
        [id!, lineNo, line.componentTypeId, line.qty.toFixed(3), line.notes ?? null, actor.id])
      lineNo += 1
    }
    for (const line of data.serializedLines) {
      await tx.query(
        `INSERT INTO stock_transfer_line
           (stock_transfer_id, line_no, component_unit_id, notes, created_by)
         VALUES ($1,$2,$3,$4,$5)`,
        [id!, lineNo, line.componentUnitId, line.notes ?? null, actor.id])
      lineNo += 1
    }

    return { id: id!, status: 'draft' }
  })
}

// ─── Status change (everything except receive) ──────────────────────────────

const changeStatusSchema = z.object({
  stockTransferId: z.string().uuid(),
  // 'received' is deliberately absent: receiving POSTS STOCK and must go
  // through receiveStockTransfer. Allowing it here would let a caller flip the
  // status without ever moving a balance — mirrors updateDeliveryOrder
  // excluding `status` from its editable columns, for a much sharper reason.
  toStatus: z.enum(['dispatched', 'cancelled']),
  version: z.number().int().nonnegative(),
})
export type ChangeTransferStatusInput = z.input<typeof changeStatusSchema>

export async function changeTransferStatus(
  actor: Actor, input: ChangeTransferStatusInput,
): Promise<{ status: StockTransferStatus; version: number }> {
  authorize(actor, 'edit_records', 'logistics')
  const data = changeStatusSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ status: StockTransferStatus; version: number }>(
      `SELECT status, version FROM stock_transfer
        WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [data.stockTransferId])
    if (rows.length === 0) throw new StockTransferNotFoundError(data.stockTransferId)
    const current = rows[0]

    const decision = evaluateTransferStatusChange(current.status, data.toStatus)
    if (!decision.ok) {
      throw new InvalidTransferStatusChangeError(
        decision.error, messageForTransferStatusChangeError(current.status, data.toStatus))
    }
    if (current.version !== data.version) {
      throw new OptimisticLockError('stock_transfer', data.stockTransferId)
    }

    const stampDispatch = data.toStatus === 'dispatched'
    const { rows: updated } = await tx.query<{ version: number }>(
      `UPDATE stock_transfer
          SET status = $1, updated_at = now(), updated_by = $2, version = version + 1,
              dispatched_at = CASE WHEN $3 THEN COALESCE(dispatched_at, now()) ELSE dispatched_at END
        WHERE id = $4 AND version = $5
        RETURNING version`,
      [data.toStatus, actor.id, stampDispatch, data.stockTransferId, data.version])
    if (updated.length === 0) throw new OptimisticLockError('stock_transfer', data.stockTransferId)

    return { status: data.toStatus, version: updated[0].version }
  })
}

// ─── Receive: THE posting logic ─────────────────────────────────────────────

const receiveSchema = z.object({
  stockTransferId: z.string().uuid(),
  version: z.number().int().nonnegative(),
})
export type ReceiveStockTransferInput = z.input<typeof receiveSchema>

export type ReceiveResult = {
  status: StockTransferStatus
  version: number
  /** Post-movement balances at both ends, for the confirmation UI. */
  postedBalances: { locationId: string; componentTypeId: string; qty: number }[]
}

/**
 * Receive a transfer: decrement the source, increment the destination, relocate
 * the serialized units, and mark the transfer received — ALL in one transaction.
 * Any failure rolls the whole posting back; there is no partially-received state.
 *
 * Read the POSTING CONTRACT at the top of this file before editing. The
 * sequence below is load-bearing in its exact order.
 */
export async function receiveStockTransfer(
  actor: Actor, input: ReceiveStockTransferInput,
): Promise<ReceiveResult> {
  // Permission FIRST, ahead of taking a connection (pinned by the action/service
  // ordering convention — see prepareStatusChange in deviceWriteService.ts).
  authorize(actor, 'edit_records', 'logistics')
  const data = receiveSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    // ── 1. Lock the transfer header. Everything after this is serialized
    //       against any other receive of the SAME transfer.
    const { rows: headers } = await tx.query<{
      id: string; transfer_no: string; status: StockTransferStatus
      from_location_id: string; to_location_id: string; version: number
    }>(
      `SELECT id, transfer_no, status, from_location_id, to_location_id, version
         FROM stock_transfer WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [data.stockTransferId])
    if (headers.length === 0) throw new StockTransferNotFoundError(data.stockTransferId)
    const header = headers[0]

    // ── 2. IDEMPOTENCY GUARD. Evaluated here — inside the transaction, with the
    //       row locked and freshly re-read — and NOT before it. A concurrent
    //       duplicate receive blocks on the FOR UPDATE above; when it wakes it
    //       re-reads status='received', finds no legal edge out of that sink,
    //       and stops here having posted nothing. Hoisting this check outside
    //       the transaction (or above the lock) turns it into a race that
    //       double-posts under a double-click.
    //
    //       Checked BEFORE the version comparison on purpose: a double-receive
    //       should say "already received", not the misleading "someone else
    //       changed this record".
    const decision = evaluateTransferStatusChange(header.status, 'received')
    if (!decision.ok) {
      throw new InvalidTransferStatusChangeError(
        decision.error, messageForTransferStatusChangeError(header.status, 'received'))
    }
    if (header.version !== data.version) {
      throw new OptimisticLockError('stock_transfer', data.stockTransferId)
    }

    // ── 3. Read the persisted lines. The posting plan is ALWAYS recomputed from
    //       these rows, never from whatever the client sent.
    const { rows: lineRows } = await tx.query<{
      component_type_id: string | null; qty: string | null; component_unit_id: string | null
    }>(
      `SELECT component_type_id, qty::text AS qty, component_unit_id
         FROM stock_transfer_line WHERE stock_transfer_id = $1 ORDER BY line_no`,
      [data.stockTransferId])

    const plan = planStockPosting({
      fromLocationId: header.from_location_id,
      toLocationId: header.to_location_id,
      batchLines: lineRows
        .filter((l) => l.component_type_id !== null)
        .map((l) => ({ componentTypeId: l.component_type_id!, qty: Number(l.qty) })),
      serializedLines: lineRows
        .filter((l) => l.component_unit_id !== null)
        .map((l) => ({ componentUnitId: l.component_unit_id! })),
    })

    // ── 4. TAKE EVERY stock_level LOCK UP FRONT, IN plan.lockKeys ORDER.
    //       This loop is the deadlock-avoidance mechanism. Two properties matter
    //       and both are easy to destroy by accident:
    //         (a) ALL locks are acquired before ANY balance is written, so a
    //             transaction never holds a partial set while waiting.
    //         (b) the order is the global sort from stockPosting.ts, identical
    //             for every transaction in the system regardless of which way
    //             its stock is moving. Replacing it with "source first, then
    //             destination" deadlocks A->B against B->A.
    //       Do not reorder, do not merge this into the update loop below, and do
    //       not "optimize" it into a single ORDER BY ... FOR UPDATE over both
    //       rows — the destination row may not exist yet, and a FOR UPDATE that
    //       matches nothing locks nothing.
    const locked = new Map<string, { id: string; qty: string }>()
    for (const key of plan.lockKeys) {
      // Ensure the row exists. ON CONFLICT DO NOTHING waits out a concurrent
      // conflicting insert before returning, so afterwards the row is certainly
      // there. qty defaults to 0, so creating it here is balance-neutral.
      await tx.query(
        `INSERT INTO stock_level (location_id, component_type_id, qty, created_by, updated_by)
         VALUES ($1,$2,0,$3,$3)
         ON CONFLICT (location_id, component_type_id) DO NOTHING`,
        [key.locationId, key.componentTypeId, actor.id])

      // Then lock it. This is deliberately a SECOND statement: folding the
      // INSERT into a CTE and selecting from stock_level in the same statement
      // would read the pre-statement snapshot and miss the row just inserted.
      const { rows } = await tx.query<{ id: string; qty: string }>(
        `SELECT id, qty::text AS qty FROM stock_level
          WHERE location_id = $1 AND component_type_id = $2 FOR UPDATE`,
        [key.locationId, key.componentTypeId])
      locked.set(lockKeyOf(key), rows[0])
    }

    // Labels for readable errors, resolved once. Two plain lookups rather than
    // one UNION — the failure mode being served here is a user-facing error
    // message, so clarity beats saving a round trip.
    const labelOf = new Map<string, string>()
    const typeIds = [...new Set(plan.lockKeys.map((k) => k.componentTypeId))]
    if (typeIds.length > 0) {
      const { rows } = await tx.query<{ id: string; code: string }>(
        `SELECT id, code FROM component_type WHERE id = ANY($1)`, [typeIds])
      for (const r of rows) labelOf.set(r.id, r.code)
    }
    const { rows: locRows } = await tx.query<{ id: string; code: string }>(
      `SELECT id, code FROM stock_location WHERE id = ANY($1)`,
      [[header.from_location_id, header.to_location_id]])
    for (const r of locRows) labelOf.set(r.id, r.code)

    // ── 5. Apply the decrements. The floor is tested in SQL against the numeric
    //       column (`AND qty >= $1`), so the comparison is exact and the failure
    //       is a named domain error rather than the raw CHECK violation. We hold
    //       the row lock, so zero rows updated can only mean insufficient stock.
    const postedBalances: ReceiveResult['postedBalances'] = []
    for (const m of plan.decrements) {
      const row = locked.get(lockKeyOf(m))!
      const amount = fromScaledQty(m.scaledQty)
      const { rows } = await tx.query<{ qty: string }>(
        `UPDATE stock_level
            SET qty = qty - $1::numeric, updated_at = now(), updated_by = $2, version = version + 1
          WHERE id = $3 AND qty >= $1::numeric
          RETURNING qty::text AS qty`,
        [amount, actor.id, row.id])
      if (rows.length === 0) {
        throw new InsufficientStockError(
          labelOf.get(m.componentTypeId) ?? m.componentTypeId,
          labelOf.get(m.locationId) ?? m.locationId,
          amount, row.qty)
      }
      postedBalances.push({
        locationId: m.locationId, componentTypeId: m.componentTypeId, qty: Number(rows[0].qty),
      })
    }

    // ── 6. Apply the increments. No floor to test — adding cannot go negative.
    for (const m of plan.increments) {
      const row = locked.get(lockKeyOf(m))!
      const { rows } = await tx.query<{ qty: string }>(
        `UPDATE stock_level
            SET qty = qty + $1::numeric, updated_at = now(), updated_by = $2, version = version + 1
          WHERE id = $3
          RETURNING qty::text AS qty`,
        [fromScaledQty(m.scaledQty), actor.id, row.id])
      postedBalances.push({
        locationId: m.locationId, componentTypeId: m.componentTypeId, qty: Number(rows[0].qty),
      })
    }

    // ── 7. Relocate the serialized units. SECOND lock class: taken only after
    //       every stock_level lock is held, and ordered by id within itself, so
    //       the two classes together form one total order.
    //
    //       ORDER BY + FOR UPDATE is the ordering mechanism here: Postgres's
    //       LockRows node sits above the Sort, so rows are locked in sorted id
    //       order. Do NOT add a join to component_type to this query for
    //       labelling — a joined table would be locked too (a third lock class,
    //       out of order) and would block unrelated catalogue edits.
    if (plan.serializedUnitIds.length > 0) {
      const { rows: units } = await tx.query<{
        id: string; serial_no: string; location_id: string | null
      }>(
        `SELECT cu.id, cu.serial_no, cu.location_id
           FROM component_unit cu
          WHERE cu.id = ANY($1) AND cu.deleted_at IS NULL
          ORDER BY cu.id
            FOR UPDATE OF cu`,
        [plan.serializedUnitIds])
      if (units.length !== plan.serializedUnitIds.length) {
        throw new UnknownReferenceError(
          'A serialized unit on this transfer no longer exists')
      }

      for (const unit of units) {
        // A NULL location is accepted: component_unit.location_id only landed
        // with the L1 slice, so every pre-existing unit has one, and a transfer
        // is a legitimate way to record where a unit first turns up. A unit sat
        // at a DIFFERENT known location is an error — something moved it since
        // this transfer was raised and receiving it would silently teleport it.
        if (unit.location_id !== null && unit.location_id !== header.from_location_id) {
          throw new SerializedUnitNotAtSourceError(
            unit.serial_no, labelOf.get(header.from_location_id) ?? header.from_location_id)
        }
        await tx.query(
          `UPDATE component_unit
              SET location_id = $1, updated_at = now(), updated_by = $2, version = version + 1
            WHERE id = $3`,
          [header.to_location_id, actor.id, unit.id])
      }
    }

    // ── 8. Finally mark the transfer received. Same version predicate as every
    //       other write path; we still hold the header lock from step 1.
    const { rows: updated } = await tx.query<{ version: number }>(
      `UPDATE stock_transfer
          SET status = 'received', received_at = now(), received_by = $1,
              updated_at = now(), updated_by = $1, version = version + 1
        WHERE id = $2 AND version = $3
        RETURNING version`,
      [actor.id, data.stockTransferId, data.version])
    if (updated.length === 0) throw new OptimisticLockError('stock_transfer', data.stockTransferId)

    return { status: 'received', version: updated[0].version, postedBalances }
  })
}

export { StockPostingError }
