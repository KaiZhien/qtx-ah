'use server'

import { revalidatePath } from 'next/cache'
import { requireAal2Actor, MfaRequiredError } from '@/modules/shared/auth/session'
import {
  createRepair, updateRepair, changeRepairStatus, signOffRepair,
  RepairNotFoundError, RepairDeviceNotFoundError,
  type CreateRepairInput, type UpdateRepairInput,
  type ChangeRepairStatusInput, type SignOffRepairInput,
} from '@/modules/maintenance/services/repairService'
import {
  InvalidRepairTransitionError, RepairSignOffError,
} from '@/modules/maintenance/domain/repairStatus'
import { InvalidStatusChangeError } from '@/modules/manufacturing/domain/deviceStatus'
import { OptimisticLockError } from '@/lib/db/tx'
import { PermissionError } from '@/modules/shared/authz/authorize'

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string }

/**
 * Single sanitization contract for every repair write action (mirrors
 * deviceWriteActions.toMessage). Known, safe errors surface their own message;
 * anything else is logged server-side and replaced with a generic line so a raw
 * Postgres/internal error can never reach the browser.
 */
function toMessage(err: unknown): string {
  if (err instanceof MfaRequiredError) {
    return 'Two-factor authentication required — reload the page to finish signing in.'
  }
  if (err instanceof InvalidRepairTransitionError) return err.message
  if (err instanceof RepairSignOffError) return err.message
  // A repair write can now fail on the DEVICE half: since the device move shares
  // the repair's transaction, a move the status graph refuses aborts the whole
  // write instead of being swallowed into `deviceMoved: false`. The message is
  // already the human one Manufacturing composes ("A device cannot move from
  // X to Y"), so it passes through — without this line the user would be told
  // "Something went wrong" about a rule the system knows how to explain.
  if (err instanceof InvalidStatusChangeError) return err.message
  if (err instanceof RepairDeviceNotFoundError) {
    return 'That device no longer exists. Reload and try again.'
  }
  if (err instanceof RepairNotFoundError) {
    return 'That repair no longer exists. Reload and try again.'
  }
  if (err instanceof OptimisticLockError) {
    return 'Someone else changed this repair. Reload and try again.'
  }
  if (err instanceof PermissionError) return "You don't have permission to do that."
  console.error(JSON.stringify({ level: 'error', msg: 'repair write action failed', err: String(err) }))
  return 'Something went wrong. Try again, and tell Reet if it keeps happening.'
}

export async function createRepairAction(
  input: CreateRepairInput,
): Promise<ActionResult<{ repairId: string; deviceMoved: boolean }>> {
  try {
    const actor = await requireAal2Actor()
    const { repairId, deviceMoved } = await createRepair(actor, input)
    revalidatePath('/maintenance')
    revalidatePath('/maintenance/repairs')
    return { ok: true, data: { repairId, deviceMoved } }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function updateRepairAction(
  input: UpdateRepairInput,
): Promise<ActionResult<{ version: number }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await updateRepair(actor, input)
    revalidatePath(`/maintenance/repairs/${input.repairId}`)
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function changeRepairStatusAction(
  input: ChangeRepairStatusInput,
): Promise<ActionResult<{ status: string; version: number }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await changeRepairStatus(actor, input)
    revalidatePath('/maintenance')
    revalidatePath(`/maintenance/repairs/${input.repairId}`)
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function signOffRepairAction(
  input: SignOffRepairInput,
): Promise<ActionResult<{ deviceReturned: boolean }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await signOffRepair(actor, input)
    revalidatePath('/maintenance')
    revalidatePath(`/maintenance/repairs/${input.repairId}`)
    return { ok: true, data: { deviceReturned: res.deviceReturned } }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}
