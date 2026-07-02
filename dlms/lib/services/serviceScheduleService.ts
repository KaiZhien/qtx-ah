import { createAdminClient } from '@/lib/supabase/server'
import { SERVICE_INTERVAL_DAYS, computeOverdueDeviceIds } from '@/lib/domain/serviceSchedule'

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

/**
 * Returns ids of non-deleted devices overdue for a service event: no
 * `service_event` logged within `intervalDays`, falling back to `ship_date`
 * when no service event has ever been logged.
 */
export async function getOverdueServiceDeviceIds(
  intervalDays = SERVICE_INTERVAL_DAYS
): Promise<string[]> {
  const supabase = createAdminClient()

  const { data: devices, error: devicesError } = await supabase
    .from('device')
    .select('id, ship_date')
    .is('deleted_at', null)
  if (devicesError) throw new Error(devicesError.message)

  const { data: events, error: eventsError } = await supabase
    .from('service_event')
    .select('device_id, occurred_on')
  if (eventsError) throw new Error(eventsError.message)

  const latestByDevice = new Map<string, string>()
  for (const event of events ?? []) {
    const current = latestByDevice.get(event.device_id)
    if (!current || event.occurred_on > current) {
      latestByDevice.set(event.device_id, event.occurred_on)
    }
  }

  return computeOverdueDeviceIds(devices ?? [], latestByDevice, intervalDays)
}

/**
 * Count of non-deleted devices overdue for a service event.
 * Used by the /devices page banner.
 */
export async function getOverdueServiceCount(
  intervalDays = SERVICE_INTERVAL_DAYS
): Promise<number> {
  return (await getOverdueServiceDeviceIds(intervalDays)).length
}
