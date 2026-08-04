'use server'

import { revalidatePath } from 'next/cache'
import { z } from 'zod'
import { requireAal2Actor, MfaRequiredError } from '@/modules/shared/auth/session'
import { PermissionError } from '@/modules/shared/authz/authorize'
import { OptimisticLockError } from '@/lib/db/tx'
import { ApprovalGateError } from '@/modules/shared/approvals/domain/approvalGate'
import { EcoScopeLockedError } from '@/modules/shared/approvals/domain/ecoApproval'
import {
  addAffectedItem, removeAffectedItem, applyEcoEffectivity,
  BomEcoNotFoundError, BomApplyError, AffectedItemNotFoundError,
  AffectedItemLockedError, DuplicateAffectedItemError, BomReferenceNotFoundError,
  type AddAffectedItemInput, type RemoveAffectedItemInput,
  type ApplyEcoEffectivityInput, type ApplyEffectivityResult,
} from '@/modules/engineering/services/bomEffectivityService'

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string }

/** Sanitization contract — see failureActions.toMessage. */
function toMessage(err: unknown): string {
  if (err instanceof MfaRequiredError) {
    return 'Two-factor authentication required — reload the page to finish signing in.'
  }
  // A ZodError is the form disagreeing with the schema (a missing quantity on an
  // add, a serial past 200 chars), which the user can act on — the four other
  // action files that map it are the convention, not the exception.
  if (err instanceof z.ZodError) {
    return err.errors[0]?.message ?? 'That change could not be read. Check the form and try again.'
  }
  // BomApplyError / AffectedItemLockedError / DuplicateAffectedItemError all
  // carry operator-readable text built in the service; nothing internal leaks.
  if (err instanceof BomApplyError) return err.message
  if (err instanceof AffectedItemLockedError) return err.message
  if (err instanceof DuplicateAffectedItemError) return err.message
  // The approval refusals. `ApprovalGateError` names the fields that drifted and
  // `EcoScopeLockedError` says the content is fixed; both are the only actionable
  // thing the caller gets, so neither may fall through to the generic line.
  if (err instanceof ApprovalGateError) return err.message
  if (err instanceof EcoScopeLockedError) return err.message
  if (err instanceof BomReferenceNotFoundError) return `${err.message}. Reload and try again.`
  if (err instanceof BomEcoNotFoundError) {
    return 'That change order no longer exists. Reload and try again.'
  }
  if (err instanceof AffectedItemNotFoundError) {
    return 'That affected item no longer exists. Reload and try again.'
  }
  if (err instanceof OptimisticLockError) {
    return 'Someone else changed this change order. Reload and try again.'
  }
  if (err instanceof PermissionError) return "You don't have permission to do that."
  console.error(JSON.stringify({
    level: 'error', msg: 'bom effectivity action failed', err: String(err),
  }))
  return 'Something went wrong. Try again, and tell Reet if it keeps happening.'
}

export async function addAffectedItemAction(
  input: AddAffectedItemInput,
): Promise<ActionResult<{ id: string }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await addAffectedItem(actor, input)
    revalidatePath(`/engineering/eco/${input.ecoId}`)
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function removeAffectedItemAction(
  input: RemoveAffectedItemInput & { ecoId: string },
): Promise<ActionResult<{ version: number }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await removeAffectedItem(actor, { id: input.id, version: input.version })
    revalidatePath(`/engineering/eco/${input.ecoId}`)
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

/**
 * Apply an implemented ECO's affected items to the variant BOMs. Idempotent —
 * a second click reports "already applied" rather than doubling the BOM — so it
 * is safe to retry after any error the user sees here.
 */
export async function applyEcoEffectivityAction(
  input: ApplyEcoEffectivityInput,
): Promise<ActionResult<ApplyEffectivityResult>> {
  try {
    const actor = await requireAal2Actor()
    const res = await applyEcoEffectivity(actor, input)
    revalidatePath(`/engineering/eco/${input.ecoId}`)
    revalidatePath('/engineering/bom')
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}
