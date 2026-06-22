'use server'
import { updateUserRole, deactivateUser } from '@/lib/services/userService'
import { getCurrentUser } from '@/lib/auth/session'
import { can, ACTIONS } from '@/lib/auth/permissions'
import type { Role } from '@/lib/types'
import { revalidatePath } from 'next/cache'

export async function updateRoleAction(userId: string, role: Role) {
  const user = await getCurrentUser()
  if (!user || !can(user.role as Role, ACTIONS.MANAGE_USERS)) throw new Error('Unauthorized')
  await updateUserRole(userId, role, user.role as Role)
  revalidatePath('/admin/users')
}

export async function deactivateUserAction(userId: string) {
  const user = await getCurrentUser()
  if (!user || !can(user.role as Role, ACTIONS.MANAGE_USERS)) throw new Error('Unauthorized')
  await deactivateUser(userId, user.role as Role)
  revalidatePath('/admin/users')
}
