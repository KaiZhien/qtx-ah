import { createAdminClient } from '@/lib/supabase/server'
import { can, ACTIONS } from '@/lib/auth/permissions'
import type { Role } from '@/lib/types'

/**
 * Mark `oldId` as replaced by `newId`.
 * Sets replaced_by on the old device row.
 */
export async function linkReplacement(
  oldId: string,
  newId: string,
  actorId: string,
  actorRole: Role,
): Promise<void> {
  if (!can(actorRole, ACTIONS.EDIT_DEVICE)) throw new Error('Unauthorized')
  if (oldId === newId) throw new Error('A device cannot replace itself')
  const supabase = createAdminClient()
  const { error } = await (supabase.from('device') as any)
    .update({ replaced_by: newId, updated_by: actorId })
    .eq('id', oldId)
    .is('deleted_at', null)
  if (error) throw new Error(error.message)
}

/**
 * Find the device that this device replaces (predecessor).
 * Returns the device row where replaced_by = deviceId.
 */
export async function getPredecessor(deviceId: string): Promise<{ id: string; device_sn: string | null; pcba_a_sn: string } | null> {
  const supabase = createAdminClient()
  const { data } = await (supabase.from('device') as any)
    .select('id, device_sn, pcba_a_sn')
    .eq('replaced_by', deviceId)
    .is('deleted_at', null)
    .limit(1)
    .maybeSingle()
  return data ?? null
}

/**
 * Find the device that replaces this device (successor).
 * Reads replaced_by on the current device.
 */
export async function getSuccessor(replacedById: string): Promise<{ id: string; device_sn: string | null; pcba_a_sn: string } | null> {
  if (!replacedById) return null
  const supabase = createAdminClient()
  const { data } = await (supabase.from('device') as any)
    .select('id, device_sn, pcba_a_sn')
    .eq('id', replacedById)
    .is('deleted_at', null)
    .maybeSingle()
  return data ?? null
}
