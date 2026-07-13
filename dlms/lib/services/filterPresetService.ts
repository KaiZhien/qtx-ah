import { createAdminClient } from '@/lib/supabase/server'
import { can, ACTIONS } from '@/lib/auth/permissions'
import { AppError } from '@/lib/types'
import type { Role } from '@/lib/types'

export type FilterPreset = {
  id: string
  name: string
  query_string: string
  created_at: string
}

export async function listPresets(userId: string): Promise<FilterPreset[]> {
  const supabase = createAdminClient()
  const { data } = await (supabase.from('device_filter_preset') as any)
    .select('id, name, query_string, created_at')
    .eq('owner_id', userId)
    .order('created_at', { ascending: false })
    .limit(20)
  return (data ?? []) as FilterPreset[]
}

export async function savePreset(userId: string, name: string, queryString: string, actorRole: Role): Promise<FilterPreset> {
  if (!can(actorRole, ACTIONS.SAVE_FILTER_PRESET)) {
    throw new AppError({ type: 'permission', message: 'You do not have permission to save filter presets' })
  }
  const supabase = createAdminClient()
  const { data, error } = await (supabase.from('device_filter_preset') as any)
    .insert({ owner_id: userId, name, query_string: queryString })
    .select('id, name, query_string, created_at')
    .single()
  if (error) throw new Error(error.message)
  return data as FilterPreset
}

export async function deletePreset(id: string, userId: string, actorRole: Role): Promise<void> {
  if (!can(actorRole, ACTIONS.SAVE_FILTER_PRESET)) {
    throw new AppError({ type: 'permission', message: 'You do not have permission to delete filter presets' })
  }
  const supabase = createAdminClient()
  await (supabase.from('device_filter_preset') as any)
    .delete()
    .eq('id', id)
    .eq('owner_id', userId)
}
