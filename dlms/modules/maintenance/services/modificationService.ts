import { z } from 'zod'
import { withTransaction, OptimisticLockError, type Tx } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'
import { assertSameDevice } from '@/modules/maintenance/services/attributionService'
import {
  MODIFICATION_STATUSES, modificationStatusLabel,
  evaluateModificationTransition, messageForModificationTransitionError,
  InvalidModificationTransitionError,
  evaluateModificationSignOff, messageForModificationSignOffError, ModificationSignOffError,
  isTerminalModificationStatus,
  type ModificationStatus,
} from '@/modules/maintenance/domain/modificationStatus'

/**
 * Modifications (spec §6.3) — the sibling of repairService.ts, built
 * function-for-function to the same shape: authorize first, Zod parse second,
 * one `withTransaction` third; optimistic locking on every write; reads that
 * return null rather than throwing so an id-addressed page 404s instead of
 * confirming a record exists (spec §7.3).
 *
 * WHAT IS DELIBERATELY ABSENT, versus repairService. A repair moves its device
 * Under Repair ↔ Active, so that service carries a cross-module `moveDevice`
 * against Manufacturing's changeDeviceStatus. A modification does not take a
 * device out of service — §6.3 gives it no device-status semantics — so there is
 * no device write here at all, and the module's "read the shared device registry,
 * never write it" rule holds trivially. Component swaps a modification causes are
 * recorded by the §14 replacement primitive, which validates the modificationId
 * against the installation's own device (attributionService).
 *
 * THE MODIFICATION UI NOW EXISTS: app/(platform)/maintenance/modifications
 * (list / new / detail), with server actions in that directory's actions.ts —
 * which is what finally puts this service under __tests__/actionAalPinning.test.ts.
 * The detail page is where the §14 replacement control is reachable with a
 * MODIFICATION attached, as the repair detail page is for a repair.
 *
 * THE GATE THAT PAGE MUST KEEP. The modification detail page repeats the repair
 * page's MANUFACTURING permission gate around the components panel. The panel's
 * services are Manufacturing's (componentService.getDeviceComponents /
 * replaceComponentInstallation) and they THROW on a missing permission rather
 * than returning empty, so a page that renders the panel without first checking
 * `can(actor, 'view_records', 'manufacturing')` is a 500, not a quietly hidden
 * section. Maintenance access alone does not imply Manufacturing access. The
 * same rule governs `listEcoOptions` below, which reaches into ENGINEERING.
 */

export class ModificationNotFoundError extends Error {
  readonly modificationId: string
  constructor(modificationId: string) {
    super(`Modification ${modificationId} not found`)
    this.name = 'ModificationNotFoundError'
    this.modificationId = modificationId
  }
}

/**
 * An edit was attempted on a modification that is closed or cancelled.
 *
 * WHY THIS EXISTS. The sign-off dialog promises the user that a signed-off
 * modification "cannot be reopened or edited afterwards". Without this the
 * promise was false: `updateModification` had no status precondition, so a
 * closed record's cost could be rewritten 500 → 5000 — and because
 * `modification_status_history` logs STATUS changes only, nothing anywhere would
 * record that it happened. That makes sign-off decorative, since the whole point
 * of a terminal state is that what was accepted is what stays.
 *
 * Enforced in the SERVICE, not merely by hiding the form: the server action is
 * directly callable, so a hidden form is a UI convenience and never a control.
 */
export class ModificationTerminalError extends Error {
  readonly modificationId: string
  readonly status: ModificationStatus
  constructor(modificationId: string, status: ModificationStatus) {
    super(`A ${modificationStatusLabel(status).toLowerCase()} modification cannot be edited.`)
    this.name = 'ModificationTerminalError'
    this.modificationId = modificationId
    this.status = status
  }
}

/**
 * A referenced row does not exist (or is soft-deleted). ONE parameterised class
 * rather than repair's dedicated RepairDeviceNotFoundError: a repair has exactly
 * one required reference, so a bespoke class was free there, while a modification
 * has four — device, modification_type, eco, repair — and four near-identical
 * classes would obscure rather than clarify. The discriminant is `reference`, so
 * a caller can still branch precisely.
 */
export type ModificationReference = 'device' | 'modification_type' | 'eco' | 'repair'

export class ModificationReferenceNotFoundError extends Error {
  readonly reference: ModificationReference
  readonly referenceId: string
  constructor(reference: ModificationReference, referenceId: string) {
    super(`Referenced ${reference} ${referenceId} not found`)
    this.name = 'ModificationReferenceNotFoundError'
    this.reference = reference
    this.referenceId = referenceId
  }
}

// The table each reference resolves to. A CONSTANT map, never caller input — the
// interpolation below is safe precisely because the only reachable values are
// these four literals; the id itself is always a bound parameter.
const REFERENCE_TABLE: Record<ModificationReference, string> = {
  device: 'device',
  modification_type: 'modification_type',
  eco: 'eco',
  repair: 'repair',
}

/**
 * "Exists" means LIVE: a soft-deleted row is not a valid target, so linking a
 * modification to a deleted device/ECO/repair is refused the same way an unknown
 * id is. Runs inside the caller's transaction, so a failed check rolls the whole
 * write back.
 */
async function assertReferenceExists(
  tx: Tx, reference: ModificationReference, id: string,
): Promise<void> {
  const { rows } = await tx.query(
    `SELECT 1 FROM ${REFERENCE_TABLE[reference]} WHERE id = $1 AND deleted_at IS NULL`, [id])
  if (rows.length === 0) throw new ModificationReferenceNotFoundError(reference, id)
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')

// ── Option lists (the create/edit forms) ────────────────────────────────────

export type ModificationTypeOption = { id: string; code: string; name: string }

/**
 * The modification_type dropdown, in the vocabulary's own sort order.
 *
 * `active = false` rows are EXCLUDED here and only here. That is the whole
 * meaning of the soft-disable (see the column's COMMENT): an inactive type
 * disappears from the create FORM but stays resolvable on records that already
 * use it, and `createModification` still accepts one so a caller replaying a
 * historical record is not blocked. Filtering in the service instead would break
 * that; filtering nowhere would put retired types back in front of users.
 *
 * CODES ARE NEVER HARDCODED anywhere against this list — the whole point of the
 * table is that a Super Admin adds "Battery pack swap" without a migration, and
 * CLAUDE.md records what assuming seeded codes has already cost this project.
 */
export async function listModificationTypeOptions(
  actor: Actor,
): Promise<ModificationTypeOption[]> {
  authorize(actor, 'view_records', 'maintenance')

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ id: string; code: string; name: string }>(
      `SELECT id, code, name FROM modification_type
        WHERE deleted_at IS NULL AND active = true
        ORDER BY sort, name`)
    return rows.map((r) => ({ id: r.id, code: r.code, name: r.name }))
  })
}

export type ModifiableDevice = { id: string; deviceSn: string | null; statusLabel: string }

/**
 * Devices a modification can be raised against: every live device.
 *
 * Deliberately WITHOUT the `canMoveToUnderRepair` computation listRepairableDevices
 * carries. A modification does not move the device — §6.3 gives it no
 * device-status semantics at all — so there is no status edge to resolve and no
 * offer that could go unhonoured.
 */
export async function listModifiableDevices(
  actor: Actor, limit = 200,
): Promise<ModifiableDevice[]> {
  authorize(actor, 'view_records', 'maintenance')

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      id: string; device_sn: string | null; status_label: string
    }>(
      `SELECT d.id, d.device_sn, s.label_en AS status_label
         FROM device d JOIN status_option s ON s.code = d.status
        WHERE d.deleted_at IS NULL
        ORDER BY d.created_at DESC
        LIMIT $1`, [limit])
    return rows.map((r) => ({
      id: r.id, deviceSn: r.device_sn, statusLabel: r.status_label,
    }))
  })
}

export type RepairOption = { id: string; repairNo: string; status: string }

/**
 * The repairs a modification on THIS device may be linked to.
 *
 * Scoped to the device on purpose: `createModification`/`updateModification`
 * enforce the same-device rule through `assertSameDevice`, so offering another
 * device's repair would be offering a choice the write refuses — the trap the
 * New Repair form's `canMoveToUnderRepair` fix already closed on the other side
 * of this module.
 *
 * Reads the `repair` table directly rather than through repairService: this is
 * Maintenance's own table, and a one-column picker does not need that service's
 * detail projection.
 */
export async function listDeviceRepairOptions(
  actor: Actor, deviceId: string, limit = 50,
): Promise<RepairOption[]> {
  authorize(actor, 'view_records', 'maintenance')

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ id: string; repair_no: string; status: string }>(
      `SELECT id, repair_no, status FROM repair
        WHERE device_id = $1 AND deleted_at IS NULL
        ORDER BY created_at DESC LIMIT $2`, [deviceId, limit])
    return rows.map((r) => ({ id: r.id, repairNo: r.repair_no, status: r.status }))
  })
}

export type EcoOption = { id: string; ecoNo: string; title: string }

/**
 * The ECOs a retrofit modification may cite.
 *
 * GATED ON ENGINEERING, not Maintenance — `eco` is Engineering's table, and a
 * Maintenance user with no Engineering access has no business enumerating its
 * change orders. The caller must therefore check
 * `can(actor, 'view_records', 'engineering')` before calling, exactly as the
 * components panel's caller must check manufacturing: this throws rather than
 * returning empty, so an ungated call is a 500 and not a hidden dropdown.
 *
 * The New Modification page omits the ECO field entirely for an actor without
 * that access; `eco_id` stays nullable and the modification is still valid
 * without it.
 */
export async function listEcoOptions(actor: Actor, limit = 100): Promise<EcoOption[]> {
  authorize(actor, 'view_records', 'engineering')

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ id: string; eco_no: string; title: string }>(
      `SELECT id, eco_no, title FROM eco
        WHERE deleted_at IS NULL
        ORDER BY created_at DESC LIMIT $1`, [limit])
    return rows.map((r) => ({ id: r.id, ecoNo: r.eco_no, title: r.title }))
  })
}

/**
 * Modification counts by state, zero-filled across the fixed vocabulary so the
 * module surface shows every state even when nothing is in it. The sibling of
 * repairService.getRepairStatusCounts.
 */
export async function getModificationStatusCounts(
  actor: Actor,
): Promise<{ status: ModificationStatus; statusLabel: string; count: number }[]> {
  authorize(actor, 'view_records', 'maintenance')

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ status: string; n: string }>(
      `SELECT status, count(*)::text AS n FROM modification
        WHERE deleted_at IS NULL GROUP BY status`)
    const counts = new Map(rows.map((r) => [r.status, Number(r.n)]))
    return MODIFICATION_STATUSES.map((s) => ({
      status: s, statusLabel: modificationStatusLabel(s), count: counts.get(s) ?? 0,
    }))
  })
}

// ── Reads ───────────────────────────────────────────────────────────────────

export type ModificationListItem = {
  id: string
  modificationNo: string
  status: ModificationStatus
  statusLabel: string
  deviceId: string
  deviceSn: string | null
  typeCode: string
  typeName: string
  reason: string | null
  costSgd: string | null
  requestedOn: Date | null
  completedOn: Date | null
  closedAt: Date | null
}

const filterSchema = z.object({
  status: z.array(z.enum(MODIFICATION_STATUSES)).optional(),
  deviceId: z.string().uuid().optional(),
  limit: z.number().int().min(1).max(100).default(50),
  cursor: z.string().optional(),
})
export type ModificationFilter = z.input<typeof filterSchema>

/**
 * The modifications list (spec §6.3). Keyset pagination on (created_at, id) DESC
 * — the same reasoning as listRepairs: OFFSET would drift as modifications are
 * raised during a session. Filterable by status and by device.
 */
export async function listModifications(
  actor: Actor, filter: ModificationFilter = {},
): Promise<{ items: ModificationListItem[]; nextCursor: string | null }> {
  authorize(actor, 'view_records', 'maintenance')
  const f = filterSchema.parse(filter)

  return withTransaction(actor.id, async (tx) => {
    const conditions = ['m.deleted_at IS NULL']
    const params: unknown[] = []
    const p = (v: unknown) => { params.push(v); return `$${params.length}` }

    if (f.status?.length) conditions.push(`m.status = ANY(${p(f.status)})`)
    if (f.deviceId) conditions.push(`m.device_id = ${p(f.deviceId)}`)
    if (f.cursor) {
      const [ts, id] = Buffer.from(f.cursor, 'base64url').toString().split('|')
      conditions.push(`(m.created_at, m.id) < (${p(new Date(ts))}, ${p(id)})`)
    }

    const { rows } = await tx.query<{
      id: string; modification_no: string; status: ModificationStatus; device_id: string
      device_sn: string | null; type_code: string; type_name: string; reason: string | null
      cost_sgd: string | null; requested_on: Date | null; completed_on: Date | null
      closed_at: Date | null; created_at: Date
    }>(
      `SELECT m.id, m.modification_no, m.status, m.device_id, d.device_sn,
              t.code AS type_code, t.name AS type_name, m.reason, m.cost_sgd,
              m.requested_on, m.completed_on, m.closed_at, m.created_at
         FROM modification m
         JOIN device d ON d.id = m.device_id
         JOIN modification_type t ON t.id = m.modification_type_id
        WHERE ${conditions.join(' AND ')}
        ORDER BY m.created_at DESC, m.id DESC
        LIMIT ${p(f.limit + 1)}`, params)

    const hasMore = rows.length > f.limit
    const page = hasMore ? rows.slice(0, f.limit) : rows
    const last = page[page.length - 1]

    return {
      items: page.map((m) => ({
        id: m.id, modificationNo: m.modification_no, status: m.status,
        statusLabel: modificationStatusLabel(m.status),
        deviceId: m.device_id, deviceSn: m.device_sn,
        typeCode: m.type_code, typeName: m.type_name,
        reason: m.reason, costSgd: m.cost_sgd,
        requestedOn: m.requested_on, completedOn: m.completed_on, closedAt: m.closed_at,
      })),
      nextCursor: hasMore && last
        ? Buffer.from(`${last.created_at.toISOString()}|${last.id}`).toString('base64url')
        : null,
    }
  })
}

export type ModificationDetail = {
  id: string
  modificationNo: string
  status: ModificationStatus
  statusLabel: string
  deviceId: string
  deviceSn: string | null
  deviceStatus: string
  deviceStatusLabel: string
  typeId: string
  typeCode: string
  typeName: string
  reason: string | null
  description: string | null
  previousConfiguration: string | null
  newConfiguration: string | null
  ecoId: string | null
  ecoNo: string | null
  repairId: string | null
  repairNo: string | null
  costSgd: string | null
  /**
   * `requested_on` / `completed_on` as YYYY-MM-DD TEXT, alongside the Date
   * fields below.
   *
   * node-postgres parses a bare `date` into a JS Date at LOCAL midnight, so on a
   * host east of UTC `toISOString().slice(0,10)` yields the PREVIOUS day — the
   * one-day shift already carried as a finding against delivery_order's
   * delivered_date and DeviceEditDialog's seeded date. The edit form seeds
   * <input type="date"> from these text fields so a save cannot silently walk a
   * date backwards one day per round trip. The Date fields stay for display
   * formatting and for any existing caller.
   */
  requestedOnText: string | null
  completedOnText: string | null
  requestedOn: Date | null
  completedOn: Date | null
  requestedByName: string | null
  approvedByName: string | null
  completedByName: string | null
  signedOffByName: string | null
  signedOffAt: Date | null
  closedAt: Date | null
  createdAt: Date
  version: number
  statusHistory: {
    fromStatus: string | null; toStatus: string; note: string | null
    changedByName: string; changedAt: Date
  }[]
}

/** Returns null for unknown/soft-deleted ids so the page can 404 (spec §7.3). */
export async function getModification(
  actor: Actor, modificationId: string,
): Promise<ModificationDetail | null> {
  authorize(actor, 'view_records', 'maintenance')

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      id: string; modification_no: string; status: ModificationStatus; device_id: string
      device_sn: string | null; device_status: string; device_status_label: string
      type_id: string; type_code: string; type_name: string
      reason: string | null; description: string | null
      previous_configuration: string | null; new_configuration: string | null
      eco_id: string | null; eco_no: string | null
      repair_id: string | null; repair_no: string | null
      cost_sgd: string | null; requested_on: Date | null; completed_on: Date | null
      requested_on_text: string | null; completed_on_text: string | null
      requested_by_name: string | null; approved_by_name: string | null
      completed_by_name: string | null; signed_off_by_name: string | null
      signed_off_at: Date | null; closed_at: Date | null; created_at: Date; version: number
    }>(
      `SELECT m.id, m.modification_no, m.status, m.device_id, d.device_sn,
              d.status AS device_status, ds.label_en AS device_status_label,
              t.id AS type_id, t.code AS type_code, t.name AS type_name,
              m.reason, m.description, m.previous_configuration, m.new_configuration,
              m.eco_id, e.eco_no, m.repair_id, r.repair_no, m.cost_sgd,
              m.requested_on, m.completed_on,
              m.requested_on::text AS requested_on_text,
              m.completed_on::text AS completed_on_text,
              req.full_name AS requested_by_name, apr.full_name AS approved_by_name,
              cmp.full_name AS completed_by_name, so.full_name AS signed_off_by_name,
              m.signed_off_at, m.closed_at, m.created_at, m.version
         FROM modification m
         JOIN device d ON d.id = m.device_id
         JOIN status_option ds ON ds.code = d.status
         JOIN modification_type t ON t.id = m.modification_type_id
         LEFT JOIN eco e ON e.id = m.eco_id
         LEFT JOIN repair r ON r.id = m.repair_id
         LEFT JOIN app_user req ON req.id = m.requested_by
         LEFT JOIN app_user apr ON apr.id = m.approved_by
         LEFT JOIN app_user cmp ON cmp.id = m.completed_by
         LEFT JOIN app_user so ON so.id = m.signed_off_by
        WHERE m.id = $1 AND m.deleted_at IS NULL`, [modificationId])
    const m = rows[0]
    if (!m) return null

    const history = await tx.query<{
      from_status: string | null; to_status: string; note: string | null
      changed_by_name: string; changed_at: Date
    }>(
      `SELECT h.from_status, h.to_status, h.note, u.full_name AS changed_by_name, h.changed_at
         FROM modification_status_history h JOIN app_user u ON u.id = h.changed_by
        WHERE h.modification_id = $1 ORDER BY h.changed_at DESC`, [modificationId])

    return {
      id: m.id, modificationNo: m.modification_no, status: m.status,
      statusLabel: modificationStatusLabel(m.status),
      deviceId: m.device_id, deviceSn: m.device_sn,
      deviceStatus: m.device_status, deviceStatusLabel: m.device_status_label,
      typeId: m.type_id, typeCode: m.type_code, typeName: m.type_name,
      reason: m.reason, description: m.description,
      previousConfiguration: m.previous_configuration, newConfiguration: m.new_configuration,
      ecoId: m.eco_id, ecoNo: m.eco_no, repairId: m.repair_id, repairNo: m.repair_no,
      costSgd: m.cost_sgd, requestedOn: m.requested_on, completedOn: m.completed_on,
      requestedOnText: m.requested_on_text, completedOnText: m.completed_on_text,
      requestedByName: m.requested_by_name, approvedByName: m.approved_by_name,
      completedByName: m.completed_by_name, signedOffByName: m.signed_off_by_name,
      signedOffAt: m.signed_off_at, closedAt: m.closed_at, createdAt: m.created_at,
      version: m.version,
      statusHistory: history.rows.map((h) => ({
        fromStatus: h.from_status, toStatus: h.to_status, note: h.note,
        changedByName: h.changed_by_name, changedAt: h.changed_at,
      })),
    }
  })
}

// ── Writes ──────────────────────────────────────────────────────────────────

const createSchema = z.object({
  deviceId: z.string().uuid(),
  modificationTypeId: z.string().uuid(),
  reason: z.string().max(5000).optional(),
  description: z.string().max(5000).optional(),
  previousConfiguration: z.string().max(5000).optional(),
  newConfiguration: z.string().max(5000).optional(),
  requestedOn: DATE.optional(),
  requestedBy: z.string().uuid().optional(),
  ecoId: z.string().uuid().optional(),
  repairId: z.string().uuid().optional(),
  costSgd: z.number().nonnegative().optional(),
})
export type CreateModificationInput = z.input<typeof createSchema>

/**
 * Raise a modification against a device at status `requested` (spec §6.3). One
 * transaction: verify every referenced row is live, insert (modification_no
 * auto-assigned by trigger), and write the opening history row so the timeline
 * reads from the first moment — exactly createRepair's shape.
 *
 * `requested_on` defaults to today when the caller doesn't supply it: the column
 * is nullable for BACKFILLED records, not because a record raised right now has
 * no request date. An explicit date is preserved (a modification may be entered
 * days after it was asked for).
 */
export async function createModification(
  actor: Actor, input: CreateModificationInput,
): Promise<{ modificationId: string; modificationNo: string }> {
  authorize(actor, 'create_records', 'maintenance')
  const data = createSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    // The app_user references (requested_by here, the lifecycle stamps later) are
    // left to their FKs, exactly as repairService leaves reported_by/assigned_to.
    // An INACTIVE modification_type is deliberately still accepted: `active` is a
    // soft-disable that hides a type from the create FORM (see the vocabulary's
    // COMMENT), not a claim that the type is unusable — refusing it here would
    // also break any caller replaying a historical record.
    await assertReferenceExists(tx, 'device', data.deviceId)
    await assertReferenceExists(tx, 'modification_type', data.modificationTypeId)
    if (data.ecoId) await assertReferenceExists(tx, 'eco', data.ecoId)
    // A repair link is SAME-DEVICE, not merely live: an ECO applies to a whole
    // fleet, but "the repair this modification arose from" is a claim about
    // this device's history, and one naming another device's repair is a
    // traceability lie the FK cannot see. Existence is checked first so an
    // unknown id still reports as a missing reference, not as a mismatch.
    if (data.repairId) {
      await assertReferenceExists(tx, 'repair', data.repairId)
      await assertSameDevice(tx, 'repair', data.repairId, data.deviceId)
    }

    const { rows } = await tx.query<{ id: string; modification_no: string }>(
      `INSERT INTO modification
         (device_id, modification_type_id, status, reason, description,
          previous_configuration, new_configuration, requested_on, requested_by,
          eco_id, repair_id, cost_sgd, created_by, updated_by)
       VALUES ($1,$2,'requested',$3,$4,$5,$6,COALESCE($7::date, current_date),$8,$9,$10,$11,$12,$12)
       RETURNING id, modification_no`,
      [data.deviceId, data.modificationTypeId, data.reason ?? null, data.description ?? null,
       data.previousConfiguration ?? null, data.newConfiguration ?? null,
       data.requestedOn ?? null, data.requestedBy ?? actor.id,
       data.ecoId ?? null, data.repairId ?? null, data.costSgd ?? null, actor.id])
    const created = rows[0]

    await tx.query(
      `INSERT INTO modification_status_history
         (modification_id, from_status, to_status, changed_by)
       VALUES ($1, NULL, 'requested', $2)`, [created.id, actor.id])

    return { modificationId: created.id, modificationNo: created.modification_no }
  })
}

const updateSchema = z.object({
  modificationId: z.string().uuid(),
  version: z.number().int().nonnegative(),
  modificationTypeId: z.string().uuid().optional(),   // NOT NULL in the schema — never nullish
  reason: z.string().max(5000).nullish(),
  description: z.string().max(5000).nullish(),
  previousConfiguration: z.string().max(5000).nullish(),
  newConfiguration: z.string().max(5000).nullish(),
  requestedOn: DATE.nullish(),
  completedOn: DATE.nullish(),
  ecoId: z.string().uuid().nullish(),
  repairId: z.string().uuid().nullish(),
  costSgd: z.number().nonnegative().nullish(),
})
export type UpdateModificationInput = z.input<typeof updateSchema>

// Editable columns, mapping camelCase input keys → modification columns. `status`
// is deliberately absent: it changes ONLY through changeModificationStatus /
// signOffModification so the transition graph and history log can never be
// bypassed. The three lifecycle actor stamps (requested_by/approved_by/
// completed_by) are absent for the same reason — they are set by the transition
// that earns them, not typed in afterwards.
const UPDATE_COLUMNS: Record<string, string> = {
  modificationTypeId: 'modification_type_id', reason: 'reason', description: 'description',
  previousConfiguration: 'previous_configuration', newConfiguration: 'new_configuration',
  requestedOn: 'requested_on', completedOn: 'completed_on',
  ecoId: 'eco_id', repairId: 'repair_id', costSgd: 'cost_sgd',
}

/**
 * Edit a modification's detail fields under optimistic concurrency (spec §6.3).
 * Only the keys present in the input are written (partial update), so omitting a
 * field leaves it untouched while explicitly passing null clears it — repair's
 * convention. A non-null reference is re-validated here for the same reason it is
 * on create: the FK would catch a nonexistent id, but not a soft-deleted one.
 */
export async function updateModification(
  actor: Actor, input: UpdateModificationInput,
): Promise<{ version: number }> {
  authorize(actor, 'edit_records', 'maintenance')
  const data = updateSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    // device_id comes back from the lock because the repair link is validated
    // against it below; the column itself is not editable (absent from
    // UPDATE_COLUMNS), so the locked value is the whole truth. `status` comes
    // back for the terminal check below.
    const { rows: modRows } = await tx.query<{
      version: number; device_id: string; status: ModificationStatus
    }>(
      `SELECT version, device_id, status FROM modification
        WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [data.modificationId])
    if (modRows.length === 0) throw new ModificationNotFoundError(data.modificationId)
    if (modRows[0].version !== data.version) {
      throw new OptimisticLockError('modification', data.modificationId)
    }
    // A closed or cancelled record is frozen. Checked INSIDE the transaction
    // under the same lock that established the version, so a sign-off committing
    // concurrently with an edit cannot let the edit through on a stale read —
    // the two serialize on this row. `completed` is deliberately NOT terminal:
    // that is the state a signer reads and corrects before accepting.
    if (isTerminalModificationStatus(modRows[0].status)) {
      throw new ModificationTerminalError(data.modificationId, modRows[0].status)
    }

    if (data.modificationTypeId) {
      await assertReferenceExists(tx, 'modification_type', data.modificationTypeId)
    }
    if (data.ecoId) await assertReferenceExists(tx, 'eco', data.ecoId)
    if (data.repairId) {
      await assertReferenceExists(tx, 'repair', data.repairId)
      await assertSameDevice(tx, 'repair', data.repairId, modRows[0].device_id)
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
    const { rows } = await tx.query<{ version: number }>(
      `UPDATE modification SET ${setSql}
        WHERE id = ${p(data.modificationId)} AND version = ${p(data.version)}
        RETURNING version`, params)
    if (rows.length === 0) throw new OptimisticLockError('modification', data.modificationId)
    return { version: rows[0].version }
  })
}

const changeStatusSchema = z.object({
  modificationId: z.string().uuid(),
  toStatus: z.enum(MODIFICATION_STATUSES),
  note: z.string().max(2000).optional(),
  version: z.number().int().nonnegative(),
})
export type ChangeModificationStatusInput = z.input<typeof changeStatusSchema>

/**
 * Move a modification through its lifecycle (spec §6.3), fail-closed via the pure
 * domain. One transaction: lock the row, check the optimistic version, evaluate
 * the move (a note is required to cancel), UPDATE, and append history.
 *
 * Each transition stamps the actor the state is named for — approved_by on
 * `approved`, completed_by on `completed` — which is the whole reason the state
 * set has one state per §6.3 stamp. Moving to `completed` also fills completed_on
 * with today IF it is still blank, the same auto-stamp deliveryOrderService
 * applies to delivered_date; an explicitly recorded completion date always wins,
 * because the work may have been done before anyone updated the record.
 *
 * Closing is NOT reachable here — that is sign-off (signOffModification); the
 * pure graph rejects every edge into `closed` as transition_forbidden.
 */
export async function changeModificationStatus(
  actor: Actor, input: ChangeModificationStatusInput,
): Promise<{ status: ModificationStatus; version: number }> {
  authorize(actor, 'edit_records', 'maintenance')
  const data = changeStatusSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ status: ModificationStatus; version: number }>(
      `SELECT status, version FROM modification WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [data.modificationId])
    if (rows.length === 0) throw new ModificationNotFoundError(data.modificationId)
    const current = rows[0]
    if (current.version !== data.version) {
      throw new OptimisticLockError('modification', data.modificationId)
    }

    const decision = evaluateModificationTransition(current.status, data.toStatus, {
      note: data.note ?? null,
    })
    if (!decision.ok) {
      throw new InvalidModificationTransitionError(
        decision.error,
        messageForModificationTransitionError(
          decision.error,
          modificationStatusLabel(current.status), modificationStatusLabel(data.toStatus)))
    }

    // `cancelled` is the only terminal state reachable here (closed is sign-off
    // only), but the condition is written against the set so it stays correct if
    // the graph ever gains another terminal edge.
    const isTerminal = data.toStatus === 'closed' || data.toStatus === 'cancelled'
    const { rows: updated } = await tx.query<{ version: number }>(
      `UPDATE modification
          SET status = $1,
              approved_by  = CASE WHEN $1 = 'approved'  THEN $2 ELSE approved_by END,
              completed_by = CASE WHEN $1 = 'completed' THEN $2 ELSE completed_by END,
              completed_on = CASE WHEN $1 = 'completed'
                                  THEN COALESCE(completed_on, current_date)
                                  ELSE completed_on END,
              closed_at = CASE WHEN $3 THEN now() ELSE closed_at END,
              version = version + 1, updated_at = now(), updated_by = $2
        WHERE id = $4 AND version = $5
        RETURNING version`,
      [data.toStatus, actor.id, isTerminal, data.modificationId, data.version])
    if (updated.length === 0) throw new OptimisticLockError('modification', data.modificationId)

    await tx.query(
      `INSERT INTO modification_status_history
         (modification_id, from_status, to_status, note, changed_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [data.modificationId, current.status, data.toStatus, data.note?.trim() || null, actor.id])

    return { status: data.toStatus, version: updated[0].version }
  })
}

const signOffSchema = z.object({
  modificationId: z.string().uuid(),
  version: z.number().int().nonnegative(),
})
export type SignOffModificationInput = z.input<typeof signOffSchema>

/**
 * Sign off a modification — the ONLY route to `closed`, gated on the same
 * permission the modification table's COMMENT names and repairService's sign-off
 * uses (sign_off_repairs; there is no separate sign_off_modifications in the
 * §3.2 permission catalogue, and inventing one would need an RBAC migration and
 * a seed-matrix change, which this slice is not).
 *
 * One transaction: lock the row, enforce the pure precondition (must be
 * `completed`), stamp signed_off_by/at and closed_at, set status closed, append
 * history. Unlike repair's sign-off there is no device to return to service — a
 * modification never took it out of service.
 */
export async function signOffModification(
  actor: Actor, input: SignOffModificationInput,
): Promise<{ status: ModificationStatus; version: number }> {
  authorize(actor, 'sign_off_repairs', 'maintenance')
  const data = signOffSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ status: ModificationStatus; version: number }>(
      `SELECT status, version FROM modification WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [data.modificationId])
    if (rows.length === 0) throw new ModificationNotFoundError(data.modificationId)
    const current = rows[0]
    if (current.version !== data.version) {
      throw new OptimisticLockError('modification', data.modificationId)
    }

    const decision = evaluateModificationSignOff({ status: current.status })
    if (!decision.ok) {
      throw new ModificationSignOffError(
        decision.error, messageForModificationSignOffError(decision.error))
    }

    const { rows: updated } = await tx.query<{ version: number }>(
      `UPDATE modification
          SET status = 'closed', signed_off_by = $1, signed_off_at = now(), closed_at = now(),
              version = version + 1, updated_at = now(), updated_by = $1
        WHERE id = $2 AND version = $3
        RETURNING version`,
      [actor.id, data.modificationId, data.version])
    if (updated.length === 0) throw new OptimisticLockError('modification', data.modificationId)

    await tx.query(
      `INSERT INTO modification_status_history
         (modification_id, from_status, to_status, note, changed_by)
       VALUES ($1, 'completed', 'closed', 'Signed off', $2)`, [data.modificationId, actor.id])

    return { status: 'closed', version: updated[0].version }
  })
}
