/**
 * Service schedule domain helpers — pure, no I/O.
 *
 * Determines whether a device is overdue for preventive maintenance: no
 * `service_event` logged within `SERVICE_INTERVAL_DAYS`, falling back to
 * `ship_date` as the baseline when no service event has ever been logged.
 */

import { differenceInCalendarDays, parseISO } from 'date-fns'

export const SERVICE_INTERVAL_DAYS = 180

export type ServiceStatus = {
  overdue: boolean
  daysSinceBaseline: number | null
  baselineDate: string | null
}

/**
 * The date maintenance cadence is measured from: the last logged service
 * event, or ship_date if none has ever been logged, or null if neither exists.
 */
export function baselineDate(
  lastServiceDate: string | null,
  shipDate: string | null
): string | null {
  return lastServiceDate ?? shipDate ?? null
}

/**
 * @param today - Injected for deterministic testing; defaults to `new Date()`.
 */
export function serviceStatus(
  lastServiceDate: string | null,
  shipDate: string | null,
  intervalDays: number = SERVICE_INTERVAL_DAYS,
  today: Date = new Date()
): ServiceStatus {
  const baseline = baselineDate(lastServiceDate, shipDate)
  if (!baseline) {
    return { overdue: false, daysSinceBaseline: null, baselineDate: null }
  }

  const daysSinceBaseline = differenceInCalendarDays(today, parseISO(baseline))
  return {
    overdue: daysSinceBaseline > intervalDays,
    daysSinceBaseline,
    baselineDate: baseline,
  }
}

/**
 * @param today - Injected for deterministic testing; defaults to `new Date()`.
 */
export function computeOverdueDeviceIds(
  devices: { id: string; ship_date: string | null }[],
  latestByDevice: Map<string, string>,
  intervalDays: number = SERVICE_INTERVAL_DAYS,
  today: Date = new Date()
): string[] {
  return devices
    .filter((device) =>
      serviceStatus(latestByDevice.get(device.id) ?? null, device.ship_date, intervalDays, today)
        .overdue
    )
    .map((device) => device.id)
}
