import { z } from 'zod'
import { withTransaction, OptimisticLockError } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'
import {
  evaluateStatusChange, InvalidStatusChangeError, messageForStatusChangeError,
} from '@/modules/manufacturing/domain/deviceStatus'

export class DeviceNotFoundError extends Error {
  constructor(deviceId: string) {
    super(`Device ${deviceId} not found`)
    this.name = 'DeviceNotFoundError'
  }
}

const changeStatusSchema = z.object({
  deviceId: z.string().uuid(),
  toStatus: z.string().min(1).max(50),
  reason: z.string().max(2000).optional(),
  version: z.number().int().nonnegative(),
})
export type ChangeStatusInput = z.input<typeof changeStatusSchema>

/**
 * Move a device to a new status through the fail-closed status_transition graph
 * (spec §5.2). One transaction: lock the device row, validate the edge exists,
 * enforce requires_reason and the terminal-needs-delete_records rule, then
 * UPDATE the device (version bump) and INSERT the history row — atomically.
 * A rejected move writes nothing.
 */
export async function changeDeviceStatus(
  actor: Actor, input: ChangeStatusInput,
): Promise<{ status: string; version: number }> {
  authorize(actor, 'change_device_status', 'manufacturing')
  const data = changeStatusSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    // Lock the target device; read the true current status + version.
    const { rows: devRows } = await tx.query<{ status: string; version: number }>(
      `SELECT status, version FROM device
        WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [data.deviceId])
    if (devRows.length === 0) throw new DeviceNotFoundError(data.deviceId)
    const current = devRows[0]
    if (current.version !== data.version) throw new OptimisticLockError('device', data.deviceId)

    // Load the three decision facts in one round trip: does the edge exist +
    // its requires_reason, and is the target terminal + its label (for errors).
    const { rows: factRows } = await tx.query<{
      transition_exists: boolean; requires_reason: boolean
      to_is_terminal: boolean; to_label: string | null; from_label: string
    }>(
      `SELECT (st.from_status IS NOT NULL)                       AS transition_exists,
              COALESCE(st.requires_reason, false)                AS requires_reason,
              so_to.is_terminal                                  AS to_is_terminal,
              so_to.label_en                                     AS to_label,
              so_from.label_en                                   AS from_label
         FROM status_option so_from
         JOIN status_option so_to ON so_to.code = $2
         LEFT JOIN status_transition st
           ON st.from_status = so_from.code AND st.to_status = $2
        WHERE so_from.code = $1`, [current.status, data.toStatus])
    // so_to unknown → no row at all → treat as forbidden with the raw code label.
    const facts = factRows[0]
    const toLabel = facts?.to_label ?? data.toStatus
    const fromLabel = facts?.from_label ?? current.status
    if (!facts) {
      throw new InvalidStatusChangeError(
        'transition_forbidden',
        messageForStatusChangeError('transition_forbidden', fromLabel, toLabel))
    }

    const decision = evaluateStatusChange(
      { transitionExists: facts.transition_exists, requiresReason: facts.requires_reason,
        toIsTerminal: facts.to_is_terminal },
      { reason: data.reason ?? null })
    if (!decision.ok) {
      throw new InvalidStatusChangeError(
        decision.error, messageForStatusChangeError(decision.error, fromLabel, toLabel))
    }
    // Terminal moves (retired/scrapped) need delete_records on top of
    // change_device_status (spec §5.2). Thrown inside the tx → full rollback.
    if (decision.requiresDeletePermission) authorize(actor, 'delete_records', 'manufacturing')

    const { rows: updated } = await tx.query<{ version: number }>(
      `UPDATE device
          SET status = $1, version = version + 1, updated_at = now(), updated_by = $2
        WHERE id = $3 AND version = $4
        RETURNING version`,
      [data.toStatus, actor.id, data.deviceId, data.version])
    if (updated.length === 0) throw new OptimisticLockError('device', data.deviceId)

    await tx.query(
      `INSERT INTO device_status_history (device_id, from_status, to_status, reason, changed_by)
       VALUES ($1, $2, $3, $4, $5)`,
      [data.deviceId, current.status, data.toStatus, data.reason?.trim() || null, actor.id])

    return { status: data.toStatus, version: updated[0].version }
  })
}

export class DuplicateSerialError extends Error {
  constructor(sn: string) {
    super(`A device with serial "${sn}" already exists`)
    this.name = 'DuplicateSerialError'
  }
}

// device_sn_unique is a partial unique index (device_sn IS NOT NULL AND
// deleted_at IS NULL) → Postgres error 23505. Map it to the friendly error;
// re-throw anything else.
function rethrowDbError(err: unknown, deviceSn: string | null | undefined): never {
  if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505'
      && deviceSn) throw new DuplicateSerialError(deviceSn)
  throw err
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')

/**
 * How long each free-text device column may be — what this system considers a
 * valid device row, independent of which write path produced it.
 *
 * Named rather than repeated as literals because there are now three schemas
 * over the same columns: create, update, and the bulk import's draft check
 * (importCommitService.commitOneRow, which reads a draft out of jsonb and must
 * not be able to seat a 50 KB product name the interactive form would refuse).
 * Change a limit here and every write path moves together.
 */
export const DEVICE_FIELD_LIMITS = {
  deviceSn: 100,
  phase: 50,
  productName: 200,
  modelNo: 100,
  customer: 200,
  destination: 200,
  remarks: 5000,
} as const

const createSchema = z.object({
  variantCode: z.string().min(1),
  deviceSn: z.string().max(DEVICE_FIELD_LIMITS.deviceSn).optional(),
  phase: z.string().max(DEVICE_FIELD_LIMITS.phase).optional(),
  productName: z.string().max(DEVICE_FIELD_LIMITS.productName).optional(),
  modelNo: z.string().max(DEVICE_FIELD_LIMITS.modelNo).optional(),
  customer: z.string().max(DEVICE_FIELD_LIMITS.customer).optional(),
  destination: z.string().max(DEVICE_FIELD_LIMITS.destination).optional(),
  remarks: z.string().max(DEVICE_FIELD_LIMITS.remarks).optional(),
  buildDate: DATE.optional(),
  shipDate: DATE.optional(),
  deliveredDate: DATE.optional(),
})
export type CreateDeviceInput = z.input<typeof createSchema>

/**
 * Create a device at the vocabulary's initial status (spec §5.2: is_initial =
 * creation-only). One transaction: resolve the variant, insert the device at
 * the initial status, and write the "Created → initial" history row so the
 * profile's Status-history tab reads correctly from the first moment.
 */
export async function createDevice(
  actor: Actor, input: CreateDeviceInput,
): Promise<{ deviceId: string; status: string }> {
  authorize(actor, 'create_records', 'manufacturing')
  const data = createSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    const { rows: vRows } = await tx.query<{ id: string }>(
      `SELECT id FROM device_variant WHERE code = $1 AND active`, [data.variantCode])
    if (vRows.length === 0) throw new Error(`Unknown or inactive variant: ${data.variantCode}`)

    const { rows: sRows } = await tx.query<{ code: string }>(
      `SELECT code FROM status_option WHERE is_initial AND active ORDER BY sort_order LIMIT 1`)
    if (sRows.length === 0) throw new Error('No initial device status is configured')
    const initialStatus = sRows[0].code

    let deviceId: string
    try {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO device
           (device_sn, variant_id, status, phase, product_name, model_no, customer,
            destination, remarks, build_date, ship_date, delivered_date, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$13)
         RETURNING id`,
        [data.deviceSn ?? null, vRows[0].id, initialStatus, data.phase ?? null,
         data.productName ?? null, data.modelNo ?? null, data.customer ?? null,
         data.destination ?? null, data.remarks ?? null, data.buildDate ?? null,
         data.shipDate ?? null, data.deliveredDate ?? null, actor.id])
      deviceId = rows[0].id
    } catch (err) {
      rethrowDbError(err, data.deviceSn)
    }

    await tx.query(
      `INSERT INTO device_status_history (device_id, from_status, to_status, changed_by)
       VALUES ($1, NULL, $2, $3)`, [deviceId!, initialStatus, actor.id])

    return { deviceId: deviceId!, status: initialStatus }
  })
}

const updateSchema = z.object({
  deviceId: z.string().uuid(),
  version: z.number().int().nonnegative(),
  deviceSn: z.string().max(DEVICE_FIELD_LIMITS.deviceSn).nullish(),
  variantCode: z.string().min(1).optional(),
  phase: z.string().max(DEVICE_FIELD_LIMITS.phase).nullish(),
  productName: z.string().max(DEVICE_FIELD_LIMITS.productName).nullish(),
  modelNo: z.string().max(DEVICE_FIELD_LIMITS.modelNo).nullish(),
  customer: z.string().max(DEVICE_FIELD_LIMITS.customer).nullish(),
  destination: z.string().max(DEVICE_FIELD_LIMITS.destination).nullish(),
  remarks: z.string().max(DEVICE_FIELD_LIMITS.remarks).nullish(),
  buildDate: DATE.nullish(),
  shipDate: DATE.nullish(),
  deliveredDate: DATE.nullish(),
})
export type UpdateDeviceInput = z.input<typeof updateSchema>

// The editable columns, mapping camelCase input keys → device columns. status is
// deliberately absent: it is changed ONLY through changeDeviceStatus so the
// transition graph and history log can never be bypassed (Global Constraints).
const UPDATE_COLUMNS: Record<string, string> = {
  deviceSn: 'device_sn', phase: 'phase', productName: 'product_name', modelNo: 'model_no',
  customer: 'customer', destination: 'destination', remarks: 'remarks',
  buildDate: 'build_date', shipDate: 'ship_date', deliveredDate: 'delivered_date',
}

/**
 * Edit a device's non-status fields under optimistic concurrency. Only the keys
 * actually present in the input are written (a partial update), so omitting a
 * field leaves it untouched while explicitly passing null clears it. Status is
 * not editable here by construction.
 */
export async function updateDevice(
  actor: Actor, input: UpdateDeviceInput,
): Promise<{ version: number }> {
  authorize(actor, 'edit_records', 'manufacturing')
  const data = updateSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    const { rows: devRows } = await tx.query<{ version: number }>(
      `SELECT version FROM device WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [data.deviceId])
    if (devRows.length === 0) throw new DeviceNotFoundError(data.deviceId)
    if (devRows[0].version !== data.version) throw new OptimisticLockError('device', data.deviceId)

    const sets: string[] = []
    const params: unknown[] = []
    const p = (v: unknown) => { params.push(v); return `$${params.length}` }

    if (data.variantCode !== undefined) {
      const { rows } = await tx.query<{ id: string }>(
        `SELECT id FROM device_variant WHERE code = $1 AND active`, [data.variantCode])
      if (rows.length === 0) throw new Error(`Unknown or inactive variant: ${data.variantCode}`)
      sets.push(`variant_id = ${p(rows[0].id)}`)
    }
    for (const [key, col] of Object.entries(UPDATE_COLUMNS)) {
      if (key in data && (data as Record<string, unknown>)[key] !== undefined) {
        sets.push(`${col} = ${p((data as Record<string, unknown>)[key])}`)
      }
    }

    const setSql = [...sets, `updated_at = now()`, `updated_by = ${p(actor.id)}`,
                    `version = version + 1`].join(', ')
    try {
      const { rows } = await tx.query<{ version: number }>(
        `UPDATE device SET ${setSql} WHERE id = ${p(data.deviceId)} AND version = ${p(data.version)}
          RETURNING version`, params)
      if (rows.length === 0) throw new OptimisticLockError('device', data.deviceId)
      return { version: rows[0].version }
    } catch (err) {
      rethrowDbError(err, data.deviceSn)
    }
  })
}

export type AllowedTransition = {
  toStatus: string; toLabel: string; requiresReason: boolean; isTerminal: boolean
}

/**
 * The edges out of `fromStatus`, for the status-change UI. Ordered by the
 * target's sort_order so the dropdown reads in lifecycle order. Returns [] for
 * a terminal or unknown status (the graph simply has no rows). Read-only.
 */
export async function listAllowedTransitions(
  actor: Actor, fromStatus: string,
): Promise<AllowedTransition[]> {
  authorize(actor, 'view_records', 'manufacturing')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      to_status: string; to_label: string; requires_reason: boolean; is_terminal: boolean
    }>(
      `SELECT st.to_status, so.label_en AS to_label, st.requires_reason, so.is_terminal
         FROM status_transition st
         JOIN status_option so ON so.code = st.to_status
        WHERE st.from_status = $1 AND so.active
        ORDER BY so.sort_order`, [fromStatus])
    return rows.map((r) => ({
      toStatus: r.to_status, toLabel: r.to_label,
      requiresReason: r.requires_reason, isTerminal: r.is_terminal,
    }))
  })
}
