'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireAal2Actor, MfaRequiredError } from '@/modules/shared/auth/session'
import { PermissionError } from '@/modules/shared/authz/authorize'
import { OptimisticLockError } from '@/lib/db/tx'
import { InvalidFailureTransitionError } from '@/modules/engineering/domain/failureStatus'
import {
  createFailure, updateFailure, changeFailureStatus, escalateFailureToEco,
  FailureNotFoundError, FailureSubjectNotFoundError, FailureEscalationError,
  type CreateFailureInput, type UpdateFailureInput,
  type ChangeFailureStatusInput, type EscalateFailureInput,
} from '@/modules/engineering/services/failureService'

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string }

/**
 * Sanitization contract (see deviceWriteActions.toMessage): every known error
 * type becomes a fixed, user-safe string; anything else is logged server-side
 * and replaced with a generic message, so a DB error never reaches the browser.
 * The domain errors already carry operator-readable messages built from labels,
 * so those pass through verbatim.
 */
function toMessage(err: unknown): string {
  if (err instanceof MfaRequiredError) {
    return 'Two-factor authentication required — reload the page to finish signing in.'
  }
  // A ZodError is the form disagreeing with the schema (an over-long title, a
  // malformed date), which the user can act on. Four other action files map it;
  // leaving it here to fall through would log a "failed" line for a typo and
  // tell the user "something went wrong".
  if (err instanceof z.ZodError) {
    return err.errors[0]?.message ?? 'That change could not be read. Check the form and try again.'
  }
  if (err instanceof InvalidFailureTransitionError) return err.message
  if (err instanceof FailureEscalationError) return err.message
  if (err instanceof FailureSubjectNotFoundError) return `${err.message}. Reload and try again.`
  if (err instanceof FailureNotFoundError) {
    return 'That investigation no longer exists. Reload and try again.'
  }
  if (err instanceof OptimisticLockError) {
    return 'Someone else changed this investigation. Reload and try again.'
  }
  if (err instanceof PermissionError) return "You don't have permission to do that."
  console.error(JSON.stringify({
    level: 'error', msg: 'failure investigation action failed', err: String(err),
  }))
  return 'Something went wrong. Try again, and tell Reet if it keeps happening.'
}

export async function createFailureAction(
  input: CreateFailureInput,
): Promise<ActionResult<{ id: string; fiNo: string }>> {
  try {
    // The AAL2 gate lives INSIDE the try: an escaping MfaRequiredError would
    // otherwise surface as an unhandled server-action rejection instead of a
    // message the form can render.
    const actor = await requireAal2Actor()
    const res = await createFailure(actor, input)
    revalidatePath('/engineering/failures')
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function updateFailureAction(
  input: UpdateFailureInput,
): Promise<ActionResult<{ version: number }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await updateFailure(actor, input)
    revalidatePath(`/engineering/failures/${input.id}`)
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function changeFailureStatusAction(
  input: ChangeFailureStatusInput,
): Promise<ActionResult<{ status: string; version: number }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await changeFailureStatus(actor, input)
    revalidatePath(`/engineering/failures/${input.id}`)
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function escalateFailureAction(
  input: EscalateFailureInput,
): Promise<ActionResult<{ ecoId: string; ecoNo: string | null; version: number }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await escalateFailureToEco(actor, input)
    revalidatePath(`/engineering/failures/${input.id}`)
    revalidatePath('/engineering/eco')
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}
