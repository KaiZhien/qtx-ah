'use server'

import { revalidatePath } from 'next/cache'
import { requireActor } from '@/modules/shared/auth/session'
import { PermissionError } from '@/modules/shared/authz/authorize'
import { OptimisticLockError } from '@/lib/db/tx'
import { InvalidTransitionError } from '@/modules/engineering/domain/transition'
import {
  createEco, updateEco, changeEcoStatus, RecordNotFoundError,
  type CreateEcoInput, type UpdateEcoInput, type ChangeEcoStatusInput,
} from '@/modules/engineering/services/engineeringWriteService'

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string }

/** Sanitization contract for ECO actions — see deviceWriteActions.toMessage. */
function toMessage(err: unknown): string {
  if (err instanceof InvalidTransitionError) return err.message
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
    const actor = await requireActor()
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
    const actor = await requireActor()
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
    const actor = await requireActor()
    const res = await changeEcoStatus(actor, input)
    revalidatePath(`/engineering/eco/${input.id}`)
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}
