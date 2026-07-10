'use server'
import { updateUserRole, deactivateUser, reactivateUser } from '@/lib/services/userService'
import { getCurrentUser } from '@/lib/auth/session'
import { can, ACTIONS } from '@/lib/auth/permissions'
import { AppError } from '@/lib/types'
import type { Role } from '@/lib/types'
import { revalidatePath } from 'next/cache'

export type ActionResult = { error?: string }

// Server-action errors are sanitized by Next in production, so return the friendly
// AppError message as data instead of throwing — the client surfaces it in a toast.
function toResult(e: unknown, fallback: string): ActionResult {
  return { error: e instanceof AppError ? e.message : fallback }
}

export async function updateRoleAction(userId: string, role: Role): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user || !can(user.role as Role, ACTIONS.MANAGE_USERS)) return { error: 'Unauthorized' }
  try {
    await updateUserRole(userId, role, user.id, user.role as Role)
    revalidatePath('/admin/users')
    return {}
  } catch (e) {
    return toResult(e, 'Failed to update role')
  }
}

export async function deactivateUserAction(userId: string): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user || !can(user.role as Role, ACTIONS.MANAGE_USERS)) return { error: 'Unauthorized' }
  try {
    await deactivateUser(userId, user.id, user.role as Role)
    revalidatePath('/admin/users')
    return {}
  } catch (e) {
    return toResult(e, 'Failed to deactivate user')
  }
}

export async function reactivateUserAction(userId: string): Promise<ActionResult> {
  const user = await getCurrentUser()
  if (!user || !can(user.role as Role, ACTIONS.MANAGE_USERS)) return { error: 'Unauthorized' }
  try {
    await reactivateUser(userId, user.role as Role)
    revalidatePath('/admin/users')
    return {}
  } catch (e) {
    return toResult(e, 'Failed to reactivate user')
  }
}
