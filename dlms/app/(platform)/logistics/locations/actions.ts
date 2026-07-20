'use server'

import { revalidatePath } from 'next/cache'
import { requireAal2Actor, MfaRequiredError } from '@/modules/shared/auth/session'
import { PermissionError } from '@/modules/shared/authz/authorize'
import { OptimisticLockError } from '@/lib/db/tx'
import {
  createLocation, updateLocation, DuplicateLocationCodeError, LocationNotFoundError,
} from '@/modules/logistics/services/locationService'

type CreateInput = Parameters<typeof createLocation>[1]
type UpdateInput = Parameters<typeof updateLocation>[2]

type CreateResult = { ok: true; id: string } | { ok: false; error: string }
type ActionResult = { ok: true } | { ok: false; error: string }

/**
 * Maps internal errors to user-facing text — same rationale as
 * manufacturing/components/actions.ts's toUserMessage: a raw exception must
 * never reach the browser.
 */
function toUserMessage(err: unknown): string {
  if (err instanceof MfaRequiredError) {
    return 'Two-factor authentication required — reload the page to finish signing in.'
  }
  if (err instanceof DuplicateLocationCodeError) return err.message
  if (err instanceof LocationNotFoundError) return 'That location no longer exists. Reload and try again.'
  if (err instanceof PermissionError) return "You don't have permission to do that."
  if (err instanceof OptimisticLockError) return 'Someone else changed this — reload and try again.'
  console.error(JSON.stringify({
    level: 'error', msg: 'stock location action failed',
    err: err instanceof Error ? err.message : String(err),
  }))
  return 'Something went wrong — please try again.'
}

export async function createLocationAction(input: CreateInput): Promise<CreateResult> {
  try {
    const actor = await requireAal2Actor()
    const { id } = await createLocation(actor, input)
    revalidatePath('/logistics/locations')
    return { ok: true, id }
  } catch (err) {
    return { ok: false, error: toUserMessage(err) }
  }
}

export async function updateLocationAction(
  id: string, input: UpdateInput, version: number,
): Promise<ActionResult> {
  try {
    const actor = await requireAal2Actor()
    await updateLocation(actor, id, input, version)
    revalidatePath('/logistics/locations')
    return { ok: true }
  } catch (err) {
    return { ok: false, error: toUserMessage(err) }
  }
}
