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

  // Device must exist and not be soft-deleted
  const { data: device, error: deviceErr } = await (supabase.from('device') as any)
    .select('id, deleted_at')
    .eq('id', deviceId)
    .single()
  if (deviceErr || !device || device.deleted_at) {
    throw new AppError({ type: 'validation', message: 'Device not found or has been deleted', errors: {} })
  }

  // Target user must exist, be active, and be an assignable role (engineer or admin)
  const { data: target, error: userErr } = await (supabase.from('app_user') as any)
    .select('id, role, active')
    .eq('id', userId)
    .single()
  if (userErr || !target || !target.active || !['engineer', 'admin'].includes(target.role)) {
    throw new AppError({ type: 'validation', message: 'Target user must be an active engineer or admin', errors: {} })
  }

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
