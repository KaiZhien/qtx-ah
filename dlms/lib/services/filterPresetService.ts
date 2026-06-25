import { createAdminClient } from '@/lib/supabase/server'

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

export async function savePreset(userId: string, name: string, queryString: string): Promise<FilterPreset> {
  const supabase = createAdminClient()
  const { data, error } = await (supabase.from('device_filter_preset') as any)
    .insert({ owner_id: userId, name, query_string: queryString })
    .select('id, name, query_string, created_at')
    .single()
  if (error) throw new Error(error.message)
  return data as FilterPreset
}

export async function deletePreset(id: string, userId: string): Promise<void> {
  const supabase = createAdminClient()
  await (supabase.from('device_filter_preset') as any)
    .delete()
    .eq('id', id)
    .eq('owner_id', userId)
}
