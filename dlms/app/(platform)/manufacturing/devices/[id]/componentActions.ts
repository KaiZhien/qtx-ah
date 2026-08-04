'use server'

import { revalidatePath } from 'next/cache'
import {
  requireAal2Actor, MfaRequiredError, UnauthenticatedError, SESSION_EXPIRED_MESSAGE,
} from '@/modules/shared/auth/session'
import {
  replaceComponentInstallation, installComponent, type ReplaceInput,
} from '@/modules/manufacturing/services/componentService'
import { InvalidReplacementError } from '@/modules/manufacturing/domain/componentInstallation'
import { InvalidAttributionError } from '@/modules/maintenance/services/attributionService'
import { OptimisticLockError, withTransaction } from '@/lib/db/tx'
import { authorize, PermissionError } from '@/modules/shared/authz/authorize'

export type ActionResult = { ok: true } | { ok: false; error: string }

/**
 * Maps internal errors to user-facing text — a raw exception (Postgres
 * constraint violation, service internals) must never reach the browser.
 * Anything outside the known cases is logged server-side only and replaced
 * with a generic message.
 */
function toMessage(err: unknown): string {
  if (err instanceof MfaRequiredError) {
    return 'Two-factor authentication required — reload the page to finish signing in.'
  }
  if (err instanceof UnauthenticatedError) return SESSION_EXPIRED_MESSAGE
  if (err instanceof InvalidReplacementError) return err.message
  // The §5.4 attribution rule: its message already names the problem precisely
  // ("that repair is for a different device"), so it surfaces as written.
  if (err instanceof InvalidAttributionError) return err.message
  if (err instanceof OptimisticLockError) return 'Someone else changed this device. Reload and try again.'
  if (err instanceof PermissionError) return "You don't have permission to do that."
  console.error(JSON.stringify({ level: 'error', msg: 'component action failed', err: String(err) }))
  return 'Something went wrong. Try again, and tell Reet if it keeps happening.'
}

/**
 * The one replacement action, whether it is invoked from the device profile or
 * from inside a repair (spec §5.4: "the engineer performs one action; the
 * system fans out. No double entry."). Attribution rides along in `input`, so
 * there is no second action and no second dialog to keep in step.
 *
 * The attributed record's page shows the same component set, so it is
 * revalidated too — DERIVED from the validated input, never a path the client
 * hands us.
 */
export async function replaceComponentAction(
  deviceId: string, input: ReplaceInput,
): Promise<ActionResult> {
  try {
    const actor = await requireAal2Actor()
    await replaceComponentInstallation(actor, input)
    revalidatePath(`/manufacturing/devices/${deviceId}`)
    if (input.repairId) revalidatePath(`/maintenance/repairs/${input.repairId}`)
    if (input.modificationId) revalidatePath(`/maintenance/modifications/${input.modificationId}`)
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
    const actor = await requireAal2Actor()
    await installComponent(actor, { deviceId, ...input })
    revalidatePath(`/manufacturing/devices/${deviceId}`)
    return { ok: true }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export type AvailableUnit = { id: string; serialNo: string }

export type ListUnitsResult =
  | { ok: true; units: AvailableUnit[] }
  | { ok: false; error: string }

/**
 * Backs the serialized-type unit picker in the Replace/Add dialogs. Not part
 * of Task 4's service surface (componentService) — a plain, read-only,
 * authorize()-gated query scoped to this route, matching the direct-query
 * style getDeviceComponents already uses rather than adding a new service
 * export. There is no unit-creation flow in this task's scope, so this only
 * offers units already sitting in stock.
 *
 * Same error contract as the write actions above: any thrown error (bad
 * componentTypeId, transient DB failure) is caught and mapped through
 * toMessage rather than allowed to propagate — a raw Postgres error must
 * never reach the browser here either.
 */
export async function listAvailableUnitsAction(componentTypeId: string): Promise<ListUnitsResult> {
  try {
    const actor = await requireAal2Actor()
    authorize(actor, 'view_records', 'manufacturing')
    const units = await withTransaction(actor.id, async (tx) => {
      const { rows } = await tx.query<{ id: string; serial_no: string }>(
        `SELECT id, serial_no FROM component_unit
          WHERE component_type_id = $1 AND disposition = 'in_stock' AND deleted_at IS NULL
          ORDER BY serial_no`,
        [componentTypeId],
      )
      return rows.map((r) => ({ id: r.id, serialNo: r.serial_no }))
    })
    return { ok: true, units }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}
