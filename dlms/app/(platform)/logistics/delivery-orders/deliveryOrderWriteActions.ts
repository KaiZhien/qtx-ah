'use server'

import { revalidatePath } from 'next/cache'
import { requireAal2Actor, MfaRequiredError } from '@/modules/shared/auth/session'
import {
  createDeliveryOrder, updateDeliveryOrder, changeDoStatus,
  DeliveryOrderNotFoundError, DuplicateDoNumberError,
  type CreateDeliveryOrderInput, type UpdateDeliveryOrderInput, type ChangeDoStatusInput,
} from '@/modules/logistics/services/deliveryOrderService'
import { InvalidDoStatusChangeError } from '@/modules/logistics/domain/doStatus'
import { OptimisticLockError } from '@/lib/db/tx'
import { PermissionError } from '@/modules/shared/authz/authorize'

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string }

/**
 * Single sanitization contract for every DO write action (mirrors
 * manufacturing/devices/deviceWriteActions.ts's toMessage). Known, safe
 * errors surface their own message; anything else is logged server-side and
 * replaced with a generic line so a raw Postgres/internal error can never
 * reach the browser.
 */
function toMessage(err: unknown): string {
  if (err instanceof MfaRequiredError) {
    return 'Two-factor authentication required — reload the page to finish signing in.'
  }
  if (err instanceof DuplicateDoNumberError) return err.message
  if (err instanceof InvalidDoStatusChangeError) return err.message
  if (err instanceof DeliveryOrderNotFoundError) {
    return 'That delivery order no longer exists. Reload and try again.'
  }
  if (err instanceof OptimisticLockError) {
    return 'Someone else changed this delivery order. Reload and try again.'
  }
  if (err instanceof PermissionError) return "You don't have permission to do that."
  console.error(JSON.stringify({ level: 'error', msg: 'delivery order write action failed', err: String(err) }))
  return 'Something went wrong. Try again, and tell Reet if it keeps happening.'
}

export async function createDeliveryOrderAction(
  input: CreateDeliveryOrderInput,
): Promise<ActionResult<{ id: string }>> {
  try {
    const actor = await requireAal2Actor()
    const { id } = await createDeliveryOrder(actor, input)
    revalidatePath('/logistics/delivery-orders')
    revalidatePath('/logistics')
    return { ok: true, data: { id } }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function updateDeliveryOrderAction(
  input: UpdateDeliveryOrderInput,
): Promise<ActionResult<{ version: number }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await updateDeliveryOrder(actor, input)
    revalidatePath(`/logistics/delivery-orders/${input.deliveryOrderId}`)
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function changeDoStatusAction(
  input: ChangeDoStatusInput,
): Promise<ActionResult<{ status: string; version: number }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await changeDoStatus(actor, input)
    revalidatePath(`/logistics/delivery-orders/${input.deliveryOrderId}`)
    revalidatePath('/logistics')
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}
