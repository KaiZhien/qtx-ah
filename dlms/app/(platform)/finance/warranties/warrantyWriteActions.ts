'use server'

import { revalidatePath } from 'next/cache'
import {
  requireAal2Actor, MfaRequiredError, UnauthenticatedError, SESSION_EXPIRED_MESSAGE,
} from '@/modules/shared/auth/session'
import {
  createWarranty, updateWarranty, renewWarranty, removeWarranty,
  WarrantyNotFoundError, DuplicateWarrantyError,
  type CreateWarrantyInput, type UpdateWarrantyInput,
  type RenewWarrantyInput, type RemoveWarrantyInput,
} from '@/modules/finance/services/warrantyService'
import { InvalidWarrantyPeriodError } from '@/modules/finance/domain/warrantyStatus'
import { DeviceNotFoundError } from '@/modules/manufacturing/services/deviceWriteService'
import { OptimisticLockError } from '@/lib/db/tx'
import { PermissionError } from '@/modules/shared/authz/authorize'

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string }

/**
 * Single sanitization contract for every warranty write action (mirrors
 * invoiceWriteActions.toMessage). Known, safe errors surface their own message;
 * anything else is logged server-side and replaced with a generic line so a raw
 * Postgres error can never reach the browser.
 */
function toMessage(err: unknown): string {
  if (err instanceof MfaRequiredError) {
    return 'Two-factor authentication required — reload the page to finish signing in.'
  }
  if (err instanceof UnauthenticatedError) return SESSION_EXPIRED_MESSAGE
  // Written FOR the user — it names exactly which date is wrong.
  if (err instanceof InvalidWarrantyPeriodError) return err.message
  // Also written for the user, and it names the fix (renew, don't add).
  if (err instanceof DuplicateWarrantyError) return err.message
  if (err instanceof DeviceNotFoundError) return 'That device no longer exists. Reload and try again.'
  if (err instanceof WarrantyNotFoundError) return 'That warranty no longer exists. Reload and try again.'
  if (err instanceof OptimisticLockError) return 'Someone else changed this warranty. Reload and try again.'
  if (err instanceof PermissionError) return "You don't have permission to do that."
  console.error(JSON.stringify({ level: 'error', msg: 'warranty write action failed', err: String(err) }))
  return 'Something went wrong. Try again, and tell Reet if it keeps happening.'
}

/**
 * The device profile is where a warranty is normally read, so every action
 * revalidates it as well as the Finance surfaces. deviceId is passed in by the
 * caller rather than re-read here: these actions must not open a connection just
 * to learn a path.
 */
function revalidateWarrantySurfaces(deviceId?: string): void {
  revalidatePath('/finance')
  revalidatePath('/finance/warranties')
  if (deviceId) revalidatePath(`/manufacturing/devices/${deviceId}`)
}

export async function createWarrantyAction(
  input: CreateWarrantyInput,
): Promise<ActionResult<{ warrantyId: string }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await createWarranty(actor, input)
    revalidateWarrantySurfaces(input.deviceId)
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function updateWarrantyAction(
  input: UpdateWarrantyInput & { deviceId?: string },
): Promise<ActionResult<{ version: number }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await updateWarranty(actor, input)
    revalidateWarrantySurfaces(input.deviceId)
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

/**
 * Renew/extend: supersedes the current warranty and creates its successor. NOT
 * the same as editing the dates — see renewWarranty's header for why the history
 * is worth a second row.
 */
export async function renewWarrantyAction(
  input: RenewWarrantyInput & { deviceId?: string },
): Promise<ActionResult<{ warrantyId: string }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await renewWarranty(actor, input)
    revalidateWarrantySurfaces(input.deviceId)
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function removeWarrantyAction(
  input: RemoveWarrantyInput & { deviceId?: string },
): Promise<ActionResult<null>> {
  try {
    const actor = await requireAal2Actor()
    await removeWarranty(actor, input)
    revalidateWarrantySurfaces(input.deviceId)
    return { ok: true, data: null }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}
