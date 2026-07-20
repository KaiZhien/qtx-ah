import { z } from 'zod'
import { withTransaction, OptimisticLockError, type Tx } from '@/lib/db/tx'
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
      [data.deviceId, current.status, data.toStatus, data.reason ?? null, actor.id])

    return { status: data.toStatus, version: updated[0].version }
  })
}
