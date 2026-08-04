'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import {
  requireAal2Actor, MfaRequiredError, UnauthenticatedError, SESSION_EXPIRED_MESSAGE,
} from '@/modules/shared/auth/session'
import { PermissionError } from '@/modules/shared/authz/authorize'
import { OptimisticLockError } from '@/lib/db/tx'
import { InvalidTransitionError } from '@/modules/engineering/domain/transition'
import { ApprovalGateError } from '@/modules/shared/approvals/domain/approvalGate'
import { EcoScopeLockedError } from '@/modules/shared/approvals/domain/ecoApproval'
import { ApprovalAlreadyPendingError } from '@/modules/shared/approvals/services/approvalService'
import {
  requestEcoApproval, EcoApprovalRequestError, EcoNotFoundError,
  type RequestEcoApprovalInput,
} from '@/modules/engineering/services/ecoService'
import {
  createEco, updateEco, changeEcoStatus, RecordNotFoundError,
  type CreateEcoInput, type UpdateEcoInput, type ChangeEcoStatusInput,
} from '@/modules/engineering/services/engineeringWriteService'

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string }

/** Sanitization contract for ECO actions — see deviceWriteActions.toMessage. */
function toMessage(err: unknown): string {
  if (err instanceof MfaRequiredError) {
    return 'Two-factor authentication required — reload the page to finish signing in.'
  }
  if (err instanceof UnauthenticatedError) return SESSION_EXPIRED_MESSAGE
  if (err instanceof InvalidTransitionError) return err.message
  // A ZodError is the form (or a stale screen) disagreeing with the schema — a
  // malformed id, a negative version — which the user can act on. Same treatment
  // as effectivityActions and failureActions.
  if (err instanceof z.ZodError) {
    return err.errors[0]?.message ?? 'That change could not be read. Reload and try again.'
  }
  // Both are refusals the user has to ACT on — "the approval you are relying on no
  // longer describes this order" and "this order's content is fixed". Their messages
  // are built in the domain for a reader and name the fields that moved; falling
  // through to the generic line below would replace the only actionable thing the
  // gate produces with "Something went wrong" plus a spurious error log.
  if (err instanceof ApprovalGateError) return err.message
  if (err instanceof EcoScopeLockedError) return err.message
  // "Only a submitted ECO can be sent for approval … and this ECO is 'draft'" —
  // the panel disables the control for exactly this reason, so reaching here means
  // a stale screen. The sentence names the current status, which is what tells the
  // user to reload rather than retry.
  if (err instanceof EcoApprovalRequestError) return err.message
  // Expected traffic, not a bug: the honest double-click and the honest re-submit
  // both produce it (approvalService's header says so).
  if (err instanceof ApprovalAlreadyPendingError) return err.message
  // Two "gone" classes reach this mapper: the write service's and ecoService's.
  // They mean the same thing to a reader and get the same sentence.
  if (err instanceof EcoNotFoundError) return 'That change order no longer exists. Reload and try again.'
  if (err instanceof RecordNotFoundError) return 'That change order no longer exists. Reload and try again.'
  if (err instanceof OptimisticLockError) return 'Someone else changed this order. Reload and try again.'
  if (err instanceof PermissionError) return "You don't have permission to do that."
  console.error(JSON.stringify({ level: 'error', msg: 'eco action failed', err: String(err) }))
  return 'Something went wrong. Try again, and tell Reet if it keeps happening.'
}

export async function createEcoAction(
  input: CreateEcoInput,
): Promise<ActionResult<{ id: string; ecoNo: string }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await createEco(actor, input)
    revalidatePath('/engineering/eco')
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function updateEcoAction(
  input: UpdateEcoInput,
): Promise<ActionResult<{ version: number }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await updateEco(actor, input)
    revalidatePath(`/engineering/eco/${input.id}`)
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function changeEcoStatusAction(
  input: ChangeEcoStatusInput,
): Promise<ActionResult<{ status: string; version: number }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await changeEcoStatus(actor, input)
    revalidatePath(`/engineering/eco/${input.id}`)
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

/**
 * Ask for a second pair of eyes on a submitted ECO (spec §5.5, AP2).
 *
 * THE MISSING HALF. `requestEcoApproval` shipped implemented, tested, templated
 * and registered — and unreachable, because nothing called it. With no way to
 * raise a request the approvals engine had no observable effect on Engineering
 * whatsoever: "requested ⇒ binding" is vacuous when no request can be made, and
 * `/approvals` could only ever hold invoice rows.
 *
 * IT DOES NOT MAKE APPROVAL MANDATORY, and that is deliberate rather than
 * unfinished. `requiredWithoutRequest` stays `false` at the gate; an ECO nobody
 * raised a request for behaves exactly as it did before, in every status. This
 * adds the ABILITY to ask, not a requirement to.
 *
 * Revalidates the ECO page AND the approvals queue, since the request lands in
 * someone else's list the moment it commits — the queue reads `approval` directly
 * and does not wait for the outbox drain.
 */
export async function requestEcoApprovalAction(
  input: RequestEcoApprovalInput,
): Promise<ActionResult<{ approvalId: string }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await requestEcoApproval(actor, input)
    revalidatePath(`/engineering/eco/${input.ecoId}`)
    revalidatePath('/approvals')
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}
