/**
 * Assignment service — manages device-to-user assignments.
 * All DB writes go through here. No component or Server Action writes directly.
 */

import { createAdminClient } from '@/lib/supabase/server'
import { can, ACTIONS } from '@/lib/auth/permissions'
import { AppError } from '@/lib/types'
import type { AppUser, Role } from '@/lib/types'

export async function listAssignees(deviceId: string): Promise<AppUser[]> {
  const supabase = createAdminClient()
  const { data, error } = await (supabase.from('device_assignment') as any)
    .select('app_user!device_assignment_user_id_fkey(*)')
    .eq('device_id', deviceId)
    .order('assigned_at', { ascending: true })
  if (error) throw new Error(error.message)
  return ((data ?? []) as Array<{ app_user: AppUser | null }>)
    .map((r) => r.app_user)
    .filter((u): u is AppUser => u !== null)
}

export async function assignDevice(
  deviceId: string,
  userId: string,
  actorId: string,
  actorRole: Role
): Promise<void> {
  if (!can(actorRole, ACTIONS.ASSIGN_DEVICE)) {
    throw new AppError({ type: 'permission', message: 'You do not have permission to assign devices' })
  }
  const supabase = createAdminClient()
  const { error } = await (supabase.from('device_assignment') as any)
    .upsert(
      { device_id: deviceId, user_id: userId, assigned_by: actorId },
      { onConflict: 'device_id,user_id', ignoreDuplicates: true }
    )
  if (error) throw new Error(error.message)
}

export async function unassignDevice(
  deviceId: string,
  userId: string,
  actorId: string,
  actorRole: Role
): Promise<void> {
  if (!can(actorRole, ACTIONS.ASSIGN_DEVICE)) {
    throw new AppError({ type: 'permission', message: 'You do not have permission to unassign devices' })
  }
  const supabase = createAdminClient()
  const { error } = await (supabase.from('device_assignment') as any)
    .delete()
    .eq('device_id', deviceId)
    .eq('user_id', userId)
  if (error) throw new Error(error.message)
}

export async function getAssignedDeviceIds(userId: string): Promise<string[]> {
  const supabase = createAdminClient()
  const { data, error } = await (supabase.from('device_assignment') as any)
    .select('device_id')
    .eq('user_id', userId)
  if (error) throw new Error(error.message)
  return ((data ?? []) as Array<{ device_id: string }>).map((r) => r.device_id)
}
