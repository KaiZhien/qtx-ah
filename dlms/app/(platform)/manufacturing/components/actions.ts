'use server'

import { revalidatePath } from 'next/cache'
import {
  requireAal2Actor, MfaRequiredError, UnauthenticatedError, SESSION_EXPIRED_MESSAGE,
} from '@/modules/shared/auth/session'
import { PermissionError } from '@/modules/shared/authz/authorize'
import { OptimisticLockError } from '@/lib/db/tx'
import {
  createComponentType, updateComponentType,
} from '@/modules/manufacturing/services/componentCatalogueService'

type CreateInput = Parameters<typeof createComponentType>[1]
type UpdateInput = Parameters<typeof updateComponentType>[2]

type CreateResult = { ok: true; id: string } | { ok: false; error: string }
type ActionResult = { ok: true } | { ok: false; error: string }

/**
 * Maps internal errors to user-facing text, same rationale as
 * app/(platform)/admin/users/actions.ts's toUserMessage: a raw exception must
 * never reach the browser.
 */
function toUserMessage(err: unknown): string {
  if (err instanceof MfaRequiredError) {
    return 'Two-factor authentication required — reload the page to finish signing in.'
  }
  if (err instanceof UnauthenticatedError) return SESSION_EXPIRED_MESSAGE
  if (err instanceof PermissionError) return "You don't have permission to do that"
  if (err instanceof OptimisticLockError) return 'Someone else changed this — reload and try again'
  console.error(JSON.stringify({
    level: 'error', msg: 'component catalogue action failed',
    err: err instanceof Error ? err.message : String(err),
  }))
  return 'Something went wrong — please try again'
}

export async function createTypeAction(input: CreateInput): Promise<CreateResult> {
  try {
    const actor = await requireAal2Actor()
    const { id } = await createComponentType(actor, input)
    revalidatePath('/manufacturing/components')
    return { ok: true, id }
  } catch (err) {
    return { ok: false, error: toUserMessage(err) }
  }
}

/** tracking_mode is never accepted here — see componentCatalogueService.updateComponentType. */
export async function updateTypeAction(
  id: string, input: UpdateInput, version: number,
): Promise<ActionResult> {
  try {
    const actor = await requireAal2Actor()
    await updateComponentType(actor, id, input, version)
    revalidatePath('/manufacturing/components')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: toUserMessage(err) }
  }
}
