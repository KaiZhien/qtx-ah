import { createAdminClient } from '@/lib/supabase/server'
import { can, ACTIONS } from '@/lib/auth/permissions'
import { AppError } from '@/lib/types'
import type { StatusOption, PhaseOption, Role } from '@/lib/types'

export async function getStatuses(): Promise<StatusOption[]> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('status_option')
    .select('*')
    .eq('active', true)
    .order('sort_order')
    .order('code')
  if (error) throw new Error(error.message)
  return (data ?? []) as StatusOption[]
}

export async function getPhases(): Promise<PhaseOption[]> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('phase_option')
    .select('*')
    .eq('active', true)
    .order('sort_order')
    .order('code')
  if (error) throw new Error(error.message)
  return (data ?? []) as PhaseOption[]
}

export async function getAllStatuses(): Promise<StatusOption[]> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('status_option')
    .select('*')
    .order('sort_order')
    .order('code')
  if (error) throw new Error(error.message)
  return (data ?? []) as StatusOption[]
}

export async function getAllPhases(): Promise<PhaseOption[]> {
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('phase_option')
    .select('*')
    .order('sort_order')
    .order('code')
  if (error) throw new Error(error.message)
  return (data ?? []) as PhaseOption[]
}

export async function addStatusOption(
  code: string,
  labelEn: string,
  labelZh: string,
  actorRole: Role = 'admin'
): Promise<StatusOption> {
  if (!can(actorRole, ACTIONS.MANAGE_VOCABULARIES)) {
    throw new AppError({ type: 'permission', message: 'Only admins can manage vocabularies' })
  }
  const supabase = createAdminClient()
  const { data: existing } = await supabase.from('status_option').select('sort_order').order('sort_order', { ascending: false }).limit(1).single()
  const nextOrder = existing ? (existing.sort_order ?? 0) + 10 : 10

  const { data, error } = await supabase
    .from('status_option')
    .insert({ code: code.trim(), label_en: labelEn.trim(), label_zh: labelZh.trim(), sort_order: nextOrder })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data as StatusOption
}

export async function addPhaseOption(
  code: string,
  labelEn: string,
  labelZh: string,
  actorRole: Role = 'admin'
): Promise<PhaseOption> {
  if (!can(actorRole, ACTIONS.MANAGE_VOCABULARIES)) {
    throw new AppError({ type: 'permission', message: 'Only admins can manage vocabularies' })
  }
  const supabase = createAdminClient()
  const { data: existing } = await supabase.from('phase_option').select('sort_order').order('sort_order', { ascending: false }).limit(1).single()
  const nextOrder = existing ? (existing.sort_order ?? 0) + 10 : 10

  const { data, error } = await supabase
    .from('phase_option')
    .insert({ code: code.trim(), label_en: labelEn.trim(), label_zh: labelZh.trim(), sort_order: nextOrder })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data as PhaseOption
}

export async function toggleOptionActive(
  table: 'status_option' | 'phase_option',
  code: string,
  active: boolean,
  actorRole: Role = 'admin'
): Promise<void> {
  if (!can(actorRole, ACTIONS.MANAGE_VOCABULARIES)) {
    throw new AppError({ type: 'permission', message: 'Only admins can manage vocabularies' })
  }
  const supabase = createAdminClient()
  const { error } = await supabase.from(table).update({ active }).eq('code', code)
  if (error) throw new Error(error.message)
}
