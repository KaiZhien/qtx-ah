import { z } from 'zod'
import { withTransaction, OptimisticLockError, type Tx } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'
import { BuyerNotFoundError } from '@/modules/finance/services/buyerService'
import {
  evaluateInvoiceStatusChange, allowedInvoiceTransitions, InvalidInvoiceStatusChangeError,
  messageForInvoiceStatusChangeError, INVOICE_STATUSES, type InvoiceStatus,
} from '@/modules/finance/domain/invoiceStatus'
import {
  INVOICE_APPROVAL_ENTITY_TYPE, INVOICE_APPROVAL_KIND,
  buildInvoiceApprovalSnapshot, evaluateInvoiceIssue,
  InvoiceApprovalError, messageForInvoiceApprovalError,
  type InvoiceApprovalSnapshot,
} from '@/modules/finance/domain/invoiceApproval'
import {
  requestApprovalInTx, getApprovalForInTx, type ApprovalRecord,
} from '@/modules/shared/approvals/services/approvalService'
import { describeSnapshotDrift } from '@/modules/shared/approvals/domain/approvalDecision'
import {
  getNumericSettingInTx, FINANCE_APPROVAL_THRESHOLD_SGD,
} from '@/modules/shared/settings/services/settingService'

export class InvoiceNotFoundError extends Error {
  constructor(invoiceId: string) {
    super(`Invoice ${invoiceId} not found`)
    this.name = 'InvoiceNotFoundError'
  }
}

export class DuplicateInvoiceNoError extends Error {
  constructor(invoiceNo: string) {
    super(`An invoice with number "${invoiceNo}" already exists`)
    this.name = 'DuplicateInvoiceNoError'
  }
}

// sales_invoice_invoice_no_unique is a partial unique index (invoice_no,
// WHERE deleted_at IS NULL) -> Postgres 23505. Same mapping shape as
// deviceWriteService.rethrowDbError.
function rethrowDbError(err: unknown, invoiceNo: string | null | undefined): never {
  if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505'
      && invoiceNo) throw new DuplicateInvoiceNoError(invoiceNo)
  throw err
}

export type InvoiceListItem = {
  id: string
  invoiceNo: string
  buyerId: string
  buyerName: string
  status: InvoiceStatus
  issueDate: Date | null
  dueDate: Date | null
  totalSgd: string | null
  createdAt: Date
}

export type InvoiceLine = {
  id: string
  lineNo: number
  description: string
  quantity: string
  unitPriceSgd: string
  amountSgd: string
  deviceId: string | null
  deviceSn: string | null
}

export type InvoiceDetail = InvoiceListItem & {
  subtotalSgd: string | null
  taxSgd: string | null
  currency: string
  notes: string | null
  version: number
  lines: InvoiceLine[]
}

const listFilterSchema = z.object({
  status: z.array(z.enum(INVOICE_STATUSES)).optional(),
  buyerId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
})
export type InvoiceFilter = z.input<typeof listFilterSchema>

/**
 * Sales invoice list (finance module, basic portions — D18: sales invoices
 * only). Reads gated on view_finance (spec §3.2: Viewer never holds it, even
 * with Finance module access — D12 "no field-level masking beyond Finance
 * gating" makes the page-level gate the whole story for this basic build).
 * Keyset pagination on (created_at, id), same convention as
 * deviceReadService.listDevices.
 */
export async function listInvoices(
  actor: Actor, filter: InvoiceFilter,
): Promise<{ items: InvoiceListItem[]; nextCursor: string | null }> {
  authorize(actor, 'view_finance', 'finance')
  const f = listFilterSchema.parse(filter)

  return withTransaction(actor.id, async (tx) => {
    const conditions = ['i.deleted_at IS NULL']
    const params: unknown[] = []
    const p = (v: unknown) => { params.push(v); return `$${params.length}` }

    if (f.status?.length) conditions.push(`i.status = ANY(${p(f.status)})`)
    if (f.buyerId) conditions.push(`i.buyer_id = ${p(f.buyerId)}`)
    if (f.cursor) {
      const [ts, id] = Buffer.from(f.cursor, 'base64url').toString().split('|')
      conditions.push(`(i.created_at, i.id) < (${p(new Date(ts))}, ${p(id)})`)
    }

    const { rows } = await tx.query<{
      id: string; invoice_no: string; buyer_id: string; buyer_name: string; status: InvoiceStatus
      issue_date: Date | null; due_date: Date | null; total_sgd: string | null; created_at: Date
    }>(
      `SELECT i.id, i.invoice_no, i.buyer_id, b.name AS buyer_name, i.status,
              i.issue_date, i.due_date, i.total_sgd, i.created_at
         FROM sales_invoice i JOIN buyer b ON b.id = i.buyer_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY i.created_at DESC, i.id DESC
        LIMIT ${p(f.limit + 1)}`, params)

    const hasMore = rows.length > f.limit
    const page = hasMore ? rows.slice(0, f.limit) : rows
    const last = page[page.length - 1]

    return {
      items: page.map((r) => ({
        id: r.id, invoiceNo: r.invoice_no, buyerId: r.buyer_id, buyerName: r.buyer_name,
        status: r.status, issueDate: r.issue_date, dueDate: r.due_date, totalSgd: r.total_sgd,
        createdAt: r.created_at,
      })),
      nextCursor: hasMore && last
        ? Buffer.from(`${last.created_at.toISOString()}|${last.id}`).toString('base64url')
        : null,
    }
  })
}

/** Returns null for unknown ids so the page can 404 without a thrown error path. */
export async function getInvoice(actor: Actor, invoiceId: string): Promise<InvoiceDetail | null> {
  authorize(actor, 'view_finance', 'finance')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      id: string; invoice_no: string; buyer_id: string; buyer_name: string; status: InvoiceStatus
      issue_date: Date | null; due_date: Date | null; currency: string
      subtotal_sgd: string | null; tax_sgd: string | null; total_sgd: string | null
      notes: string | null; created_at: Date; version: number
    }>(
      `SELECT i.id, i.invoice_no, i.buyer_id, b.name AS buyer_name, i.status,
              i.issue_date, i.due_date, i.currency, i.subtotal_sgd, i.tax_sgd, i.total_sgd,
              i.notes, i.created_at, i.version
         FROM sales_invoice i JOIN buyer b ON b.id = i.buyer_id
        WHERE i.id = $1 AND i.deleted_at IS NULL`, [invoiceId])
    const r = rows[0]
    if (!r) return null

    const lines = await tx.query<{
      id: string; line_no: number; description: string; quantity: string; unit_price_sgd: string
      amount_sgd: string; device_id: string | null; device_sn: string | null
    }>(
      `SELECT l.id, l.line_no, l.description, l.quantity, l.unit_price_sgd, l.amount_sgd,
              l.device_id, d.device_sn
         FROM sales_invoice_line l LEFT JOIN device d ON d.id = l.device_id
        WHERE l.invoice_id = $1 ORDER BY l.line_no`, [invoiceId])

    return {
      id: r.id, invoiceNo: r.invoice_no, buyerId: r.buyer_id, buyerName: r.buyer_name,
      status: r.status, issueDate: r.issue_date, dueDate: r.due_date, currency: r.currency,
      subtotalSgd: r.subtotal_sgd, taxSgd: r.tax_sgd, totalSgd: r.total_sgd, notes: r.notes,
      createdAt: r.created_at, version: r.version,
      lines: lines.rows.map((l) => ({
        id: l.id, lineNo: l.line_no, description: l.description, quantity: l.quantity,
        unitPriceSgd: l.unit_price_sgd, amountSgd: l.amount_sgd, deviceId: l.device_id,
        deviceSn: l.device_sn,
      })),
    }
  })
}

export type InvoiceStatusCount = { status: InvoiceStatus; count: number }

/** One grouped query behind the Finance landing page's counts-by-status widget. */
export async function getInvoiceStatusCounts(actor: Actor): Promise<InvoiceStatusCount[]> {
  authorize(actor, 'view_finance', 'finance')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ status: InvoiceStatus; count: string }>(
      `SELECT s.status, count(i.id)::text AS count
         FROM unnest(ARRAY['draft','issued','paid','void']::text[]) AS s(status)
         LEFT JOIN sales_invoice i ON i.status = s.status AND i.deleted_at IS NULL
        GROUP BY s.status
        ORDER BY array_position(ARRAY['draft','issued','paid','void'], s.status)`)
    return rows.map((r) => ({ status: r.status, count: Number(r.count) }))
  })
}

const lineInputSchema = z.object({
  description: z.string().min(1).max(500),
  quantity: z.number().positive().default(1),
  unitPriceSgd: z.number().nonnegative(),
  deviceId: z.string().uuid().optional(),
})

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')

const createSchema = z.object({
  invoiceNo: z.string().min(1).max(100),
  buyerId: z.string().uuid(),
  issueDate: DATE.optional(),
  dueDate: DATE.optional(),
  taxSgd: z.number().nonnegative().optional(),
  notes: z.string().max(5000).optional(),
  lines: z.array(lineInputSchema).min(1),
})
export type CreateInvoiceInput = z.input<typeof createSchema>

/**
 * Create an invoice + its lines in ONE transaction, always starting at
 * 'draft' (status is otherwise change-only, via changeInvoiceStatus — see
 * deviceWriteService.updateDevice's identical reasoning for why status is
 * absent from this input's shape). amount_sgd and the header totals are
 * computed server-side, in SQL, so Postgres numeric arithmetic — not
 * JS floats — owns the money math.
 */
export async function createInvoice(
  actor: Actor, input: CreateInvoiceInput,
): Promise<{ invoiceId: string }> {
  authorize(actor, 'manage_finance', 'finance')
  const data = createSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    const { rows: buyerRows } = await tx.query<{ id: string }>(
      `SELECT id FROM buyer WHERE id = $1 AND deleted_at IS NULL`, [data.buyerId])
    if (buyerRows.length === 0) throw new BuyerNotFoundError(data.buyerId)

    let invoiceId: string
    try {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO sales_invoice
           (invoice_no, buyer_id, status, issue_date, due_date, tax_sgd, notes, created_by, updated_by)
         VALUES ($1,$2,'draft',$3,$4,$5,$6,$7,$7)
         RETURNING id`,
        [data.invoiceNo, data.buyerId, data.issueDate ?? null, data.dueDate ?? null,
         data.taxSgd ?? null, data.notes ?? null, actor.id])
      invoiceId = rows[0].id
    } catch (err) {
      rethrowDbError(err, data.invoiceNo)
    }

    for (const [i, line] of data.lines.entries()) {
      await tx.query(
        `INSERT INTO sales_invoice_line
           (invoice_id, line_no, description, quantity, unit_price_sgd, amount_sgd, device_id, created_by)
         VALUES ($1,$2,$3,$4,$5, $4::numeric * $5::numeric, $6, $7)`,
        [invoiceId!, i + 1, line.description, line.quantity, line.unitPriceSgd,
         line.deviceId ?? null, actor.id])
    }

    await tx.query(
      `UPDATE sales_invoice SET
         subtotal_sgd = (SELECT COALESCE(SUM(amount_sgd),0) FROM sales_invoice_line WHERE invoice_id = $1),
         total_sgd = (SELECT COALESCE(SUM(amount_sgd),0) FROM sales_invoice_line WHERE invoice_id = $1)
                     + COALESCE(tax_sgd, 0),
         updated_at = now(), updated_by = $2
       WHERE id = $1`, [invoiceId!, actor.id])

    return { invoiceId: invoiceId! }
  })
}

const updateSchema = z.object({
  invoiceId: z.string().uuid(),
  version: z.number().int().nonnegative(),
  invoiceNo: z.string().min(1).max(100).optional(),
  buyerId: z.string().uuid().optional(),
  issueDate: DATE.nullish(),
  dueDate: DATE.nullish(),
  taxSgd: z.number().nonnegative().nullish(),
  notes: z.string().max(5000).nullish(),
})
export type UpdateInvoiceInput = z.input<typeof updateSchema>

// status is deliberately absent — changed ONLY through changeInvoiceStatus, and
// lines are deliberately absent — this basic build has no line-edit path (see
// the sales_invoice_line table comment in the migration).
const UPDATE_COLUMNS: Record<string, string> = {
  invoiceNo: 'invoice_no', buyerId: 'buyer_id', issueDate: 'issue_date', dueDate: 'due_date',
  taxSgd: 'tax_sgd', notes: 'notes',
}

/** Edit an invoice's header fields under optimistic concurrency. Status is not editable here. */
export async function updateInvoice(
  actor: Actor, input: UpdateInvoiceInput,
): Promise<{ version: number }> {
  authorize(actor, 'manage_finance', 'finance')
  const data = updateSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    const { rows: cur } = await tx.query<{ version: number }>(
      `SELECT version FROM sales_invoice WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [data.invoiceId])
    if (cur.length === 0) throw new InvoiceNotFoundError(data.invoiceId)
    if (cur[0].version !== data.version) throw new OptimisticLockError('sales_invoice', data.invoiceId)

    if (data.buyerId !== undefined) {
      const { rows: b } = await tx.query<{ id: string }>(
        `SELECT id FROM buyer WHERE id = $1 AND deleted_at IS NULL`, [data.buyerId])
      if (b.length === 0) throw new BuyerNotFoundError(data.buyerId)
    }

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
        `UPDATE sales_invoice SET ${setSql} WHERE id = ${p(data.invoiceId)} AND version = ${p(data.version)}
          RETURNING version`, params)
      if (rows.length === 0) throw new OptimisticLockError('sales_invoice', data.invoiceId)

      // tax_sgd feeds total_sgd = subtotal_sgd + tax_sgd; recompute when it changed.
      if ('taxSgd' in data) {
        await tx.query(
          `UPDATE sales_invoice SET total_sgd = COALESCE(subtotal_sgd,0) + COALESCE(tax_sgd,0)
            WHERE id = $1`, [data.invoiceId])
      }
      return { version: rows[0].version }
    } catch (err) {
      rethrowDbError(err, data.invoiceNo)
    }
  })
}

// ── The threshold approval gate (spec BR-4) ─────────────────────────────────

/**
 * The projection an approval is granted for, plus the answer to "does the gate
 * apply?", from ONE row read inside the caller's transaction.
 *
 * The threshold comparison happens IN SQL, against the same numeric(12,2) column
 * the money lives in. createInvoice's header states the principle — "Postgres
 * numeric arithmetic — not JS floats — owns the money math" — and it matters most
 * exactly here, on the invoice that sits on the boundary: `>=` in Postgres answers
 * "at or above" for 5000.00 vs 5000 without a float ever existing.
 *
 * COALESCE is cast back to numeric(12,2) so a null total renders "0.00" rather than
 * "0": the snapshot compares as TEXT (see below), and two spellings of zero would
 * be reported as drift by a comparison that is doing exactly what it should.
 */
type InvoiceApprovalProjection = {
  snapshot: InvoiceApprovalSnapshot
  requiresApproval: boolean
}

async function loadApprovalProjection(
  tx: Tx, invoiceId: string, thresholdSgd: string,
): Promise<InvoiceApprovalProjection | null> {
  const { rows } = await tx.query<{
    invoice_no: string; buyer_id: string; buyer_name: string; currency: string
    total_sgd: string; at_or_above: boolean
  }>(
    `SELECT i.invoice_no, i.buyer_id, b.name AS buyer_name, i.currency,
            COALESCE(i.total_sgd, 0)::numeric(12,2) AS total_sgd,
            (COALESCE(i.total_sgd, 0) >= $2::numeric) AS at_or_above
       FROM sales_invoice i JOIN buyer b ON b.id = i.buyer_id
      WHERE i.id = $1 AND i.deleted_at IS NULL`, [invoiceId, thresholdSgd])
  const r = rows[0]
  if (!r) return null
  return {
    // The SAME builder that stores the snapshot builds the projection it is later
    // compared against — see its header for why two builders would drift.
    snapshot: buildInvoiceApprovalSnapshot({
      invoiceNo: r.invoice_no, buyerId: r.buyer_id, buyerName: r.buyer_name,
      currency: r.currency, totalSgd: r.total_sgd,
    }),
    requiresApproval: r.at_or_above,
  }
}

/**
 * The gate on draft → issued, run inside the transaction that already locked the
 * invoice FOR UPDATE.
 *
 * IN the transaction, deliberately. `getApprovalFor` (the public read) opens a
 * connection of its own, which leaves a window between checking the approval and
 * acting on it — long enough for a decision, an edit or a soft-delete to land
 * between the two. `getApprovalForInTx` reads under the same lock that established
 * which invoice is being issued.
 *
 * The threshold is read on EVERY issue, even for an invoice that turns out to be
 * far below it, because "is this invoice gated?" is not answerable without it. A
 * missing or non-numeric knob therefore refuses every issue rather than waving
 * every invoice through — SettingUnavailableError's header has the argument.
 */
async function assertIssuableInTx(tx: Tx, actor: Actor, invoiceId: string): Promise<void> {
  const thresholdSgd = await getNumericSettingInTx(tx, FINANCE_APPROVAL_THRESHOLD_SGD)
  const projection = await loadApprovalProjection(tx, invoiceId, thresholdSgd)
  if (!projection) throw new InvoiceNotFoundError(invoiceId)

  // Below the threshold nothing about this invoice changes — no approval read, no
  // extra permission demanded, no behaviour difference from before the gate existed.
  if (!projection.requiresApproval) return

  const approval = await getApprovalForInTx(
    tx, actor, INVOICE_APPROVAL_ENTITY_TYPE, invoiceId, INVOICE_APPROVAL_KIND)
  const decision = evaluateInvoiceIssue({
    requiresApproval: true,
    thresholdSgd,
    current: projection.snapshot,
    approval: approval && {
      status: approval.status, snapshot: approval.snapshot, decisionNote: approval.decisionNote,
    },
  })
  if (!decision.ok) throw new InvoiceApprovalError(decision.code, decision.message)
}

const requestApprovalSchema = z.object({
  invoiceId: z.string().uuid(),
  version: z.number().int().nonnegative(),
})
export type RequestInvoiceApprovalInput = z.input<typeof requestApprovalSchema>

/**
 * Send an invoice for a second pair of eyes.
 *
 * The `version` is not ceremony: the snapshot records what the requester was
 * LOOKING AT, so a request raised against numbers that have since moved is a
 * request for something nobody saw. Refusing it costs a reload; accepting it puts
 * a stale total in front of an approver.
 *
 * requestApprovalInTx, not requestApproval, and the reason is the one its own
 * header gives: the public entry point opens a transaction of its own, so the
 * invoice would be read under one connection and the snapshot stored under
 * another — describing a state that may already have moved. Here the row is locked,
 * the snapshot is built from the locked row, and the approval plus its outbox event
 * commit with it or not at all.
 */
export async function requestInvoiceApproval(
  actor: Actor, input: RequestInvoiceApprovalInput,
): Promise<{ approvalId: string }> {
  authorize(actor, 'manage_finance', 'finance')
  const data = requestApprovalSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ status: InvoiceStatus; version: number }>(
      `SELECT status, version FROM sales_invoice WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [data.invoiceId])
    if (rows.length === 0) throw new InvoiceNotFoundError(data.invoiceId)
    if (rows[0].version !== data.version) {
      throw new OptimisticLockError('sales_invoice', data.invoiceId)
    }

    const thresholdSgd = await getNumericSettingInTx(tx, FINANCE_APPROVAL_THRESHOLD_SGD)
    if (rows[0].status !== 'draft') {
      throw new InvoiceApprovalError(
        'not_draft', messageForInvoiceApprovalError('not_draft', thresholdSgd))
    }

    const projection = await loadApprovalProjection(tx, data.invoiceId, thresholdSgd)
    if (!projection) throw new InvoiceNotFoundError(data.invoiceId)
    if (!projection.requiresApproval) {
      throw new InvoiceApprovalError(
        'below_threshold', messageForInvoiceApprovalError('below_threshold', thresholdSgd))
    }

    return requestApprovalInTx(tx, actor, {
      entityType: INVOICE_APPROVAL_ENTITY_TYPE,
      entityId: data.invoiceId,
      kind: INVOICE_APPROVAL_KIND,
      // The REQUESTER's own gate, not the approver's — see approvalService's header.
      permission: 'manage_finance',
      label: projection.snapshot.invoiceNo,
      snapshot: projection.snapshot,
    })
  })
}

export type InvoiceApprovalState = {
  /** The live knob, so the UI can name the figure rather than invent one. */
  thresholdSgd: string
  requiresApproval: boolean
  approval: ApprovalRecord | null
  /** Empty unless an APPROVED snapshot no longer describes the invoice. */
  drift: string[]
}

/**
 * Everything the invoice screen needs to say something true about approval, in one
 * read: whether the gate applies, what the threshold currently is, which request
 * governs the record, and — the part a user cannot work out for themselves —
 * whether an approval they already hold has been invalidated by a later edit.
 *
 * Surfacing the drift HERE rather than only at the moment of issue is the whole
 * point: being told what changed while looking at the invoice is actionable, being
 * told after clicking Issue is a dead end.
 *
 * Returns null for an unknown or soft-deleted invoice so the page can 404 without a
 * thrown error path, exactly as getInvoice does.
 */
export async function getInvoiceApprovalState(
  actor: Actor, invoiceId: string,
): Promise<InvoiceApprovalState | null> {
  authorize(actor, 'view_finance', 'finance')
  const id = z.string().uuid().safeParse(invoiceId)
  if (!id.success) return null

  return withTransaction(actor.id, async (tx) => {
    const thresholdSgd = await getNumericSettingInTx(tx, FINANCE_APPROVAL_THRESHOLD_SGD)
    const projection = await loadApprovalProjection(tx, id.data, thresholdSgd)
    if (!projection) return null

    const approval = await getApprovalForInTx(
      tx, actor, INVOICE_APPROVAL_ENTITY_TYPE, id.data, INVOICE_APPROVAL_KIND)
    const drift = approval?.status === 'approved'
      ? describeSnapshotDrift(approval.snapshot, projection.snapshot)
      : []

    return { thresholdSgd, requiresApproval: projection.requiresApproval, approval, drift }
  })
}

const changeStatusSchema = z.object({
  invoiceId: z.string().uuid(),
  toStatus: z.enum(INVOICE_STATUSES),
  version: z.number().int().nonnegative(),
})
export type ChangeInvoiceStatusInput = z.input<typeof changeStatusSchema>

/**
 * Move an invoice through the fixed 4-state flow (modules/finance/domain/
 * invoiceStatus.ts). One transaction: lock the row, evaluate the pure
 * decision, then UPDATE under the same optimistic-lock discipline as
 * deviceWriteService.changeDeviceStatus. A rejected move writes nothing.
 *
 * ONE edge is gated further: draft → issued on an invoice at or above
 * `app_setting.finance_approval_threshold_sgd` needs an approved, non-drifted
 * approval (spec BR-4). The check runs INSIDE this transaction, under the lock
 * that already fixed which invoice is moving — see assertIssuableInTx. Every other
 * edge, including draft → void, is untouched: the gate is on issuing an invoice,
 * not on abandoning one.
 */
export async function changeInvoiceStatus(
  actor: Actor, input: ChangeInvoiceStatusInput,
): Promise<{ status: InvoiceStatus; version: number }> {
  authorize(actor, 'manage_finance', 'finance')
  const data = changeStatusSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ status: InvoiceStatus; version: number }>(
      `SELECT status, version FROM sales_invoice WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [data.invoiceId])
    if (rows.length === 0) throw new InvoiceNotFoundError(data.invoiceId)
    const current = rows[0]
    if (current.version !== data.version) throw new OptimisticLockError('sales_invoice', data.invoiceId)

    const decision = evaluateInvoiceStatusChange(current.status, data.toStatus)
    if (!decision.ok) {
      throw new InvalidInvoiceStatusChangeError(
        decision.error, messageForInvoiceStatusChangeError(decision.error, current.status, data.toStatus))
    }

    // After the transition graph, not before it: "you cannot go from paid to issued"
    // is a truer answer than "that needs an approval" for a move that was never legal.
    if (current.status === 'draft' && data.toStatus === 'issued') {
      await assertIssuableInTx(tx, actor, data.invoiceId)
    }

    const { rows: updated } = await tx.query<{ version: number }>(
      `UPDATE sales_invoice SET status = $1, version = version + 1, updated_at = now(), updated_by = $2
        WHERE id = $3 AND version = $4 RETURNING version`,
      [data.toStatus, actor.id, data.invoiceId, data.version])
    if (updated.length === 0) throw new OptimisticLockError('sales_invoice', data.invoiceId)

    return { status: data.toStatus, version: updated[0].version }
  })
}

/**
 * The allowed next-status moves for the status-change UI. Pure — the graph is
 * a static map, not a DB table (see invoiceStatus.ts) — but still authorized
 * like every other entry point, and async to match the shape
 * listAllowedTransitions (deviceWriteService) established for this call site.
 */
export async function listAllowedInvoiceTransitions(
  actor: Actor, fromStatus: InvoiceStatus,
): Promise<InvoiceStatus[]> {
  authorize(actor, 'view_finance', 'finance')
  return [...allowedInvoiceTransitions(fromStatus)]
}
