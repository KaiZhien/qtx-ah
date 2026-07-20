'use server'

import { revalidatePath } from 'next/cache'
import { requireAal2Actor, MfaRequiredError } from '@/modules/shared/auth/session'
import { PermissionError } from '@/modules/shared/authz/authorize'
import { OptimisticLockError } from '@/lib/db/tx'
import { InvalidTransitionError } from '@/modules/engineering/domain/transition'
import {
  createFirmwareRelease, updateFirmwareRelease, changeFirmwareStatus,
  RecordNotFoundError, DuplicateFirmwareError,
  type CreateFirmwareInput, type UpdateFirmwareInput, type ChangeFirmwareStatusInput,
} from '@/modules/engineering/services/engineeringWriteService'

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string }

/** Sanitization contract for firmware actions — see deviceWriteActions.toMessage. */
function toMessage(err: unknown): string {
  if (err instanceof MfaRequiredError) {
    return 'Two-factor authentication required — reload the page to finish signing in.'
  }
  if (err instanceof DuplicateFirmwareError) return err.message
  if (err instanceof InvalidTransitionError) return err.message
  if (err instanceof RecordNotFoundError) return 'That firmware release no longer exists. Reload and try again.'
  if (err instanceof OptimisticLockError) return 'Someone else changed this release. Reload and try again.'
  if (err instanceof PermissionError) return "You don't have permission to do that."
  console.error(JSON.stringify({ level: 'error', msg: 'firmware action failed', err: String(err) }))
  return 'Something went wrong. Try again, and tell Reet if it keeps happening.'
}

export async function createFirmwareAction(
  input: CreateFirmwareInput,
): Promise<ActionResult<{ id: string }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await createFirmwareRelease(actor, input)
    revalidatePath('/engineering/firmware')
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function updateFirmwareAction(
  input: UpdateFirmwareInput,
): Promise<ActionResult<{ version: number }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await updateFirmwareRelease(actor, input)
    revalidatePath(`/engineering/firmware/${input.id}`)
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function changeFirmwareStatusAction(
  input: ChangeFirmwareStatusInput,
): Promise<ActionResult<{ status: string; version: number }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await changeFirmwareStatus(actor, input)
    revalidatePath(`/engineering/firmware/${input.id}`)
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}
