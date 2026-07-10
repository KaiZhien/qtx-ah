import { createAdminClient } from '@/lib/supabase/server'
import { can, ACTIONS } from '@/lib/auth/permissions'
import { AppError } from '@/lib/types'
import type { AppUser, Role } from '@/lib/types'

export async function listUsers(): Promise<AppUser[]> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('app_user')
    .select('*')
    .order('created_at')
  if (error) throw new Error(error.message)
  return (data ?? []) as AppUser[]
}

/** Count active admins (used by the lockout guards below). */
async function countActiveAdmins(supabase: ReturnType<typeof createAdminClient>): Promise<number> {
  const { count, error } = await supabase
    .from('app_user')
    .select('*', { count: 'exact', head: true })
    .eq('role', 'admin')
    .eq('active', true)
  if (error) throw new Error(error.message)
  return count ?? 0
}

export async function updateUserRole(
  userId: string,
  role: Role,
  actorId: string,
  actorRole: Role = 'admin'
): Promise<AppUser> {
  if (!can(actorRole, ACTIONS.MANAGE_USERS)) {
    throw new AppError({ type: 'permission', message: 'Only admins can manage users' })
  }

  // Self-demotion guard: an admin cannot strip their own admin role (avoids
  // accidentally locking yourself out of user management).
  if (userId === actorId && role !== 'admin') {
    throw new AppError({
      type: 'validation',
      message: 'You cannot change your own role. Ask another admin to do it.',
      errors: {},
    })
  }

  const supabase = createAdminClient()

  // Last-admin guard: block demoting the only remaining active admin.
  if (role !== 'admin') {
    const { data: target } = await supabase
      .from('app_user')
      .select('role, active')
      .eq('id', userId)
      .single()
    if (target?.role === 'admin' && target?.active && (await countActiveAdmins(supabase)) <= 1) {
      throw new AppError({
        type: 'validation',
        message: 'Cannot demote the last active admin. Promote another admin first.',
        errors: {},
      })
    }
  }

  const { data, error } = await supabase
    .from('app_user')
    .update({ role })
    .eq('id', userId)
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data as AppUser
}

export async function deactivateUser(
  userId: string,
  actorId: string,
  actorRole: Role = 'admin'
): Promise<AppUser> {
  if (!can(actorRole, ACTIONS.MANAGE_USERS)) {
    throw new AppError({ type: 'permission', message: 'Only admins can manage users' })
  }

  // Self-deactivation guard: you cannot deactivate your own account.
  if (userId === actorId) {
    throw new AppError({
      type: 'validation',
      message: 'You cannot deactivate your own account. Ask another admin to do it.',
      errors: {},
    })
  }

  const supabase = createAdminClient()

  // Last-admin guard: block deactivating the only remaining active admin.
  const { data: target } = await supabase
    .from('app_user')
    .select('role, active')
    .eq('id', userId)
    .single()
  if (target?.role === 'admin' && target?.active && (await countActiveAdmins(supabase)) <= 1) {
    throw new AppError({
      type: 'validation',
      message: 'Cannot deactivate the last active admin. Promote another admin first.',
      errors: {},
    })
  }

  // Never hard-delete; preserve audit attribution
  const { data, error } = await supabase
    .from('app_user')
    .update({ active: false })
    .eq('id', userId)
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data as AppUser
}

export async function reactivateUser(
  userId: string,
  actorRole: Role = 'admin'
): Promise<AppUser> {
  if (!can(actorRole, ACTIONS.MANAGE_USERS)) {
    throw new AppError({ type: 'permission', message: 'Only admins can manage users' })
  }
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('app_user')
    .update({ active: true })
    .eq('id', userId)
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data as AppUser
}
