'use server'

import { revalidatePath } from 'next/cache'
import { requireActor } from '@/modules/shared/auth/session'
import { PermissionError } from '@/modules/shared/authz/authorize'
import { OptimisticLockError } from '@/lib/db/tx'
import { InvalidTransitionError } from '@/modules/engineering/domain/transition'
import {
  createEcr, updateEcr, changeEcrStatus, RecordNotFoundError,
  type CreateEcrInput, type UpdateEcrInput, type ChangeEcrStatusInput,
} from '@/modules/engineering/services/engineeringWriteService'

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string }

/**
 * Single sanitization contract for every ECR action (mirrors
 * deviceWriteActions.toMessage): known, safe errors surface their own message;
 * anything else is logged server-side and replaced with a generic line so a raw
 * Postgres/internal error can never reach the browser.
 */
function toMessage(err: unknown): string {
  if (err instanceof InvalidTransitionError) return err.message
  if (err instanceof RecordNotFoundError) return 'That change request no longer exists. Reload and try again.'
  if (err instanceof OptimisticLockError) return 'Someone else changed this request. Reload and try again.'
  if (err instanceof PermissionError) return "You don't have permission to do that."
  console.error(JSON.stringify({ level: 'error', msg: 'ecr action failed', err: String(err) }))
  return 'Something went wrong. Try again, and tell Reet if it keeps happening.'
}

export async function createEcrAction(
  input: CreateEcrInput,
): Promise<ActionResult<{ id: string; ecrNo: string }>> {
  try {
    const actor = await requireActor()
    const res = await createEcr(actor, input)
    revalidatePath('/engineering/ecr')
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function updateEcrAction(
  input: UpdateEcrInput,
): Promise<ActionResult<{ version: number }>> {
  try {
    const actor = await requireActor()
    const res = await updateEcr(actor, input)
    revalidatePath(`/engineering/ecr/${input.id}`)
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function changeEcrStatusAction(
  input: ChangeEcrStatusInput,
): Promise<ActionResult<{ status: string; version: number }>> {
  try {
    const actor = await requireActor()
    const res = await changeEcrStatus(actor, input)
    revalidatePath(`/engineering/ecr/${input.id}`)
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}
