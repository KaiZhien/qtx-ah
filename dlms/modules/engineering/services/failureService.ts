import { z } from 'zod'
import { withTransaction, OptimisticLockError } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'
import { createEco } from '@/modules/engineering/services/engineeringWriteService'
import {
  FAILURE_STATUSES, FAILURE_INITIAL_STATUS, failureStatusLabel,
  evaluateFailureTransition, messageForFailureTransitionError, InvalidFailureTransitionError,
  isTerminalFailureStatus, type FailureStatus,
} from '@/modules/engineering/domain/failureStatus'

/**
 * Failure investigations / RCA (spec §6.3 `failure_investigation`).
 *
 * Same discipline as every other platform service:
 *   1. authorize(...) FIRST, and ahead of taking a connection — a denied call
 *      must never reach the pool (manufacturing/services/deviceWriteService.ts
 *      changeDeviceStatus is the reference shape);
 *   2. everything inside ONE withTransaction(actor.id, ...) so fn_audit
 *      attributes the write and a throw rolls the whole thing back;
 *   3. FOR UPDATE on every read-feeds-write, then an explicit optimistic
 *      `version` check → OptimisticLockError;
 *   4. `version = version + 1` written by hand, never by a trigger.
 *
 * Read + write live in one file, mirroring maintenance/services/repairService.ts
 * (the closest analogue: one entity, one lifecycle, one detail page) rather than
 * engineering's multi-entity read/write split.
 */

export class FailureNotFoundError extends Error {
  readonly id: string
  constructor(id: string) {
    super(`Failure investigation ${id} not found`)
    this.name = 'FailureNotFoundError'
    this.id = id
  }
}

/** A device / repair / ECO named on an FI that does not exist (or is deleted). */
export class FailureSubjectNotFoundError extends Error {
  readonly subject: 'device' | 'repair' | 'change order'
  constructor(subject: 'device' | 'repair' | 'change order') {
    super(`That ${subject} no longer exists`)
    this.name = 'FailureSubjectNotFoundError'
    this.subject = subject
  }
}

export type EscalationErrorCode = 'terminal' | 'root_cause_required' | 'already_escalated'

export class FailureEscalationError extends Error {
  readonly code: EscalationErrorCode
  constructor(code: EscalationErrorCode, message: string) {
    super(message)
    this.name = 'FailureEscalationError'
    this.code = code
  }
}

const SEVERITY = z.enum(['low', 'normal', 'high', 'critical'])
const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')

// Escape LIKE metacharacters so a needle containing %/_ can't act as a wildcard.
function likeNeedle(q: string): string {
  return `%${q.toLowerCase().replace(/[\\%_]/g, (c) => `\\${c}`)}%`
}
function encodeCursor(createdAt: Date, id: string): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString('base64url')
}
function decodeCursor(cursor: string): [Date, string] {
  const [ts, id] = Buffer.from(cursor, 'base64url').toString().split('|')
  return [new Date(ts), id]
}

// ═══════════════════════════ Reads ══════════════════════════════════════════

export type FailureListItem = {
  id: string; fiNo: string; title: string
  status: FailureStatus; statusLabel: string; severity: string
  deviceId: string | null; deviceLabel: string | null
  ecoId: string | null; ecoNo: string | null
  createdAt: Date
}

export type FailureDetail = FailureListItem & {
  description: string | null; containment: string | null
  rootCause: string | null; correctiveAction: string | null
  repairId: string | null; repairNo: string | null
  reportedByName: string | null; assignedToName: string | null; assignedTo: string | null
  openedAt: Date; closedAt: Date | null
  version: number; createdByName: string; updatedAt: Date
}

const filterSchema = z.object({
  q: z.string().max(100).optional(),
  status: z.array(z.string()).optional(),
  severity: z.array(z.string()).optional(),
  deviceId: z.string().uuid().optional(),
  repairId: z.string().uuid().optional(),
  ecoId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
})
export type FailureFilter = z.input<typeof filterSchema>

/**
 * Keyset-paginated FI list on (created_at DESC, id DESC) — same reason as
 * listDevices/listEcrs: OFFSET drifts as rows are inserted mid-session.
 */
export async function listFailures(
  actor: Actor, filter: FailureFilter = {},
): Promise<{ items: FailureListItem[]; nextCursor: string | null }> {
  authorize(actor, 'view_records', 'engineering')
  const f = filterSchema.parse(filter)

  return withTransaction(actor.id, async (tx) => {
    const conditions = ['f.deleted_at IS NULL']
    const params: unknown[] = []
    const p = (v: unknown) => { params.push(v); return `$${params.length}` }

    if (f.q) {
      const needle = p(likeNeedle(f.q))
      conditions.push(
        `(lower(f.fi_no) LIKE ${needle} ESCAPE '\\' OR lower(f.title) LIKE ${needle} ESCAPE '\\')`)
    }
    if (f.status?.length) conditions.push(`f.status = ANY(${p(f.status)})`)
    if (f.severity?.length) conditions.push(`f.severity = ANY(${p(f.severity)})`)
    if (f.deviceId) conditions.push(`f.device_id = ${p(f.deviceId)}`)
    if (f.repairId) conditions.push(`f.repair_id = ${p(f.repairId)}`)
    if (f.ecoId) conditions.push(`f.eco_id = ${p(f.ecoId)}`)
    if (f.cursor) {
      const [ts, id] = decodeCursor(f.cursor)
      conditions.push(`(f.created_at, f.id) < (${p(ts)}, ${p(id)})`)
    }

    const { rows } = await tx.query<{
      id: string; fi_no: string; title: string; status: FailureStatus; severity: string
      device_id: string | null; device_sn: string | null; device_legacy: string | null
      eco_id: string | null; eco_no: string | null; created_at: Date
    }>(
      `SELECT f.id, f.fi_no, f.title, f.status, f.severity,
              f.device_id, d.device_sn, d.pcba_a_sn_legacy AS device_legacy,
              f.eco_id, o.eco_no, f.created_at
         FROM failure_investigation f
         LEFT JOIN device d ON d.id = f.device_id
         LEFT JOIN eco o ON o.id = f.eco_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY f.created_at DESC, f.id DESC
        LIMIT ${p(f.limit + 1)}`, params)

    const hasMore = rows.length > f.limit
    const page = hasMore ? rows.slice(0, f.limit) : rows
    const last = page[page.length - 1]
    return {
      items: page.map((r) => ({
        id: r.id, fiNo: r.fi_no, title: r.title, status: r.status,
        statusLabel: failureStatusLabel(r.status), severity: r.severity,
        deviceId: r.device_id, deviceLabel: r.device_sn ?? r.device_legacy,
        ecoId: r.eco_id, ecoNo: r.eco_no, createdAt: r.created_at,
      })),
      nextCursor: hasMore && last ? encodeCursor(last.created_at, last.id) : null,
    }
  })
}

/** null for unknown / soft-deleted, so the page 404s without a thrown path (spec §7.3). */
export async function getFailure(actor: Actor, id: string): Promise<FailureDetail | null> {
  authorize(actor, 'view_records', 'engineering')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      id: string; fi_no: string; title: string; status: FailureStatus; severity: string
      description: string | null; containment: string | null
      root_cause: string | null; corrective_action: string | null
      device_id: string | null; device_sn: string | null; device_legacy: string | null
      repair_id: string | null; repair_no: string | null
      eco_id: string | null; eco_no: string | null
      reported_by_name: string | null; assigned_to: string | null; assigned_to_name: string | null
      opened_at: Date; closed_at: Date | null; version: number
      created_by_name: string; created_at: Date; updated_at: Date
    }>(
      `SELECT f.id, f.fi_no, f.title, f.status, f.severity, f.description, f.containment,
              f.root_cause, f.corrective_action,
              f.device_id, d.device_sn, d.pcba_a_sn_legacy AS device_legacy,
              f.repair_id, r.repair_no, f.eco_id, o.eco_no,
              rep.full_name AS reported_by_name,
              f.assigned_to, asg.full_name AS assigned_to_name,
              f.opened_at, f.closed_at, f.version,
              u.full_name AS created_by_name, f.created_at, f.updated_at
         FROM failure_investigation f
         LEFT JOIN device d ON d.id = f.device_id
         LEFT JOIN repair r ON r.id = f.repair_id
         LEFT JOIN eco o ON o.id = f.eco_id
         LEFT JOIN app_user rep ON rep.id = f.reported_by
         LEFT JOIN app_user asg ON asg.id = f.assigned_to
         JOIN app_user u ON u.id = f.created_by
        WHERE f.id = $1 AND f.deleted_at IS NULL`, [id])
    const r = rows[0]
    if (!r) return null
    return {
      id: r.id, fiNo: r.fi_no, title: r.title, status: r.status,
      statusLabel: failureStatusLabel(r.status), severity: r.severity,
      description: r.description, containment: r.containment,
      rootCause: r.root_cause, correctiveAction: r.corrective_action,
      deviceId: r.device_id, deviceLabel: r.device_sn ?? r.device_legacy,
      repairId: r.repair_id, repairNo: r.repair_no,
      ecoId: r.eco_id, ecoNo: r.eco_no,
      reportedByName: r.reported_by_name, assignedTo: r.assigned_to,
      assignedToName: r.assigned_to_name,
      openedAt: r.opened_at, closedAt: r.closed_at, version: r.version,
      createdByName: r.created_by_name, createdAt: r.created_at, updatedAt: r.updated_at,
    }
  })
}

export type FailureHistoryEntry = {
  id: string; fromStatus: string | null; toStatus: string
  fromLabel: string | null; toLabel: string
  note: string | null; changedByName: string; changedAt: Date
}

/** The append-only timeline the detail page renders, newest first. */
export async function listFailureStatusHistory(
  actor: Actor, failureId: string,
): Promise<FailureHistoryEntry[]> {
  authorize(actor, 'view_records', 'engineering')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      id: string; from_status: string | null; to_status: string; note: string | null
      changed_by_name: string; changed_at: Date
    }>(
      `SELECT h.id, h.from_status, h.to_status, h.note,
              u.full_name AS changed_by_name, h.changed_at
         FROM failure_status_history h
         JOIN app_user u ON u.id = h.changed_by
        WHERE h.failure_id = $1
        ORDER BY h.changed_at DESC, h.id DESC`, [failureId])
    return rows.map((r) => ({
      id: r.id, fromStatus: r.from_status, toStatus: r.to_status,
      fromLabel: r.from_status ? failureStatusLabel(r.from_status) : null,
      toLabel: failureStatusLabel(r.to_status),
      note: r.note, changedByName: r.changed_by_name, changedAt: r.changed_at,
    }))
  })
}

export type FailureStatusCount = { status: FailureStatus; statusLabel: string; count: number }

/** Status-grouped counts for the Engineering landing card. */
export async function getFailureStatusCounts(actor: Actor): Promise<FailureStatusCount[]> {
  authorize(actor, 'view_records', 'engineering')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ status: FailureStatus; count: string }>(
      `SELECT status, count(*)::text AS count FROM failure_investigation
        WHERE deleted_at IS NULL GROUP BY status`)
    return rows.map((r) => ({
      status: r.status, statusLabel: failureStatusLabel(r.status), count: Number(r.count),
    }))
  })
}

// ── Pickers ────────────────────────────────────────────────────────────────

export type PickerOption = { id: string; label: string }

/** Devices an investigation can be raised against (optional link). */
export async function listFailureDeviceOptions(
  actor: Actor, limit = 200,
): Promise<PickerOption[]> {
  authorize(actor, 'view_records', 'engineering')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ id: string; device_sn: string | null; legacy: string | null }>(
      `SELECT id, device_sn, pcba_a_sn_legacy AS legacy FROM device
        WHERE deleted_at IS NULL ORDER BY created_at DESC LIMIT $1`, [limit])
    return rows.map((r) => ({ id: r.id, label: r.device_sn ?? r.legacy ?? r.id }))
  })
}

/** Repairs an investigation can hang off (optional link). */
export async function listFailureRepairOptions(
  actor: Actor, limit = 200,
): Promise<PickerOption[]> {
  authorize(actor, 'view_records', 'engineering')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ id: string; repair_no: string; device_sn: string | null }>(
      `SELECT r.id, r.repair_no, d.device_sn
         FROM repair r LEFT JOIN device d ON d.id = r.device_id
        WHERE r.deleted_at IS NULL ORDER BY r.created_at DESC LIMIT $1`, [limit])
    return rows.map((r) => ({
      id: r.id, label: r.device_sn ? `${r.repair_no} — ${r.device_sn}` : r.repair_no,
    }))
  })
}

/**
 * Change orders an investigation can escalate INTO. Terminal ECOs are excluded:
 * escalating into an already-implemented or rejected order records a design
 * decision that was never actually taken for this failure.
 */
export async function listEscalationEcoOptions(
  actor: Actor, limit = 100,
): Promise<PickerOption[]> {
  authorize(actor, 'view_records', 'engineering')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ id: string; eco_no: string; title: string }>(
      `SELECT id, eco_no, title FROM eco
        WHERE deleted_at IS NULL AND status IN ('draft','submitted','approved')
        ORDER BY created_at DESC LIMIT $1`, [limit])
    return rows.map((r) => ({ id: r.id, label: `${r.eco_no} — ${r.title}` }))
  })
}

// ═══════════════════════════ Writes ═════════════════════════════════════════

const createSchema = z.object({
  title: z.string().min(1).max(200),
  severity: SEVERITY.default('normal'),
  description: z.string().max(5000).optional(),
  containment: z.string().max(5000).optional(),
  rootCause: z.string().max(5000).optional(),
  correctiveAction: z.string().max(5000).optional(),
  deviceId: z.string().uuid().optional(),
  repairId: z.string().uuid().optional(),
  assignedTo: z.string().uuid().optional(),
})
export type CreateFailureInput = z.input<typeof createSchema>

// Verifies an optional FK target is live before we point at it. Runs inside the
// caller's transaction so the check and the INSERT cannot straddle a delete.
async function assertSubjectExists(
  tx: { query: (t: string, v?: unknown[]) => Promise<{ rows: unknown[] }> },
  table: 'device' | 'repair' | 'eco', id: string,
  subject: 'device' | 'repair' | 'change order',
): Promise<void> {
  const { rows } = await tx.query(
    `SELECT 1 FROM ${table} WHERE id = $1 AND deleted_at IS NULL`, [id])
  if (rows.length === 0) throw new FailureSubjectNotFoundError(subject)
}

/**
 * Open a failure investigation at `open`. One transaction: verify any named
 * device/repair, INSERT (fi_no assigned by trg_fi_assign_no), and write the
 * opening history row so the timeline reads from the very first moment — the
 * same shape as createRepair.
 */
export async function createFailure(
  actor: Actor, input: CreateFailureInput,
): Promise<{ id: string; fiNo: string }> {
  authorize(actor, 'create_records', 'engineering')
  const data = createSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    if (data.deviceId) await assertSubjectExists(tx, 'device', data.deviceId, 'device')
    if (data.repairId) await assertSubjectExists(tx, 'repair', data.repairId, 'repair')

    const { rows } = await tx.query<{ id: string; fi_no: string }>(
      `INSERT INTO failure_investigation
         (title, severity, status, description, containment, root_cause, corrective_action,
          device_id, repair_id, reported_by, assigned_to, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$10,$10)
       RETURNING id, fi_no`,
      [data.title, data.severity, FAILURE_INITIAL_STATUS, data.description ?? null,
       data.containment ?? null, data.rootCause ?? null, data.correctiveAction ?? null,
       data.deviceId ?? null, data.repairId ?? null, actor.id, data.assignedTo ?? null])
    const created = rows[0]

    await tx.query(
      `INSERT INTO failure_status_history (failure_id, from_status, to_status, changed_by)
       VALUES ($1, NULL, $2, $3)`, [created.id, FAILURE_INITIAL_STATUS, actor.id])

    return { id: created.id, fiNo: created.fi_no }
  })
}

const updateSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().nonnegative(),
  title: z.string().min(1).max(200).optional(),
  severity: SEVERITY.optional(),
  description: z.string().max(5000).nullish(),
  containment: z.string().max(5000).nullish(),
  rootCause: z.string().max(5000).nullish(),
  correctiveAction: z.string().max(5000).nullish(),
  deviceId: z.string().uuid().nullish(),
  repairId: z.string().uuid().nullish(),
  assignedTo: z.string().uuid().nullish(),
})
export type UpdateFailureInput = z.input<typeof updateSchema>

// status is absent by construction (changeFailureStatus owns it, so the graph
// and the history log can never be bypassed) and so is eco_id (escalation only).
// root_cause / corrective_action ARE editable here — they are the preconditions
// the lifecycle reads, and they must be recordable before the move that needs them.
const UPDATE_COLUMNS: Record<string, string> = {
  title: 'title', severity: 'severity', description: 'description',
  containment: 'containment', rootCause: 'root_cause',
  correctiveAction: 'corrective_action', deviceId: 'device_id',
  repairId: 'repair_id', assignedTo: 'assigned_to',
}

export async function updateFailure(
  actor: Actor, input: UpdateFailureInput,
): Promise<{ version: number }> {
  authorize(actor, 'edit_records', 'engineering')
  const data = updateSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    const cur = await tx.query<{ version: number }>(
      `SELECT version FROM failure_investigation WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`,
      [data.id])
    if (cur.rows.length === 0) throw new FailureNotFoundError(data.id)
    if (cur.rows[0].version !== data.version) {
      throw new OptimisticLockError('failure_investigation', data.id)
    }
    if (data.deviceId) await assertSubjectExists(tx, 'device', data.deviceId, 'device')
    if (data.repairId) await assertSubjectExists(tx, 'repair', data.repairId, 'repair')

    const params: unknown[] = []
    const p = (v: unknown) => { params.push(v); return `$${params.length}` }
    const sets: string[] = []
    for (const [key, col] of Object.entries(UPDATE_COLUMNS)) {
      const record = data as Record<string, unknown>
      if (key in record && record[key] !== undefined) sets.push(`${col} = ${p(record[key])}`)
    }
    const setSql = [...sets, `updated_at = now()`, `updated_by = ${p(actor.id)}`,
                    `version = version + 1`].join(', ')
    const { rows } = await tx.query<{ version: number }>(
      `UPDATE failure_investigation SET ${setSql}
        WHERE id = ${p(data.id)} AND version = ${p(data.version)} RETURNING version`, params)
    if (rows.length === 0) throw new OptimisticLockError('failure_investigation', data.id)
    return { version: rows[0].version }
  })
}

const changeStatusSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().nonnegative(),
  toStatus: z.enum(FAILURE_STATUSES),
  note: z.string().max(2000).optional(),
})
export type ChangeFailureStatusInput = z.input<typeof changeStatusSchema>

/**
 * Move an investigation through its lifecycle, fail-closed via the pure domain.
 * One transaction: lock the row, check the optimistic version, evaluate the move
 * against the CURRENT root_cause / corrective_action (read under the same lock,
 * so the precondition cannot be satisfied by a value that a concurrent edit is
 * about to blank), UPDATE, and append the history row.
 */
export async function changeFailureStatus(
  actor: Actor, input: ChangeFailureStatusInput,
): Promise<{ status: FailureStatus; version: number }> {
  authorize(actor, 'edit_records', 'engineering')
  const data = changeStatusSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      status: FailureStatus; version: number
      root_cause: string | null; corrective_action: string | null
    }>(
      `SELECT status, version, root_cause, corrective_action
         FROM failure_investigation WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [data.id])
    if (rows.length === 0) throw new FailureNotFoundError(data.id)
    const current = rows[0]
    if (current.version !== data.version) {
      throw new OptimisticLockError('failure_investigation', data.id)
    }

    const decision = evaluateFailureTransition(current.status, data.toStatus, {
      rootCause: current.root_cause,
      correctiveAction: current.corrective_action,
      note: data.note ?? null,
    })
    if (!decision.ok) {
      throw new InvalidFailureTransitionError(
        decision.error,
        messageForFailureTransitionError(
          decision.error, failureStatusLabel(current.status), failureStatusLabel(data.toStatus)))
    }

    const terminal = isTerminalFailureStatus(data.toStatus)
    const { rows: updated } = await tx.query<{ version: number }>(
      `UPDATE failure_investigation
          SET status = $1,
              closed_at = CASE WHEN $2 THEN now() ELSE NULL END,
              updated_at = now(), updated_by = $3, version = version + 1
        WHERE id = $4 AND version = $5 RETURNING version`,
      [data.toStatus, terminal, actor.id, data.id, data.version])
    if (updated.length === 0) throw new OptimisticLockError('failure_investigation', data.id)

    await tx.query(
      `INSERT INTO failure_status_history (failure_id, from_status, to_status, note, changed_by)
       VALUES ($1,$2,$3,$4,$5)`,
      [data.id, current.status, data.toStatus, data.note?.trim() || null, actor.id])

    return { status: data.toStatus, version: updated[0].version }
  })
}

const escalateSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().nonnegative(),
  /** Link an EXISTING change order… */
  ecoId: z.string().uuid().optional(),
  /** …or raise a new one. Exactly one of the two, enforced below. */
  newEco: z.object({
    title: z.string().min(1).max(200),
    description: z.string().max(5000).optional(),
    effectivityDate: DATE.optional(),
    effectivitySerial: z.string().max(200).optional(),
  }).optional(),
}).refine((d) => !!d.ecoId !== !!d.newEco, {
  message: 'Escalate to exactly one change order: pick an existing one or raise a new one',
})
export type EscalateFailureInput = z.input<typeof escalateSchema>

/**
 * Escalate an investigation to a change order (spec §6.3's "eng_change FK when
 * escalated" — here `eco_id`, see the migration header for why the ORDER).
 *
 * Preconditions, all checked under the row lock:
 *   • the investigation is not terminal — a closed/cancelled record is history,
 *     and back-dating a design decision into it hides when it was actually made;
 *   • a root cause IS on record — escalation means "this cause needs a design
 *     change", so with no cause there is nothing to escalate;
 *   • it is not already escalated to a DIFFERENT order (re-linking would erase
 *     the provenance of the first). Re-escalating to the SAME order is an
 *     idempotent no-op, so a double-submitted form does not throw.
 *
 * ECO CREATION IS NOT REIMPLEMENTED HERE: the `newEco` path calls createEco()
 * from engineeringWriteService, which owns numbering, the initial status and its
 * own authorize(create_records). That call runs in its OWN transaction, before
 * the linking transaction below — withTransaction cannot nest or be joined. The
 * seam is real and deliberate: if the process dies between the two, the result
 * is an unlinked DRAFT ECO sitting in the ECO list, which is visible and
 * re-usable via the `ecoId` path — never a lost or half-written FI. Collapsing
 * this into one transaction needs a tx-taking insertEco(tx, ...) from whoever
 * owns the ECO service; see ASSUMPTIONS in the branch report.
 */
export async function escalateFailureToEco(
  actor: Actor, input: EscalateFailureInput,
): Promise<{ ecoId: string; ecoNo: string | null; version: number }> {
  authorize(actor, 'edit_records', 'engineering')
  const data = escalateSchema.parse(input)

  // createEco authorizes create_records itself, before it takes a connection.
  const target = data.newEco
    ? await createEco(actor, data.newEco)
    : { id: data.ecoId!, ecoNo: null as string | null }

  const version = await withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      status: FailureStatus; version: number; root_cause: string | null; eco_id: string | null
    }>(
      `SELECT status, version, root_cause, eco_id FROM failure_investigation
        WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [data.id])
    if (rows.length === 0) throw new FailureNotFoundError(data.id)
    const current = rows[0]
    if (current.version !== data.version) {
      throw new OptimisticLockError('failure_investigation', data.id)
    }
    if (isTerminalFailureStatus(current.status)) {
      throw new FailureEscalationError(
        'terminal',
        `A ${failureStatusLabel(current.status).toLowerCase()} investigation cannot be escalated.`)
    }
    if (!current.root_cause?.trim()) {
      throw new FailureEscalationError(
        'root_cause_required',
        'Record a root cause before escalating to a change order.')
    }
    if (current.eco_id && current.eco_id === target.id) return current.version // idempotent
    if (current.eco_id) {
      throw new FailureEscalationError(
        'already_escalated',
        'This investigation is already escalated to a change order.')
    }

    await assertSubjectExists(tx, 'eco', target.id, 'change order')

    const { rows: updated } = await tx.query<{ version: number }>(
      `UPDATE failure_investigation
          SET eco_id = $1, updated_at = now(), updated_by = $2, version = version + 1
        WHERE id = $3 AND version = $4 RETURNING version`,
      [target.id, actor.id, data.id, data.version])
    if (updated.length === 0) throw new OptimisticLockError('failure_investigation', data.id)
    return updated[0].version
  })

  return { ecoId: target.id, ecoNo: target.ecoNo, version }
}
