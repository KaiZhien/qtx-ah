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

export async function updateUserRole(
  userId: string,
  role: Role,
  actorRole: Role = 'admin'
): Promise<AppUser> {
  if (!can(actorRole, ACTIONS.MANAGE_USERS)) {
    throw new AppError({ type: 'permission', message: 'Only admins can manage users' })
  }
  const supabase = createAdminClient()
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
  actorRole: Role = 'admin'
): Promise<AppUser> {
  if (!can(actorRole, ACTIONS.MANAGE_USERS)) {
    throw new AppError({ type: 'permission', message: 'Only admins can manage users' })
  }
  const supabase = createAdminClient()
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
