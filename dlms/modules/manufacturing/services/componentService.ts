import { z } from 'zod'
import { withTransaction, type Tx } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'
import { assertReplacementShape } from '@/modules/manufacturing/domain/componentInstallation'
import { assertSameDevice } from '@/modules/maintenance/services/attributionService'

export type CurrentComponent = {
  installationId: string; componentTypeCode: string; componentTypeName: string
  slotNo: number; unit: { id: string; serialNo: string } | null; batchNo: string | null
  installedAt: Date; installedByName: string
}
export type InstallationHistoryItem = CurrentComponent & {
  removedAt: Date | null; removedByName: string | null; removalReason: string | null
}

const SELECT_COLS = `
  ci.id, ct.code AS type_code, ct.name AS type_name, ci.slot_no,
  ci.component_unit_id, cu.serial_no, ci.batch_no,
  ci.installed_at, iu.full_name AS installed_by_name,
  ci.removed_at, ru.full_name AS removed_by_name, ci.removal_reason`

const FROM_JOINS = `
  FROM component_installation ci
  JOIN component_type ct ON ct.id = ci.component_type_id
  LEFT JOIN component_unit cu ON cu.id = ci.component_unit_id
  JOIN app_user iu ON iu.id = ci.installed_by
  LEFT JOIN app_user ru ON ru.id = ci.removed_by`

type Raw = {
  id: string; type_code: string; type_name: string; slot_no: number
  component_unit_id: string | null; serial_no: string | null; batch_no: string | null
  installed_at: Date; installed_by_name: string
  removed_at: Date | null; removed_by_name: string | null; removal_reason: string | null
}
const toItem = (r: Raw): InstallationHistoryItem => ({
  installationId: r.id, componentTypeCode: r.type_code, componentTypeName: r.type_name,
  slotNo: r.slot_no, unit: r.component_unit_id ? { id: r.component_unit_id, serialNo: r.serial_no! } : null,
  batchNo: r.batch_no, installedAt: r.installed_at, installedByName: r.installed_by_name,
  removedAt: r.removed_at, removedByName: r.removed_by_name, removalReason: r.removal_reason,
})

export async function getDeviceComponents(
  actor: Actor, deviceId: string,
): Promise<{ current: CurrentComponent[]; history: InstallationHistoryItem[] }> {
  authorize(actor, 'view_records', 'manufacturing')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<Raw>(
      `SELECT ${SELECT_COLS} ${FROM_JOINS}
        WHERE ci.device_id = $1
        ORDER BY ct.sort, ci.slot_no, ci.installed_at DESC`, [deviceId])
    const all = rows.map(toItem)
    return { current: all.filter((r) => r.removedAt === null), history: all }
  })
}

const installSchema = z.object({
  deviceId: z.string().uuid(),
  componentTypeId: z.string().uuid(),
  slotNo: z.number().int().min(1).default(1),
  unitId: z.string().uuid().optional(),
  batchNo: z.string().max(100).optional(),
  notes: z.string().max(2000).optional(),
})

export async function installComponent(
  actor: Actor, input: z.input<typeof installSchema>,
): Promise<{ installationId: string }> {
  authorize(actor, 'edit_records', 'manufacturing')
  const data = installSchema.parse(input)
  return withTransaction(actor.id, async (tx) => {
    const id = await insertInstallation(tx, actor.id, {
      deviceId: data.deviceId, componentTypeId: data.componentTypeId, slotNo: data.slotNo,
      unitId: data.unitId ?? null, batchNo: data.batchNo ?? null, notes: data.notes ?? null,
    })
    if (data.unitId) await setDisposition(tx, data.unitId, 'installed')
    return { installationId: id }
  })
}

const replaceSchema = z.object({
  removedInstallationId: z.string().uuid(),
  reason: z.string().min(1).max(2000),
  replacementUnitId: z.string().uuid().optional(),
  replacementBatchNo: z.string().max(100).optional(),
  repairId: z.string().uuid().optional(),
  modificationId: z.string().uuid().optional(),
  notes: z.string().max(2000).optional(),
})
export type ReplaceInput = z.input<typeof replaceSchema>

/**
 * The §14 primitive. One transaction: close the open installation, open the new
 * one, flip the removed/installed unit dispositions, bump device.version. Either
 * all of it commits or none — a device can never show a replacement its history
 * lacks. The Repair/Modification workflows call this with a repairId /
 * modificationId, which is VALIDATED here (see assertSameDevice) rather than
 * merely recorded: the attributed record must be live and for this very device.
 */
export async function replaceComponentInstallation(
  actor: Actor, input: ReplaceInput,
): Promise<{ closedId: string; newId: string; current: CurrentComponent[] }> {
  authorize(actor, 'edit_records', 'manufacturing')
  const data = replaceSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    // Lock the open installation + its type's tracking mode.
    const { rows: openRows } = await tx.query<{
      device_id: string; component_type_id: string; component_unit_id: string | null
      slot_no: number; removed_at: Date | null; tracking_mode: 'serialized' | 'batch'
    }>(
      `SELECT ci.device_id, ci.component_type_id, ci.component_unit_id, ci.slot_no, ci.removed_at,
              ct.tracking_mode
         FROM component_installation ci JOIN component_type ct ON ct.id = ci.component_type_id
        WHERE ci.id = $1 FOR UPDATE OF ci`, [data.removedInstallationId])
    if (openRows.length === 0) throw new Error('Installation not found')
    const open = openRows[0]
    if (open.removed_at !== null) throw new Error('That component was already removed')

    // Shape rule (pure) — keeps impossible swaps out of the DB work.
    assertReplacementShape({
      trackingMode: open.tracking_mode,
      removingUnitId: open.component_unit_id,
      replacementUnitId: data.replacementUnitId ?? null,
      replacementBatchNo: data.replacementBatchNo ?? null,
    })

    // Attribution rule (spec §5.4). Runs HERE, after the lock that established
    // open.device_id and before any write, so no caller — action, script or a
    // future service — can record a swap against another device's repair. A
    // throw rolls the whole replacement back.
    if (data.repairId) {
      await assertSameDevice(tx, 'repair', data.repairId, open.device_id)
    }
    if (data.modificationId) {
      await assertSameDevice(tx, 'modification', data.modificationId, open.device_id)
    }

    // 1. Close the old installation (the append-only guard permits this one-time stamp).
    await tx.query(
      `UPDATE component_installation
          SET removed_at = now(), removed_by = $1, removal_reason = $2,
              repair_id = $3, modification_id = $4
        WHERE id = $5`,
      [actor.id, data.reason, data.repairId ?? null, data.modificationId ?? null,
       data.removedInstallationId])

    // 2. Open the new installation in the same slot.
    const newId = await insertInstallation(tx, actor.id, {
      deviceId: open.device_id, componentTypeId: open.component_type_id, slotNo: open.slot_no,
      unitId: data.replacementUnitId ?? null, batchNo: data.replacementBatchNo ?? null,
      notes: data.notes ?? null, repairId: data.repairId ?? null,
      modificationId: data.modificationId ?? null,
    })

    // 3. Flip unit dispositions (serialized only).
    if (open.component_unit_id) await setDisposition(tx, open.component_unit_id, 'removed')
    if (data.replacementUnitId) await setDisposition(tx, data.replacementUnitId, 'installed')

    // 4. Bump device.version — the device's component set changed.
    await tx.query(
      `UPDATE device SET version = version + 1, updated_at = now(), updated_by = $1 WHERE id = $2`,
      [actor.id, open.device_id])

    // Return the fresh current set.
    const { rows } = await tx.query<Raw>(
      `SELECT ${SELECT_COLS} ${FROM_JOINS}
        WHERE ci.device_id = $1 AND ci.removed_at IS NULL
        ORDER BY ct.sort, ci.slot_no`, [open.device_id])
    return { closedId: data.removedInstallationId, newId, current: rows.map(toItem) }
  })
}

/**
 * How many component_installation rows reference `repairId` — the fact behind
 * the §5.4 sign-off precondition ("a parts-replaced claim must be backed").
 *
 * A `Tx`-accepting internal, not a service call: signOffRepair must read this
 * INSIDE the transaction that holds the repair's row lock, or the count could
 * be true when asked and false when the repair closes. It therefore opens no
 * transaction and authorizes nothing — the caller has already done both.
 *
 * component_installation is a Manufacturing table, so the query lives here and
 * Maintenance calls in, rather than reaching across into another module's
 * tables. Note a single §14 replacement stamps TWO rows (the one it closes and
 * the one it opens), which is why the domain rule is "at least one".
 */
export async function countInstallationsForRepair(tx: Tx, repairId: string): Promise<number> {
  const { rows } = await tx.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM component_installation WHERE repair_id = $1`, [repairId])
  return rows[0].n
}

async function insertInstallation(
  tx: Tx, actorId: string,
  a: { deviceId: string; componentTypeId: string; slotNo: number; unitId: string | null
       batchNo: string | null; notes: string | null; repairId?: string | null
       modificationId?: string | null },
): Promise<string> {
  const { rows } = await tx.query<{ id: string }>(
    `INSERT INTO component_installation
       (device_id, component_type_id, component_unit_id, batch_no, slot_no,
        installed_by, repair_id, modification_id, notes, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$6) RETURNING id`,
    [a.deviceId, a.componentTypeId, a.unitId, a.batchNo, a.slotNo, actorId,
     a.repairId ?? null, a.modificationId ?? null, a.notes])
  return rows[0].id
}

async function setDisposition(tx: Tx, unitId: string, disposition: string): Promise<void> {
  await tx.query(
    `UPDATE component_unit SET disposition = $1, updated_at = now(), version = version + 1
      WHERE id = $2`, [disposition, unitId])
}
