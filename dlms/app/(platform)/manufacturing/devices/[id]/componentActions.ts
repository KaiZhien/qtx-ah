'use server'

import { revalidatePath } from 'next/cache'
import { requireActor } from '@/modules/shared/auth/session'
import {
  replaceComponentInstallation, installComponent, type ReplaceInput,
} from '@/modules/manufacturing/services/componentService'
import { InvalidReplacementError } from '@/modules/manufacturing/domain/componentInstallation'
import { OptimisticLockError, withTransaction } from '@/lib/db/tx'
import { authorize, PermissionError } from '@/modules/shared/authz/authorize'

export type ActionResult = { ok: true } | { ok: false; error: string }

/**
 * Maps internal errors to user-facing text — a raw exception (Postgres
 * constraint violation, service internals) must never reach the browser.
 * Anything outside the three known cases is logged server-side only and
 * replaced with a generic message.
 */
function toMessage(err: unknown): string {
  if (err instanceof InvalidReplacementError) return err.message
  if (err instanceof OptimisticLockError) return 'Someone else changed this device. Reload and try again.'
  if (err instanceof PermissionError) return "You don't have permission to do that."
  console.error(JSON.stringify({ level: 'error', msg: 'component action failed', err: String(err) }))
  return 'Something went wrong. Try again, and tell Reet if it keeps happening.'
}

export async function replaceComponentAction(
  deviceId: string, input: ReplaceInput,
): Promise<ActionResult> {
  try {
    const actor = await requireActor()
    await replaceComponentInstallation(actor, input)
    revalidatePath(`/manufacturing/devices/${deviceId}`)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function installComponentAction(
  deviceId: string,
  input: { componentTypeId: string; slotNo?: number; unitId?: string; batchNo?: string; notes?: string },
): Promise<ActionResult> {
  try {
    const actor = await requireActor()
    await installComponent(actor, { deviceId, ...input })
    revalidatePath(`/manufacturing/devices/${deviceId}`)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export type AvailableUnit = { id: string; serialNo: string }

/**
 * Backs the serialized-type unit picker in the Replace/Add dialogs. Not part
 * of Task 4's service surface (componentService) — a plain, read-only,
 * authorize()-gated query scoped to this route, matching the direct-query
 * style getDeviceComponents already uses rather than adding a new service
 * export. There is no unit-creation flow in this task's scope, so this only
 * offers units already sitting in stock.
 */
export async function listAvailableUnitsAction(componentTypeId: string): Promise<AvailableUnit[]> {
  const actor = await requireActor()
  authorize(actor, 'view_records', 'manufacturing')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ id: string; serial_no: string }>(
      `SELECT id, serial_no FROM component_unit
        WHERE component_type_id = $1 AND disposition = 'in_stock' AND deleted_at IS NULL
        ORDER BY serial_no`,
      [componentTypeId],
    )
    return rows.map((r) => ({ id: r.id, serialNo: r.serial_no }))
  })
}
