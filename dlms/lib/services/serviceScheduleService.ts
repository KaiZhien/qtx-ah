import { createAdminClient } from '@/lib/supabase/server'

/**
 * Returns the count of non-deleted devices whose next_service_date
 * falls between today and `days` days from now (inclusive).
 */
export async function getUpcomingServiceCount(days = 7): Promise<number> {
  const supabase = createAdminClient()
  const today = new Date()
  const future = new Date(today)
  future.setDate(today.getDate() + days)

  const { count, error } = await (supabase
    .from('device') as any)
    .select('*', { count: 'exact', head: true })
    .is('deleted_at', null)
    .not('next_service_date', 'is', null)
    .gte('next_service_date', today.toISOString().slice(0, 10))
    .lte('next_service_date', future.toISOString().slice(0, 10))

  if (error) throw new Error(error.message)
  return count ?? 0
}
