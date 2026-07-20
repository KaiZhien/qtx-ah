'use server'

import { revalidatePath } from 'next/cache'
import { requireAal2Actor, MfaRequiredError } from '@/modules/shared/auth/session'
import {
  createDevice, updateDevice, changeDeviceStatus,
  DeviceNotFoundError, DuplicateSerialError,
  type CreateDeviceInput, type UpdateDeviceInput, type ChangeStatusInput,
} from '@/modules/manufacturing/services/deviceWriteService'
import { InvalidStatusChangeError } from '@/modules/manufacturing/domain/deviceStatus'
import { OptimisticLockError } from '@/lib/db/tx'
import { PermissionError } from '@/modules/shared/authz/authorize'

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string }

/**
 * Single sanitization contract for every device write action (mirrors
 * componentActions.toMessage). Known, safe errors surface their own message;
 * anything else is logged server-side and replaced with a generic line so a
 * raw Postgres/internal error can never reach the browser.
 */
function toMessage(err: unknown): string {
  if (err instanceof MfaRequiredError) {
    return 'Two-factor authentication required — reload the page to finish signing in.'
  }
  if (err instanceof DuplicateSerialError) return err.message
  if (err instanceof InvalidStatusChangeError) return err.message
  if (err instanceof DeviceNotFoundError) return 'That device no longer exists. Reload and try again.'
  if (err instanceof OptimisticLockError) return 'Someone else changed this device. Reload and try again.'
  if (err instanceof PermissionError) return "You don't have permission to do that."
  console.error(JSON.stringify({ level: 'error', msg: 'device write action failed', err: String(err) }))
  return 'Something went wrong. Try again, and tell Reet if it keeps happening.'
}

export async function createDeviceAction(
  input: CreateDeviceInput,
): Promise<ActionResult<{ deviceId: string }>> {
  try {
    const actor = await requireAal2Actor()
    const { deviceId } = await createDevice(actor, input)
    revalidatePath('/manufacturing/devices')
    return { ok: true, data: { deviceId } }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function updateDeviceAction(
  input: UpdateDeviceInput,
): Promise<ActionResult<{ version: number }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await updateDevice(actor, input)
    revalidatePath(`/manufacturing/devices/${input.deviceId}`)
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function changeDeviceStatusAction(
  input: ChangeStatusInput,
): Promise<ActionResult<{ status: string; version: number }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await changeDeviceStatus(actor, input)
    revalidatePath(`/manufacturing/devices/${input.deviceId}`)
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}
