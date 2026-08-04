'use server'

import { revalidatePath } from 'next/cache'
import {
  requireAal2Actor, MfaRequiredError, UnauthenticatedError, SESSION_EXPIRED_MESSAGE,
} from '@/modules/shared/auth/session'
import {
  createBuyer, updateBuyer, BuyerNotFoundError,
  type CreateBuyerInput, type UpdateBuyerInput,
} from '@/modules/finance/services/buyerService'
import { OptimisticLockError } from '@/lib/db/tx'
import { PermissionError } from '@/modules/shared/authz/authorize'

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string }

/**
 * Single sanitization contract for every buyer write action (mirrors
 * manufacturing/devices/deviceWriteActions.toMessage). Known, safe errors
 * surface their own message; anything else is logged server-side and replaced
 * with a generic line so a raw Postgres/internal error can never reach the browser.
 */
function toMessage(err: unknown): string {
  if (err instanceof MfaRequiredError) {
    return 'Two-factor authentication required — reload the page to finish signing in.'
  }
  if (err instanceof UnauthenticatedError) return SESSION_EXPIRED_MESSAGE
  if (err instanceof BuyerNotFoundError) return 'That buyer no longer exists. Reload and try again.'
  if (err instanceof OptimisticLockError) return 'Someone else changed this buyer. Reload and try again.'
  if (err instanceof PermissionError) return "You don't have permission to do that."
  console.error(JSON.stringify({ level: 'error', msg: 'buyer write action failed', err: String(err) }))
  return 'Something went wrong. Try again, and tell Reet if it keeps happening.'
}

export async function createBuyerAction(
  input: CreateBuyerInput,
): Promise<ActionResult<{ buyerId: string }>> {
  try {
    const actor = await requireAal2Actor()
    const { buyerId } = await createBuyer(actor, input)
    revalidatePath('/finance/buyers')
    return { ok: true, data: { buyerId } }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function updateBuyerAction(
  input: UpdateBuyerInput,
): Promise<ActionResult<{ version: number }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await updateBuyer(actor, input)
    revalidatePath(`/finance/buyers/${input.buyerId}`)
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}
