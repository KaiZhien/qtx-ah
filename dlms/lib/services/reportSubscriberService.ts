import { createAdminClient, createReadClient } from '@/lib/supabase/server'
import { can, ACTIONS } from '@/lib/auth/permissions'
import { AppError } from '@/lib/types'
import type { Role } from '@/lib/types'

export type ReportSubscriber = {
  id: string
  email: string
  active: boolean
  created_at: string
}

export async function listSubscribers(): Promise<ReportSubscriber[]> {
  // report_subscriber SELECT RLS is admin-only, matching the page's MANAGE_USERS
  // gating — the app-layer gate stays the enforcement boundary; RLS backstops it.
  const supabase = createReadClient()
  const { data, error } = await supabase
    .from('report_subscriber')
    .select('*')
    .order('created_at', { ascending: false })
  if (error) throw new Error(error.message)
  return (data ?? []) as ReportSubscriber[]
}

export async function addSubscriber(
  email: string,
  actorRole: Role = 'admin'
): Promise<ReportSubscriber> {
  if (!can(actorRole, ACTIONS.MANAGE_USERS)) {
    throw new AppError({ type: 'permission', message: 'Only admins can manage subscribers' })
  }
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('report_subscriber')
    .insert({ email: email.trim().toLowerCase(), active: true })
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data as ReportSubscriber
}

export async function setSubscriberActive(
  id: string,
  active: boolean,
  actorRole: Role = 'admin'
): Promise<ReportSubscriber> {
  if (!can(actorRole, ACTIONS.MANAGE_USERS)) {
    throw new AppError({ type: 'permission', message: 'Only admins can manage subscribers' })
  }
  const supabase = createAdminClient()
  const { data, error } = await supabase
    .from('report_subscriber')
    .update({ active })
    .eq('id', id)
    .select()
    .single()
  if (error) throw new Error(error.message)
  return data as ReportSubscriber
}

export async function deleteSubscriber(
  id: string,
  actorRole: Role = 'admin'
): Promise<void> {
  if (!can(actorRole, ACTIONS.MANAGE_USERS)) {
    throw new AppError({ type: 'permission', message: 'Only admins can manage subscribers' })
  }
  const supabase = createAdminClient()
  const { error } = await supabase
    .from('report_subscriber')
    .delete()
    .eq('id', id)
  if (error) throw new Error(error.message)
}
