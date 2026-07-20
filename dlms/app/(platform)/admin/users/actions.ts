'use server'

import { revalidatePath } from 'next/cache'
import { requireActor } from '@/modules/shared/auth/session'
import { recordAuthEvent } from '@/modules/shared/auth/authEvents'
import { createAdminClient } from '@/lib/supabase/server'
import { authorize, PermissionError } from '@/modules/shared/authz/authorize'
import { OptimisticLockError } from '@/lib/db/tx'
import { LastSuperAdminError, SelfEscalationError } from '@/modules/admin/domain/userGuards'
import {
  inviteUser, setUserActive, updateUserAccess, resetUserMfa,
  type InviteUserInput, type UpdateAccessInput,
} from '@/modules/admin/services/userService'

type ActionResult = { ok: true } | { error: string }
type InviteResult = { ok: true; userId: string } | { error: string }

/**
 * Maps internal errors to user-facing text (spec §7.3 style, applied to the
 * admin console): a raw exception message must never reach the browser, but
 * the last-admin/self-escalation guards throw messages that are already
 * meant to be read by the operator, so those pass through unchanged.
 */
function toUserMessage(err: unknown): string {
  if (err instanceof PermissionError) return "You don't have permission to do that"
  if (err instanceof OptimisticLockError) return 'Someone else changed this user — reload and try again'
  if (err instanceof LastSuperAdminError || err instanceof SelfEscalationError) return err.message
  console.error(JSON.stringify({
    level: 'error', msg: 'admin user action failed',
    err: err instanceof Error ? err.message : String(err),
  }))
  return 'Something went wrong — please try again'
}

/**
 * Creates the app_user row, then sends the Supabase Auth invite.
 *
 * Order matters (see userService.inviteUser's comment): if the email send
 * fails after the row commits, the user is left as a re-sendable pending
 * invite rather than losing the whole action, so that failure is logged, not
 * thrown.
 */
export async function inviteUserAction(input: InviteUserInput): Promise<InviteResult> {
  const actor = await requireActor()
  try {
    const { userId } = await inviteUser(actor, input)

    const supabase = createAdminClient()
    const { error } = await supabase.auth.admin.inviteUserByEmail(input.email)
    if (error) {
      console.error(JSON.stringify({
        level: 'error', msg: 'invite email send failed', email: input.email, err: error.message,
      }))
    }

    revalidatePath('/admin/users')
    return { ok: true, userId }
  } catch (err) {
    return { error: toUserMessage(err) }
  }
}

/** Re-sends the Supabase Auth invite for a user still awaiting first sign-in. */
export async function resendInviteAction(email: string): Promise<ActionResult> {
  const actor = await requireActor()
  try {
    authorize(actor, 'manage_users', 'admin')
    const supabase = createAdminClient()
    const { error } = await supabase.auth.admin.inviteUserByEmail(email)
    if (error) throw new Error(error.message)
    revalidatePath('/admin/users')
    return { ok: true }
  } catch (err) {
    return { error: toUserMessage(err) }
  }
}

/**
 * Activates or deactivates an account. On deactivation, live Supabase
 * sessions are revoked immediately (rather than waiting for token expiry)
 * and the security trail records a session_revoked event.
 *
 * auth_user_id for the signOut call comes back from setUserActive (read
 * server-side, inside the transaction, from the row the version check just
 * validated) rather than from a client-supplied argument — a caller could
 * pass any auth_user_id, and signing that account out globally is a
 * denial-of-service against a user unrelated to the one actually deactivated.
 */
export async function setUserActiveAction(
  userId: string, active: boolean, version: number,
): Promise<ActionResult> {
  const actor = await requireActor()
  try {
    const { authUserId } = await setUserActive(actor, userId, active, version)

    if (!active && authUserId) {
      const supabase = createAdminClient()
      const { error } = await supabase.auth.admin.signOut(authUserId, 'global')
      if (error) {
        console.error(JSON.stringify({
          level: 'error', msg: 'signOut on deactivation failed', userId, err: error.message,
        }))
      }
      await recordAuthEvent({ eventType: 'session_revoked', userId })
    }

    revalidatePath('/admin/users')
    return { ok: true }
  } catch (err) {
    return { error: toUserMessage(err) }
  }
}

export async function updateUserAccessAction(
  userId: string, input: UpdateAccessInput, version: number,
): Promise<ActionResult> {
  const actor = await requireActor()
  try {
    await updateUserAccess(actor, userId, input, version)
    revalidatePath('/admin/users')
    return { ok: true }
  } catch (err) {
    return { error: toUserMessage(err) }
  }
}

/** Resets a user's MFA factor (admin recovery). They re-enroll on next login. */
export async function resetUserMfaAction(userId: string): Promise<ActionResult> {
  const actor = await requireActor()
  try {
    await resetUserMfa(actor, userId)
    revalidatePath('/admin/users')
    return { ok: true }
  } catch (err) {
    return { error: toUserMessage(err) }
  }
}
