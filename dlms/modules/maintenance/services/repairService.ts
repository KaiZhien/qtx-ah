import { z } from 'zod'
import { withTransaction, OptimisticLockError, type Tx } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import { can } from '@/modules/shared/authz/policy'
import type { Actor } from '@/modules/shared/authz/catalog'
import { changeDeviceStatusInTx } from '@/modules/manufacturing/services/deviceWriteService'
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
 * every device mutation goes through the manufacturing `changeDeviceStatusInTx`
 * service (moveDeviceInTx below), never a direct UPDATE. The reads are gated on
 * the maintenance module's own permissions.
 */

// ── Reads ───────────────────────────────────────────────────────────────────

/**
 * The device status a repair puts a device into. Named once, and read by BOTH
 * the picker below (to decide whether to offer the move) and createRepair (to
 * perform it), so the offer and the write cannot drift apart.
 */
const UNDER_REPAIR = 'under_repair'

export type RepairableDevice = {
  id: string
  deviceSn: string | null
  status: string
  statusLabel: string
  /**
   * Does the status graph have an edge from this device's CURRENT status into
   * `under_repair`? Only these devices can be opened with `moveDevice`.
   */
  canMoveToUnderRepair: boolean
}

/**
 * Devices a repair can be opened against, for the New Repair picker. Reads the
 * shared device table under maintenance authz (not manufacturing's — a
 * maintenance user opening a repair need not be able to enter Manufacturing).
 *
 * Every live device is listed: a repair may be opened against a device at ANY
 * status, including one already Under Repair (a second fault found during an
 * existing repair is the ordinary case). What is NOT universal is the optional
 * device move that rides along with it, and since createRepair made that move
 * part of the repair's own transaction, offering it where the graph has no edge
 * would not degrade to "repair opened, device didn't move" — it would throw
 * InvalidStatusChangeError and create NO repair at all. So the edge is resolved
 * HERE, per row, and the form uses it to withhold the checkbox.
 *
 * Asked of `status_transition` rather than hardcoded to the seeded sources
 * (`active`, `returned`): the graph is admin-editable data, and this is the same
 * table changeDeviceStatusInTx consults, so an added edge just works.
 */
export async function listRepairableDevices(actor: Actor, limit = 100): Promise<RepairableDevice[]> {
  authorize(actor, 'view_records', 'maintenance')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      id: string; device_sn: string | null; status: string; status_label: string
      can_move_to_under_repair: boolean
    }>(
      `SELECT d.id, d.device_sn, d.status, s.label_en AS status_label,
              EXISTS (SELECT 1 FROM status_transition st
                       WHERE st.from_status = d.status AND st.to_status = $2)
                AS can_move_to_under_repair
         FROM device d JOIN status_option s ON s.code = d.status
        WHERE d.deleted_at IS NULL
        ORDER BY d.created_at DESC
        LIMIT $1`, [limit, UNDER_REPAIR])
    return rows.map((r) => ({
      id: r.id, deviceSn: r.device_sn, status: r.status, statusLabel: r.status_label,
      canMoveToUnderRepair: r.can_move_to_under_repair,
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
 * May this actor move devices at all? A PURE question — `can` reads the Actor
 * and nothing else — so it is answered BEFORE a connection is acquired, by the
 * two writes below, and it is the ONE reason a repair still commits without its
 * device having moved.
 *
 * It has to stay a permitted outcome. `sign_off_repairs` is a Maintenance
 * permission and `change_device_status` a Manufacturing one; a maintenance
 * manager may well hold the first and not the second, and refusing to let them
 * sign a repair off because they cannot also move the device would be a worse
 * failure than a device left Under Repair for someone else to move. The New
 * Repair page asks the identical question to decide whether to offer the
 * "move this device to Under Repair" checkbox at all, so the two agree by
 * construction.
 *
 * Everything else that could stop the move — the device missing, the transition
 * graph refusing the edge, a stale version, a database error — is NOT tolerated
 * any more: it aborts the repair write with it. See moveDeviceInTx.
 */
function mayMoveDevices(actor: Actor): boolean {
  return can(actor, 'change_device_status', 'manufacturing')
}

/**
 * Move a device inside the CALLER's transaction, through Manufacturing's own
 * Tx-accepting entry point, so the device move and the repair write that caused
 * it commit together or not at all.
 *
 * MA1 ran this as a second, separate transaction and called that non-atomic by
 * design. It is not a design a device registry can keep: `withTransaction`
 * acquires a SEPARATE pooled connection per call, so the repair and the device
 * committed independently, and a crash in the window between them left a closed
 * repair asserting the device was back in service beside a device still reading
 * Under Repair — two records disagreeing about one physical machine, with
 * nothing in the system able to notice or repair the disagreement. Passing the
 * caller's `tx` down closes the window: there is now one COMMIT.
 *
 * The consequence, stated plainly because it IS a behaviour change: a move that
 * the transition graph refuses (no legal edge out of the device's current
 * status) now fails the repair write instead of being swallowed into
 * `moved: false`. That is the point — a half-applied outcome is what was being
 * removed. The one skip that survives is `onlyFrom`, which is a question about
 * intent rather than a failure: sign-off returns a device to service only if it
 * is the one under repair.
 *
 * The device row is locked FOR UPDATE here rather than read and passed
 * optimistically: changeDeviceStatusInTx re-reads it FOR UPDATE and compares
 * versions, so an unlocked read could lose the race with a concurrent status
 * change and surface as a spurious OptimisticLockError on a repair the user did
 * nothing wrong with. Holding the lock across both reads makes the version we
 * pass in the version it still has. Callers lock the `repair` row first and the
 * `device` row here, always in that order, so two of these cannot deadlock.
 */
async function moveDeviceInTx(
  tx: Tx, actor: Actor, deviceId: string, toStatus: string,
  opts: { onlyFrom?: string } = {},
): Promise<boolean> {
  const { rows } = await tx.query<{ status: string; version: number }>(
    `SELECT status, version FROM device WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
    [deviceId])
  const device = rows[0]
  if (!device) return false
  if (opts.onlyFrom !== undefined && device.status !== opts.onlyFrom) return false

  await changeDeviceStatusInTx(tx, actor, { deviceId, toStatus, version: device.version })
  return true
}

/**
 * Says out loud that a device move was not attempted, and why. Worded as the
 * DECISION rather than the outcome ("not attempted", not "skipped"): it is
 * emitted from the permission branch, which cannot know whether the device had
 * anywhere to move — on sign-off the device may never have been Under Repair at
 * all, and claiming a move was skipped would be a small lie in the log.
 */
function logDeviceMoveNotAttempted(deviceId: string, toStatus: string): void {
  console.error(JSON.stringify({
    level: 'warn',
    msg: 'device move not attempted — actor lacks change_device_status in manufacturing',
    deviceId, toStatus,
  }))
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
 * Open a repair against a device at status `reported` (spec §5.3). ONE
 * transaction, and it now covers the device too: verify the device exists and
 * isn't soft-deleted, insert the repair (repair_no auto-assigned by trigger),
 * write the opening history row, and — when moveDevice is set — transition the
 * device → under_repair through Manufacturing's changeDeviceStatusInTx. Either
 * everything lands or nothing does.
 */
export async function createRepair(
  actor: Actor, input: CreateRepairInput,
): Promise<{ repairId: string; repairNo: string; deviceMoved: boolean }> {
  authorize(actor, 'create_records', 'maintenance')
  const data = createSchema.parse(input)
  // Answered before the connection, from the Actor alone — see mayMoveDevices.
  const willMove = data.moveDevice && mayMoveDevices(actor)
  if (data.moveDevice && !willMove) logDeviceMoveNotAttempted(data.deviceId, UNDER_REPAIR)

  return withTransaction(actor.id, async (tx) => {
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

    const deviceMoved = willMove
      ? await moveDeviceInTx(tx, actor, data.deviceId, UNDER_REPAIR)
      : false

    return { repairId: created.id, repairNo: created.repair_no, deviceMoved }
  })
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
 * Sign off a repair (spec §5.3 + §5.4, permission sign_off_repairs). ONE
 * transaction: lock the repair, enforce the pure precondition, stamp
 * signed_off_by/at, set status closed, append history, and return the device
 * Under Repair → Active — all of it, or none of it.
 *
 * That last clause is the whole point of this shape. Closing a repair is an
 * assertion that the device is back in service; committing it separately from
 * the device's own move meant a crash between the two could publish the
 * assertion and not the fact. There is one COMMIT now, so the two cannot
 * disagree.
 *
 * The precondition has three facts, not two: awaiting_sign_off, testing notes
 * present, AND — when the repair CLAIMS parts were replaced — at least one
 * component_installation referencing it. That last count is read INSIDE this
 * transaction, after the FOR UPDATE lock, deliberately: a count taken before
 * the transaction could be satisfied when asked and void by the time the repair
 * closes, which would let exactly the failure §5.4 describes slip through under
 * concurrency.
 *
 * What makes the gate UN-GAMEABLE is a different fact, worth stating because it
 * is easy to assume the wrong one: it is NOT that the count is locked. Nothing
 * here locks component_installation — the FOR UPDATE above takes the `repair`
 * row and only that — so a concurrent replacement can still add rows while this
 * transaction runs. The gate holds because those rows cannot be taken AWAY: an
 * attributed replacement stamps two rows and immediately CLOSES one of them, and
 * fn_component_installation_guard freezes a closed row forever. So once a repair
 * has any backing at all it can never lose the last of it, and a "≥ 1" answer
 * read here stays true past COMMIT. (The still-open half is only protected
 * because componentService COALESCEs on close rather than overwriting — see the
 * comment there; the frozen half is what the gate actually rests on.)
 */
export async function signOffRepair(
  actor: Actor, input: SignOffRepairInput,
): Promise<{ status: RepairStatus; version: number; deviceReturned: boolean }> {
  authorize(actor, 'sign_off_repairs', 'maintenance')
  const data = signOffSchema.parse(input)
  // Pure, and therefore ahead of the connection — see mayMoveDevices.
  const mayMove = mayMoveDevices(actor)

  return withTransaction(actor.id, async (tx) => {
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

    // Return the device to service — only if it IS the device under repair, and
    // in this same transaction. `onlyFrom` is intent, not tolerance: a device
    // already Active (or Returned, or Retired) was never taken out of service by
    // this repair, so there is nothing to give back.
    let deviceReturned = false
    if (mayMove) {
      deviceReturned = await moveDeviceInTx(
        tx, actor, current.device_id, 'active', { onlyFrom: 'under_repair' })
    } else {
      logDeviceMoveNotAttempted(current.device_id, 'active')
    }

    return { status: 'closed' as const, version: updated[0].version, deviceReturned }
  })
}
