'use server'

import { revalidatePath } from 'next/cache'
import { requireAal2Actor, MfaRequiredError } from '@/modules/shared/auth/session'
import {
  createModification, updateModification, changeModificationStatus, signOffModification,
  ModificationNotFoundError, ModificationReferenceNotFoundError,
  type CreateModificationInput, type UpdateModificationInput,
  type ChangeModificationStatusInput, type SignOffModificationInput,
} from '@/modules/maintenance/services/modificationService'
import {
  InvalidModificationTransitionError, ModificationSignOffError,
} from '@/modules/maintenance/domain/modificationStatus'
import { InvalidAttributionError } from '@/modules/maintenance/services/attributionService'
import { OptimisticLockError } from '@/lib/db/tx'
import { PermissionError } from '@/modules/shared/authz/authorize'

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string }

/**
 * Single sanitization contract for every modification write action (the sibling
 * of repairs/actions.ts's toMessage). Known, safe errors surface their own
 * message; anything else is logged server-side and replaced with a generic line
 * so a raw Postgres/internal error can never reach the browser.
 */
function toMessage(err: unknown): string {
  if (err instanceof MfaRequiredError) {
    return 'Two-factor authentication required — reload the page to finish signing in.'
  }
  if (err instanceof InvalidModificationTransitionError) return err.message
  if (err instanceof ModificationSignOffError) return err.message
  // The same-device rule on a linked repair (assertSameDevice). Its own message
  // already names the mismatch in human terms — "that repair is for a different
  // device" — so it passes through rather than becoming "Something went wrong"
  // about a rule the system knows how to explain.
  if (err instanceof InvalidAttributionError) return err.message
  if (err instanceof ModificationReferenceNotFoundError) {
    // Names WHICH reference went missing — the service carries four, and
    // "something you linked no longer exists" is not actionable.
    return `That ${err.reference.replace('_', ' ')} no longer exists. Reload and try again.`
  }
  if (err instanceof ModificationNotFoundError) {
    return 'That modification no longer exists. Reload and try again.'
  }
  if (err instanceof OptimisticLockError) {
    return 'Someone else changed this modification. Reload and try again.'
  }
  if (err instanceof PermissionError) return "You don't have permission to do that."
  console.error(JSON.stringify({
    level: 'error', msg: 'modification write action failed', err: String(err),
  }))
  return 'Something went wrong. Try again, and tell Reet if it keeps happening.'
}

export async function createModificationAction(
  input: CreateModificationInput,
): Promise<ActionResult<{ modificationId: string; modificationNo: string }>> {
  try {
    // Inside the try — an escaping MfaRequiredError was a real review finding.
    const actor = await requireAal2Actor()
    const res = await createModification(actor, input)
    revalidatePath('/maintenance')
    revalidatePath('/maintenance/modifications')
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function updateModificationAction(
  input: UpdateModificationInput,
): Promise<ActionResult<{ version: number }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await updateModification(actor, input)
    revalidatePath(`/maintenance/modifications/${input.modificationId}`)
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function changeModificationStatusAction(
  input: ChangeModificationStatusInput,
): Promise<ActionResult<{ status: string; version: number }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await changeModificationStatus(actor, input)
    revalidatePath('/maintenance')
    revalidatePath('/maintenance/modifications')
    revalidatePath(`/maintenance/modifications/${input.modificationId}`)
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function signOffModificationAction(
  input: SignOffModificationInput,
): Promise<ActionResult<{ status: string }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await signOffModification(actor, input)
    revalidatePath('/maintenance')
    revalidatePath('/maintenance/modifications')
    revalidatePath(`/maintenance/modifications/${input.modificationId}`)
    return { ok: true, data: { status: res.status } }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}
