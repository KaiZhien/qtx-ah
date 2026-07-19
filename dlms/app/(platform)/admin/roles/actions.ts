'use server'

import { revalidatePath } from 'next/cache'
import { ZodError } from 'zod'
import { requireActor } from '@/modules/shared/auth/session'
import { PermissionError } from '@/modules/shared/authz/authorize'
import {
  setRolePermission, addOverride, FabricLockoutError,
  type SetRolePermissionInput, type AddOverrideInput,
} from '@/modules/admin/services/roleService'

type ActionResult = { ok: true } | { error: string }

/**
 * Maps internal errors to user-facing text, same rationale as
 * app/(platform)/admin/users/actions.ts's toUserMessage: a raw exception must
 * never reach the browser, but FabricLockoutError's message is already
 * written for an operator to read, so it passes through unchanged.
 */
function toUserMessage(err: unknown): string {
  if (err instanceof PermissionError) return "You don't have permission to do that"
  if (err instanceof FabricLockoutError) return err.message
  if (err instanceof ZodError) return err.issues[0]?.message ?? 'Please check the form and try again'
  console.error(JSON.stringify({
    level: 'error', msg: 'admin role action failed',
    err: err instanceof Error ? err.message : String(err),
  }))
  return 'Something went wrong — please try again'
}

export async function setRolePermissionAction(input: SetRolePermissionInput): Promise<ActionResult> {
  const actor = await requireActor()
  try {
    await setRolePermission(actor, input)
    revalidatePath('/admin/roles')
    return { ok: true }
  } catch (err) {
    return { error: toUserMessage(err) }
  }
}

export async function addOverrideAction(input: AddOverrideInput): Promise<ActionResult> {
  const actor = await requireActor()
  try {
    await addOverride(actor, input)
    revalidatePath(`/admin/users/${input.userId}/overrides`)
    return { ok: true }
  } catch (err) {
    return { error: toUserMessage(err) }
  }
}
