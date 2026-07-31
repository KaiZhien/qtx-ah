import { z } from 'zod'
import { withTransaction, OptimisticLockError } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'
import { changeDeviceStatus } from '@/modules/manufacturing/services/deviceWriteService'
import { countInstallationsForRepair } from '@/modules/manufacturing/services/componentService'
import {
  REPAIR_STATUSES, repairStatusLabel,
  evaluateRepairTransition, messageForRepairTransitionError, InvalidRepairTransitionError,
  evaluateSignOff, messageForSignOffError, RepairSignOffError,
  type RepairStatus,
} from '@/modules/maintenance/domain/repairStatus'

export class RepairNotFoundError extends Error {
  constructor(repairId: string) {
    super(`Repair ${repairId} not found`)
    this.name = 'RepairNotFoundError'
  }
}

export class RepairDeviceNotFoundError extends Error {
  constructor(deviceId: string) {
    super(`Device ${deviceId} not found`)
    this.name = 'RepairDeviceNotFoundError'
  }
}

/**
 * The Maintenance module READS the shared device registry directly (spec §4.2:
 * the device record is the hub every module references by device.id). It NEVER
 * writes a device row from here — a device's status is owned by Manufacturing, so
 * every device mutation goes through the manufacturing `changeDeviceStatus`
 * service (moveDeviceUnderRepair / on sign-off below), never a direct UPDATE. The
 * reads are gated on the maintenance module's own permissions.
 */

// ── Reads ───────────────────────────────────────────────────────────────────

export type RepairableDevice = { id: string; deviceSn: string | null; status: string; statusLabel: string }

/**
 * Devices a repair can be opened against, for the New Repair picker. Reads the
 * shared device table under maintenance authz (not manufacturing's — a
 * maintenance user opening a repair need not be able to enter Manufacturing).
 */
export async function listRepairableDevices(actor: Actor, limit = 100): Promise<RepairableDevice[]> {
  authorize(actor, 'view_records', 'maintenance')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      id: string; device_sn: string | null; status: string; status_label: string
    }>(
      `SELECT d.id, d.device_sn, d.status, s.label_en AS status_label
         FROM device d JOIN status_option s ON s.code = d.status
        WHERE d.deleted_at IS NULL
        ORDER BY d.created_at DESC
        LIMIT $1`, [limit])
    return rows.map((r) => ({
      id: r.id, deviceSn: r.device_sn, status: r.status, statusLabel: r.status_label,
    }))
  })
}

export type RepairListItem = {
  id: string
  repairNo: string
  status: RepairStatus
  statusLabel: string
  deviceId: string
  deviceSn: string | null
  faultDescription: string | null
  warrantyFlag: boolean
  costSgd: string | null
  assignedToName: string | null
  openedAt: Date
  closedAt: Date | null
}

const filterSchema = z.object({
  status: z.array(z.enum(REPAIR_STATUSES)).optional(),
  deviceId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
})
export type RepairFilter = z.input<typeof filterSchema>

/**
 * The repairs list (spec §5.3). Keyset pagination on (created_at, id) DESC — the
 * same reasoning as listDevices: OFFSET would drift as repairs are opened during
 * a session. Filterable by status and by device.
 */
export async function listRepairs(
  actor: Actor, filter: RepairFilter = {},
): Promise<{ items: RepairListItem[]; nextCursor: string | null }> {
  authorize(actor, 'view_records', 'maintenance')
  const f = filterSchema.parse(filter)

  return withTransaction(actor.id, async (tx) => {
    const conditions = ['r.deleted_at IS NULL']
    const params: unknown[] = []
    const p = (v: unknown) => { params.push(v); return `$${params.length}` }

    if (f.status?.length) conditions.push(`r.status = ANY(${p(f.status)})`)
    if (f.deviceId) conditions.push(`r.device_id = ${p(f.deviceId)}`)
    if (f.cursor) {
      const [ts, id] = Buffer.from(f.cursor, 'base64url').toString().split('|')
      conditions.push(`(r.created_at, r.id) < (${p(new Date(ts))}, ${p(id)})`)
    }

    const { rows } = await tx.query<{
      id: string; repair_no: string; status: RepairStatus; device_id: string
      device_sn: string | null; fault_description: string | null; warranty_flag: boolean
      cost_sgd: string | null; assigned_to_name: string | null
      opened_at: Date; closed_at: Date | null; created_at: Date
    }>(
      `SELECT r.id, r.repair_no, r.status, r.device_id, d.device_sn, r.fault_description,
              r.warranty_flag, r.cost_sgd, a.full_name AS assigned_to_name,
              r.opened_at, r.closed_at, r.created_at
         FROM repair r
         JOIN device d ON d.id = r.device_id
         LEFT JOIN app_user a ON a.id = r.assigned_to
        WHERE ${conditions.join(' AND ')}
        ORDER BY r.created_at DESC, r.id DESC
        LIMIT ${p(f.limit + 1)}`, params)

    const hasMore = rows.length > f.limit
    const page = hasMore ? rows.slice(0, f.limit) : rows
    const last = page[page.length - 1]

    return {
      items: page.map((r) => ({
        id: r.id, repairNo: r.repair_no, status: r.status, statusLabel: repairStatusLabel(r.status),
        deviceId: r.device_id, deviceSn: r.device_sn, faultDescription: r.fault_description,
        warrantyFlag: r.warranty_flag, costSgd: r.cost_sgd, assignedToName: r.assigned_to_name,
        openedAt: r.opened_at, closedAt: r.closed_at,
      })),
      nextCursor: hasMore && last
        ? Buffer.from(`${last.created_at.toISOString()}|${last.id}`).toString('base64url')
        : null,
    }
  })
}

export type RepairDetail = {
  id: string
  repairNo: string
  status: RepairStatus
  statusLabel: string
  deviceId: string
  deviceSn: string | null
  deviceStatus: string
  deviceStatusLabel: string
  faultDescription: string | null
  diagnosis: string | null
  correctiveAction: string | null
  testingNotes: string | null
  warrantyFlag: boolean
  warrantyJustification: string | null
  costSgd: string | null
  /** The technician's CLAIM that this repair involved a component change. */
  partsReplaced: boolean
  /**
   * How many component_installation rows reference this repair — what BACKS
   * the claim above. Exposed so the page can disable a sign-off that would be
   * refused; the enforcement is signOffRepair's own in-transaction read.
   */
  recordedReplacementCount: number
  reportedByName: string | null
  assignedToName: string | null
  signedOffByName: string | null
  signedOffAt: Date | null
  openedAt: Date
  closedAt: Date | null
  version: number
  statusHistory: {
    fromStatus: string | null; toStatus: string; note: string | null
    changedByName: string; changedAt: Date
  }[]
}

/** Returns null for unknown/soft-deleted ids so the page can 404 (spec §7.3). */
export async function getRepair(actor: Actor, repairId: string): Promise<RepairDetail | null> {
  authorize(actor, 'view_records', 'maintenance')

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      id: string; repair_no: string; status: RepairStatus; device_id: string
      device_sn: string | null; device_status: string; device_status_label: string
      fault_description: string | null; diagnosis: string | null; corrective_action: string | null
      testing_notes: string | null; warranty_flag: boolean; warranty_justification: string | null
      cost_sgd: string | null; parts_replaced: boolean
      reported_by_name: string | null; assigned_to_name: string | null
      signed_off_by_name: string | null; signed_off_at: Date | null
      opened_at: Date; closed_at: Date | null; version: number
    }>(
      `SELECT r.id, r.repair_no, r.status, r.device_id, d.device_sn,
              d.status AS device_status, ds.label_en AS device_status_label,
              r.fault_description, r.diagnosis, r.corrective_action, r.testing_notes,
              r.warranty_flag, r.warranty_justification, r.cost_sgd, r.parts_replaced,
              rep.full_name AS reported_by_name, asg.full_name AS assigned_to_name,
              so.full_name AS signed_off_by_name, r.signed_off_at,
              r.opened_at, r.closed_at, r.version
         FROM repair r
         JOIN device d ON d.id = r.device_id
         JOIN status_option ds ON ds.code = d.status
         LEFT JOIN app_user rep ON rep.id = r.reported_by
         LEFT JOIN app_user asg ON asg.id = r.assigned_to
         LEFT JOIN app_user so ON so.id = r.signed_off_by
        WHERE r.id = $1 AND r.deleted_at IS NULL`, [repairId])
    const r = rows[0]
    if (!r) return null

    const history = await tx.query<{
      from_status: string | null; to_status: string; note: string | null
      changed_by_name: string; changed_at: Date
    }>(
      `SELECT h.from_status, h.to_status, h.note, u.full_name AS changed_by_name, h.changed_at
         FROM repair_status_history h JOIN app_user u ON u.id = h.changed_by
        WHERE h.repair_id = $1 ORDER BY h.changed_at DESC`, [repairId])

    // Manufacturing owns component_installation, so the count comes from its
    // service rather than a join into its table from here.
    const recordedReplacementCount = await countInstallationsForRepair(tx, repairId)

    return {
      id: r.id, repairNo: r.repair_no, status: r.status, statusLabel: repairStatusLabel(r.status),
      deviceId: r.device_id, deviceSn: r.device_sn,
      deviceStatus: r.device_status, deviceStatusLabel: r.device_status_label,
      faultDescription: r.fault_description, diagnosis: r.diagnosis,
      correctiveAction: r.corrective_action, testingNotes: r.testing_notes,
      warrantyFlag: r.warranty_flag, warrantyJustification: r.warranty_justification,
      costSgd: r.cost_sgd, partsReplaced: r.parts_replaced, recordedReplacementCount,
      reportedByName: r.reported_by_name, assignedToName: r.assigned_to_name,
      signedOffByName: r.signed_off_by_name, signedOffAt: r.signed_off_at,
      openedAt: r.opened_at, closedAt: r.closed_at, version: r.version,
      statusHistory: history.rows.map((h) => ({
        fromStatus: h.from_status, toStatus: h.to_status, note: h.note,
        changedByName: h.changed_by_name, changedAt: h.changed_at,
      })),
    }
  })
}

export type RepairStatusCount = { status: RepairStatus; statusLabel: string; count: number }

/**
 * Repair counts by state for the Maintenance landing (spec §8.5: "active repairs
 * by state"). Zero-filled across the whole fixed vocabulary in TS so every state
 * tile always renders, even at zero.
 */
export async function getRepairStatusCounts(actor: Actor): Promise<RepairStatusCount[]> {
  authorize(actor, 'view_records', 'maintenance')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ status: RepairStatus; count: string }>(
      `SELECT status, count(*)::text AS count
         FROM repair WHERE deleted_at IS NULL GROUP BY status`)
    const counts = new Map(rows.map((r) => [r.status, Number(r.count)]))
    return REPAIR_STATUSES.map((s) => ({
      status: s, statusLabel: repairStatusLabel(s), count: counts.get(s) ?? 0,
    }))
  })
}

// ── Writes ────────────────────────────────────────────────────────────────

/**
 * Move a device via Manufacturing's own service, as a SEPARATE transaction from
 * the repair write that triggered it (spec §5.3 basic scope: NON-ATOMIC BY
 * DESIGN — repair and device commit independently; the worst case is a repair
 * that opened/closed without its device having moved, never a lost repair). The
 * move needs change_device_status on Manufacturing, which the acting user may not
 * hold; any failure (permission, no legal edge, stale version) is caught and
 * reported as `moved: false` rather than undoing the already-committed repair.
 */
async function moveDevice(
  actor: Actor, deviceId: string, toStatus: string,
): Promise<boolean> {
  try {
    const version = await withTransaction(actor.id, async (tx) => {
      const { rows } = await tx.query<{ version: number }>(
        `SELECT version FROM device WHERE id = $1 AND deleted_at IS NULL`, [deviceId])
      return rows[0]?.version
    })
    if (version === undefined) return false
    await changeDeviceStatus(actor, { deviceId, toStatus, version })
    return true
  } catch (err) {
    console.error(JSON.stringify({
      level: 'warn', msg: 'repair device move skipped (non-atomic by design)',
      deviceId, toStatus, err: err instanceof Error ? err.message : String(err),
    }))
    return false
  }
}

const createSchema = z.object({
  deviceId: z.string().uuid(),
  faultDescription: z.string().max(5000).optional(),
  diagnosis: z.string().max(5000).optional(),
  reportedBy: z.string().uuid().optional(),
  assignedTo: z.string().uuid().optional(),
  warrantyFlag: z.boolean().default(false),
  warrantyJustification: z.string().max(2000).optional(),
  costSgd: z.number().nonnegative().optional(),
  moveDevice: z.boolean().default(false),
})
export type CreateRepairInput = z.input<typeof createSchema>

/**
 * Open a repair against a device at status `reported` (spec §5.3). One
 * transaction: verify the device exists and isn't soft-deleted, insert the repair
 * (repair_no auto-assigned by trigger), and write the opening history row so the
 * timeline reads from the first moment. When moveDevice is set, ALSO transitions
 * the device → under_repair via Manufacturing's changeDeviceStatus in a SECOND
 * transaction (moveDevice above — non-atomic by design).
 */
export async function createRepair(
  actor: Actor, input: CreateRepairInput,
): Promise<{ repairId: string; repairNo: string; deviceMoved: boolean }> {
  authorize(actor, 'create_records', 'maintenance')
  const data = createSchema.parse(input)

  const { repairId, repairNo } = await withTransaction(actor.id, async (tx) => {
    const { rows: devRows } = await tx.query<{ id: string }>(
      `SELECT id FROM device WHERE id = $1 AND deleted_at IS NULL`, [data.deviceId])
    if (devRows.length === 0) throw new RepairDeviceNotFoundError(data.deviceId)

    const { rows } = await tx.query<{ id: string; repair_no: string }>(
      `INSERT INTO repair
         (device_id, status, fault_description, diagnosis, reported_by, assigned_to,
          warranty_flag, warranty_justification, cost_sgd, created_by, updated_by)
       VALUES ($1,'reported',$2,$3,$4,$5,$6,$7,$8,$9,$9)
       RETURNING id, repair_no`,
      [data.deviceId, data.faultDescription ?? null, data.diagnosis ?? null,
       data.reportedBy ?? actor.id, data.assignedTo ?? null, data.warrantyFlag,
       data.warrantyJustification ?? null, data.costSgd ?? null, actor.id])
    const created = rows[0]

    await tx.query(
      `INSERT INTO repair_status_history (repair_id, from_status, to_status, changed_by)
       VALUES ($1, NULL, 'reported', $2)`, [created.id, actor.id])

    return { repairId: created.id, repairNo: created.repair_no }
  })

  const deviceMoved = data.moveDevice ? await moveDevice(actor, data.deviceId, 'under_repair') : false
  return { repairId, repairNo, deviceMoved }
}

const updateSchema = z.object({
  repairId: z.string().uuid(),
  version: z.number().int().nonnegative(),
  faultDescription: z.string().max(5000).nullish(),
  diagnosis: z.string().max(5000).nullish(),
  correctiveAction: z.string().max(5000).nullish(),
  testingNotes: z.string().max(5000).nullish(),
  assignedTo: z.string().uuid().nullish(),
  warrantyFlag: z.boolean().optional(),
  warrantyJustification: z.string().max(2000).nullish(),
  costSgd: z.number().nonnegative().nullish(),
  partsReplaced: z.boolean().optional(),   // NOT NULL in the schema — never nullish
})
export type UpdateRepairInput = z.input<typeof updateSchema>

// Editable columns, mapping camelCase input keys → repair columns. status is
// deliberately absent: it changes ONLY through changeRepairStatus / signOffRepair
// so the transition graph and history log can never be bypassed. testing_notes is
// editable here — it is the field the sign-off precondition reads.
//
// parts_replaced is editable for the same reason, and ONLY here. It is the
// technician's assertion (see the column's COMMENT), so it must be typed in;
// deriving it from the component record would make the §5.4 precondition
// vacuous — the claim could never disagree with reality, which is precisely the
// disagreement sign-off exists to catch.
const UPDATE_COLUMNS: Record<string, string> = {
  faultDescription: 'fault_description', diagnosis: 'diagnosis',
  correctiveAction: 'corrective_action', testingNotes: 'testing_notes',
  assignedTo: 'assigned_to', warrantyFlag: 'warranty_flag',
  warrantyJustification: 'warranty_justification', costSgd: 'cost_sgd',
  partsReplaced: 'parts_replaced',
}

/**
 * Edit a repair's detail fields (diagnosis, corrective action, testing notes,
 * assignment, warranty, cost) under optimistic concurrency (spec §5.3). Only the
 * keys present in the input are written (partial update), so omitting a field
 * leaves it untouched while explicitly passing null clears it. Status is not
 * editable here by construction — testing_notes IS, because it is the sign-off
 * precondition and must be recordable before sign-off.
 */
export async function updateRepair(
  actor: Actor, input: UpdateRepairInput,
): Promise<{ version: number }> {
  authorize(actor, 'edit_records', 'maintenance')
  const data = updateSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    const { rows: repRows } = await tx.query<{ version: number }>(
      `SELECT version FROM repair WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [data.repairId])
    if (repRows.length === 0) throw new RepairNotFoundError(data.repairId)
    if (repRows[0].version !== data.version) throw new OptimisticLockError('repair', data.repairId)

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
      `UPDATE repair SET ${setSql} WHERE id = ${p(data.repairId)} AND version = ${p(data.version)}
        RETURNING version`, params)
    if (rows.length === 0) throw new OptimisticLockError('repair', data.repairId)
    return { version: rows[0].version }
  })
}

const changeStatusSchema = z.object({
  repairId: z.string().uuid(),
  toStatus: z.enum(REPAIR_STATUSES),
  note: z.string().max(2000).optional(),
  version: z.number().int().nonnegative(),
})
export type ChangeRepairStatusInput = z.input<typeof changeStatusSchema>

/**
 * Move a repair through its lifecycle (spec §5.3), fail-closed via the pure
 * domain. One transaction: lock the repair, check optimistic version, evaluate
 * the move (a note is required to cancel), UPDATE the repair, and append history.
 * Closing from awaiting_sign_off is NOT reachable here — that is sign-off
 * (signOffRepair); the pure graph rejects it as transition_forbidden.
 */
export async function changeRepairStatus(
  actor: Actor, input: ChangeRepairStatusInput,
): Promise<{ status: RepairStatus; version: number }> {
  authorize(actor, 'edit_records', 'maintenance')
  const data = changeStatusSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ status: RepairStatus; version: number }>(
      `SELECT status, version FROM repair WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [data.repairId])
    if (rows.length === 0) throw new RepairNotFoundError(data.repairId)
    const current = rows[0]
    if (current.version !== data.version) throw new OptimisticLockError('repair', data.repairId)

    const decision = evaluateRepairTransition(current.status, data.toStatus, {
      note: data.note ?? null,
    })
    if (!decision.ok) {
      throw new InvalidRepairTransitionError(
        decision.error,
        messageForRepairTransitionError(
          decision.error, repairStatusLabel(current.status), repairStatusLabel(data.toStatus)))
    }

    // Entering a terminal state (closed / cancelled) stamps closed_at.
    const isTerminal = data.toStatus === 'closed' || data.toStatus === 'cancelled'
    const { rows: updated } = await tx.query<{ version: number }>(
      `UPDATE repair
          SET status = $1,
              closed_at = CASE WHEN $2 THEN now() ELSE closed_at END,
              version = version + 1, updated_at = now(), updated_by = $3
        WHERE id = $4 AND version = $5
        RETURNING version`,
      [data.toStatus, isTerminal, actor.id, data.repairId, data.version])
    if (updated.length === 0) throw new OptimisticLockError('repair', data.repairId)

    await tx.query(
      `INSERT INTO repair_status_history (repair_id, from_status, to_status, note, changed_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [data.repairId, current.status, data.toStatus, data.note?.trim() || null, actor.id])

    return { status: data.toStatus, version: updated[0].version }
  })
}

const signOffSchema = z.object({
  repairId: z.string().uuid(),
  version: z.number().int().nonnegative(),
})
export type SignOffRepairInput = z.input<typeof signOffSchema>

/**
 * Sign off a repair (spec §5.3 + §5.4, permission sign_off_repairs). One
 * transaction: lock the repair, enforce the pure precondition, stamp
 * signed_off_by/at, set status closed, append history. THEN — as a second,
 * non-atomic transaction (moveDevice) — return the device Under Repair → Active
 * when it is currently under repair.
 *
 * The precondition now has three facts, not two: awaiting_sign_off, testing
 * notes present, AND — when the repair CLAIMS parts were replaced — at least
 * one component_installation referencing it. That last count is read INSIDE
 * this transaction, after the FOR UPDATE lock, deliberately: a count taken
 * before the transaction could be satisfied when asked and void by the time the
 * repair closes, which would let exactly the failure §5.4 describes slip
 * through under concurrency.
 */
export async function signOffRepair(
  actor: Actor, input: SignOffRepairInput,
): Promise<{ status: RepairStatus; version: number; deviceReturned: boolean }> {
  authorize(actor, 'sign_off_repairs', 'maintenance')
  const data = signOffSchema.parse(input)

  const deviceId = await withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      status: RepairStatus; testing_notes: string | null; parts_replaced: boolean
      version: number; device_id: string
    }>(
      `SELECT status, testing_notes, parts_replaced, version, device_id
         FROM repair WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [data.repairId])
    if (rows.length === 0) throw new RepairNotFoundError(data.repairId)
    const current = rows[0]
    if (current.version !== data.version) throw new OptimisticLockError('repair', data.repairId)

    const decision = evaluateSignOff({
      status: current.status,
      testingNotes: current.testing_notes,
      partsReplaced: current.parts_replaced,
      recordedReplacementCount: await countInstallationsForRepair(tx, data.repairId),
    })
    if (!decision.ok) {
      throw new RepairSignOffError(decision.error, messageForSignOffError(decision.error))
    }

    const { rows: updated } = await tx.query<{ version: number }>(
      `UPDATE repair
          SET status = 'closed', signed_off_by = $1, signed_off_at = now(), closed_at = now(),
              version = version + 1, updated_at = now(), updated_by = $1
        WHERE id = $2 AND version = $3
        RETURNING version`,
      [actor.id, data.repairId, data.version])
    if (updated.length === 0) throw new OptimisticLockError('repair', data.repairId)

    await tx.query(
      `INSERT INTO repair_status_history (repair_id, from_status, to_status, note, changed_by)
       VALUES ($1, 'awaiting_sign_off', 'closed', 'Signed off', $2)`, [data.repairId, actor.id])

    return current.device_id
  })

  // Non-atomic by design: return the device to service only if it is under repair.
  const moved = await moveDeviceToActiveIfUnderRepair(actor, deviceId)
  return { status: 'closed', version: data.version + 1, deviceReturned: moved }
}

/** Reads the device's current status and, only if under_repair, moves it → active. */
async function moveDeviceToActiveIfUnderRepair(actor: Actor, deviceId: string): Promise<boolean> {
  const status = await withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ status: string }>(
      `SELECT status FROM device WHERE id = $1 AND deleted_at IS NULL`, [deviceId])
    return rows[0]?.status
  })
  if (status !== 'under_repair') return false
  return moveDevice(actor, deviceId, 'active')
}
