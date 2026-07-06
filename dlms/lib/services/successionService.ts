import { createAdminClient } from '@/lib/supabase/server'
import { can, ACTIONS } from '@/lib/auth/permissions'
import { AppError } from '@/lib/types'
import type { Role } from '@/lib/types'

/**
 * Mark `oldId` as replaced by `newId`.
 * Sets replaced_by on the old device row, guarded by optimistic concurrency.
 * Rejects self-links, missing/deleted devices, version mismatches, and any link
 * that would introduce a cycle in the replacement chain.
 */
export async function linkReplacement(
  oldId: string,
  newId: string,
  version: number,
  actorId: string,
  actorRole: Role,
): Promise<void> {
  if (!can(actorRole, ACTIONS.EDIT_DEVICE)) {
    throw new AppError({ type: 'permission', message: 'You do not have permission to edit devices' })
  }
  if (oldId === newId) {
    throw new AppError({ type: 'validation', message: 'A device cannot replace itself', errors: {} })
  }

  const supabase = createAdminClient()

  // OLD device: must exist, not be deleted, and match the expected version
  const { data: current, error: fetchErr } = await (supabase.from('device') as any)
    .select('id, deleted_at, version')
    .eq('id', oldId)
    .single()
  if (fetchErr || !current) {
    throw new AppError({ type: 'validation', message: 'Device not found', errors: {} })
  }
  if (current.deleted_at) {
    throw new AppError({ type: 'validation', message: 'Cannot link a replacement on a deleted record', errors: {} })
  }
  if (current.version !== version) {
    throw new AppError({
      type: 'conflict',
      message: 'Record has been modified by another user. Please reload and try again.',
    })
  }

  // NEW device: must exist and not be deleted
  const { data: replacement, error: newErr } = await (supabase.from('device') as any)
    .select('id, deleted_at, replaced_by')
    .eq('id', newId)
    .single()
  if (newErr || !replacement) {
    throw new AppError({ type: 'validation', message: 'Replacement device not found', errors: {} })
  }
  if (replacement.deleted_at) {
    throw new AppError({ type: 'validation', message: 'Cannot link a deleted device as a replacement', errors: {} })
  }

  // Cycle prevention: walk replaced_by from newId; reject on reaching oldId or a revisit
  const visited = new Set<string>([newId])
  let cursor: string | null = replacement.replaced_by ?? null
  for (let depth = 0; cursor && depth < 20; depth++) {
    if (cursor === oldId || visited.has(cursor)) {
      throw new AppError({ type: 'validation', message: 'Linking this replacement would create a cycle', errors: {} })
    }
    visited.add(cursor)
    const { data: hop } = await (supabase.from('device') as any)
      .select('replaced_by')
      .eq('id', cursor)
      .maybeSingle()
    cursor = hop?.replaced_by ?? null
  }

  const { data: updated, error } = await (supabase.from('device') as any)
    .update({ replaced_by: newId, updated_by: actorId })
    .eq('id', oldId)
    .eq('version', version)  // optimistic guard
    .is('deleted_at', null)
    .select('id')
    .maybeSingle()
  if (error) throw new Error(error.message)
  // A 0-row update (no row came back) means a concurrent writer bumped `version`
  // between the pre-check and this UPDATE — replaced_by was never written.
  if (!updated) {
    throw new AppError({
      type: 'conflict',
      message: 'Device was modified by another user — reload and retry',
    })
  }
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
