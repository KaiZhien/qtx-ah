/**
 * Analytics service — queries analytics views for dashboard metrics.
 * All functions use createAdminClient() and throw new Error(error.message) on query errors.
 */

import { createAdminClient } from '@/lib/supabase/server'
import type {
  AnalyticsRange,
  OverviewMetrics,
  ThroughputPoint,
  StatusDuration,
  TransitionEdge,
  EngineerActivity,
  MyQueueItem,
} from '@/lib/types'

/** Convert an AnalyticsRange to an ISO date string (YYYY-MM-DD) for the start of the window */
function rangeToDate(range: AnalyticsRange): string {
  const days = range === '7d' ? 7 : range === '30d' ? 30 : 90
  const d = new Date()
  d.setDate(d.getDate() - days)
  return d.toISOString().split('T')[0]
}

/**
 * Parse a PostgreSQL interval string to seconds.
 * Handles formats like:
 *   "2 days 03:00:00"
 *   "0 days 00:30:00"
 *   "5:00:00"
 *   "1 day 00:00:00"
 *   "P2DT3H"  (ISO 8601, unlikely but handled)
 */
export function parseIntervalToSeconds(interval: string): number {
  if (!interval) return 0

  let total = 0
  const yearMatch = interval.match(/(\d+)\s+years?/)
  if (yearMatch) total += parseInt(yearMatch[1]) * 31536000
  const monMatch = interval.match(/(\d+)\s+mons?/)
  if (monMatch) total += parseInt(monMatch[1]) * 2592000
  const dayMatch = interval.match(/(\d+)\s+days?/)
  if (dayMatch) total += parseInt(dayMatch[1]) * 86400
  const timeMatch = interval.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (timeMatch) {
    total += parseInt(timeMatch[1]) * 3600
    total += parseInt(timeMatch[2]) * 60
    total += parseFloat(timeMatch[3])
  }
  return total
}

/** Compute median of a sorted numeric array */
function median(sorted: number[]): number {
  if (sorted.length === 0) return 0
  const mid = Math.floor(sorted.length / 2)
  if (sorted.length % 2 === 1) return sorted[mid]
  return (sorted[mid - 1] + sorted[mid]) / 2
}

/**
 * Current-state distribution across all active devices.
 * Queries v_current_distribution (already aggregated by status × phase).
 */
export async function getOverviewMetrics(): Promise<OverviewMetrics> {
  const supabase = createAdminClient()

  const { data, error } = await supabase
    .from('v_current_distribution')
    .select('*')

  if (error) throw new Error(error.message)

  const rows = data ?? []

  // Compute totals
  let totalDevices = 0
  let totalUnits = 0
  for (const row of rows) {
    totalDevices += row.device_count ?? 0
    totalUnits += row.unit_count ?? 0
  }

  // Aggregate by status
  const statusMap = new Map<string, { label_en: string; label_zh: string; device_count: number; unit_count: number }>()
  for (const row of rows) {
    const key = row.status as string
    const existing = statusMap.get(key)
    if (existing) {
      existing.device_count += row.device_count ?? 0
      existing.unit_count += row.unit_count ?? 0
    } else {
      statusMap.set(key, {
        label_en: row.status_label_en ?? key,
        label_zh: row.status_label_zh ?? key,
        device_count: row.device_count ?? 0,
        unit_count: row.unit_count ?? 0,
      })
    }
  }

  // Aggregate by phase
  const phaseMap = new Map<string, { label_en: string; label_zh: string; device_count: number; unit_count: number }>()
  for (const row of rows) {
    const key = row.phase as string
    const existing = phaseMap.get(key)
    if (existing) {
      existing.device_count += row.device_count ?? 0
      existing.unit_count += row.unit_count ?? 0
    } else {
      phaseMap.set(key, {
        label_en: row.phase_label_en ?? key,
        label_zh: row.phase_label_zh ?? key,
        device_count: row.device_count ?? 0,
        unit_count: row.unit_count ?? 0,
      })
    }
  }

  return {
    totalDevices,
    totalUnits,
    byStatus: Array.from(statusMap.entries()).map(([status, v]) => ({ status, ...v })),
    byPhase: Array.from(phaseMap.entries()).map(([phase, v]) => ({ phase, ...v })),
  }
}

/**
 * Daily throughput time series over the given range.
 * Queries v_daily_throughput.
 */
export async function getThroughputSeries(range: AnalyticsRange): Promise<ThroughputPoint[]> {
  const supabase = createAdminClient()
  const since = rangeToDate(range)

  const { data, error } = await supabase
    .from('v_daily_throughput')
    .select('*')
    .gte('day', since)
    .order('day', { ascending: true })

  if (error) throw new Error(error.message)

  return (data ?? []).map((row) => ({
    day: row.day as string,
    devicesCreated: (row.devices_created as number) ?? 0,
    devicesCompleted: (row.devices_completed as number) ?? 0,
  }))
}

/**
 * Average and median time each device spent in each status.
 * Queries all rows from v_status_dwell and computes statistics in TypeScript
 * because PERCENTILE_CONT is not supported by the Supabase JS query builder.
 */
export async function getStatusDurations(): Promise<StatusDuration[]> {
  const supabase = createAdminClient()

  const { data, error } = await supabase
    .from('v_status_dwell')
    .select('status, dwell_interval')

  if (error) throw new Error(error.message)

  // Group dwell seconds by status
  const groups = new Map<string, number[]>()
  for (const row of data ?? []) {
    const status = row.status as string
    const seconds = parseIntervalToSeconds(row.dwell_interval as string)
    const arr = groups.get(status) ?? []
    arr.push(seconds)
    groups.set(status, arr)
  }

  const results: StatusDuration[] = []
  for (const [status, secondsArr] of groups.entries()) {
    const sorted = [...secondsArr].sort((a, b) => a - b)
    const avgDays = secondsArr.reduce((sum, s) => sum + s, 0) / secondsArr.length / 86400
    const medianDays = median(sorted) / 86400
    results.push({
      status,
      avgDays,
      medianDays,
      sampleCount: secondsArr.length,
    })
  }

  // Sort by avgDays descending
  results.sort((a, b) => b.avgDays - a.avgDays)
  return results
}

/**
 * Status transition counts — how often devices move from one status to another.
 * Queries all rows from v_status_transition and aggregates in TypeScript
 * because the Supabase JS query builder doesn't support GROUP BY.
 */
export async function getTransitionFunnel(): Promise<TransitionEdge[]> {
  const supabase = createAdminClient()

  const { data, error } = await supabase
    .from('v_status_transition')
    .select('from_status, to_status')

  if (error) throw new Error(error.message)

  // Aggregate by from+to pair
  const counts = new Map<string, { fromStatus: string; toStatus: string; count: number }>()
  for (const row of data ?? []) {
    if (row.from_status == null) continue  // skip synthetic origin rows
    const key = `${row.from_status}→${row.to_status}`
    const existing = counts.get(key)
    if (existing) {
      existing.count += 1
    } else {
      counts.set(key, { fromStatus: row.from_status as string, toStatus: row.to_status as string, count: 1 })
    }
  }

  // Sort by count desc
  return Array.from(counts.values()).sort((a, b) => b.count - a.count)
}

/**
 * Per-engineer change activity over the given range.
 * Queries audit_log joined with app_user, aggregated in TypeScript.
 */
export async function getEngineerActivity(range: AnalyticsRange): Promise<EngineerActivity[]> {
  const supabase = createAdminClient()
  const since = rangeToDate(range)

  const { data, error } = await supabase
    .from('audit_log')
    .select('actor_id, row_id, app_user!audit_log_actor_id_fkey(email)')
    .eq('table_name', 'device')
    .gte('occurred_at', since)

  if (error) throw new Error(error.message)

  // Aggregate by actor_id
  const actorMap = new Map<string, { email: string; changeCount: number; deviceIds: Set<string> }>()
  for (const row of data ?? []) {
    const actorId = row.actor_id as string
    if (!actorId) continue
    const userRecord = Array.isArray(row.app_user) ? row.app_user[0] : row.app_user
    const email = (userRecord as { email?: string } | null)?.email ?? 'unknown'
    const existing = actorMap.get(actorId)
    if (existing) {
      existing.changeCount += 1
      existing.deviceIds.add(row.row_id as string)
    } else {
      actorMap.set(actorId, { email, changeCount: 1, deviceIds: new Set([row.row_id as string]) })
    }
  }

  return Array.from(actorMap.entries())
    .map(([actorId, v]) => ({
      actorId,
      actorEmail: v.email,
      changeCount: v.changeCount,
      distinctDevices: v.deviceIds.size,
    }))
    .sort((a, b) => b.changeCount - a.changeCount)
}

const TERMINAL_STATUSES = new Set(['retired', 'lost'])

/**
 * Devices where the given user was the last actor and status is non-terminal.
 */
export async function getMyQueue(userId: string): Promise<MyQueueItem[]> {
  const supabase = createAdminClient()

  // Step 1: Get device IDs this user has recently touched
  const { data: auditData, error: auditError } = await supabase
    .from('audit_log')
    .select('row_id, occurred_at')
    .eq('table_name', 'device')
    .eq('actor_id', userId)
    .order('occurred_at', { ascending: false })
    .limit(500)

  if (auditError) throw new Error(auditError.message)
  if (!auditData || auditData.length === 0) return []

  // Dedup: first occurrence per device = most recent action by this user
  const seen = new Set<string>()
  const candidateIds: string[] = []
  for (const row of auditData) {
    if (!seen.has(row.row_id)) {
      seen.add(row.row_id)
      candidateIds.push(row.row_id)
    }
  }

  // Step 2: Verify this user is still the last actor on each candidate device
  // Fetch recent audit entries for candidate devices and find most recent actor per device
  const { data: verifyData, error: verifyError } = await supabase
    .from('audit_log')
    .select('row_id, actor_id, occurred_at')
    .eq('table_name', 'device')
    .in('row_id', candidateIds)
    .order('occurred_at', { ascending: false })
    .limit(candidateIds.length * 10)  // over-fetch to cover each device's recent history

  if (verifyError) throw new Error(verifyError.message)

  // Keep only devices where the most recent audit entry is by this user
  const lastActorMap = new Map<string, string>()
  for (const row of verifyData ?? []) {
    if (!lastActorMap.has(row.row_id)) {
      lastActorMap.set(row.row_id, row.actor_id)
    }
  }
  const confirmedIds = candidateIds.filter(id => lastActorMap.get(id) === userId)
  if (confirmedIds.length === 0) return []

  // Step 3: Fetch device details for confirmed IDs
  // Use limit(100) then JS-slice to 50 after filtering terminal statuses,
  // so the DB limit does not cut off non-terminal candidates.
  const { data: devices, error: deviceError } = await supabase
    .from('device')
    .select('id, serial_no, model, status, updated_at')
    .in('id', confirmedIds)
    .is('deleted_at', null)
    .order('updated_at', { ascending: true })
    .limit(100)  // over-fetch; JS-limit to 50 after filtering terminal statuses

  if (deviceError) throw new Error(deviceError.message)
  if (!devices) return []

  return devices
    .filter(d => !TERMINAL_STATUSES.has((d.status ?? '').toLowerCase()))
    .slice(0, 50)
    .map(d => ({
      deviceId: d.id,
      serialNo: d.serial_no,
      model: d.model,
      status: d.status,
      updatedAt: d.updated_at ?? new Date().toISOString(),
      stalenessHours: (Date.now() - new Date(d.updated_at ?? Date.now()).getTime()) / 3600000,
    }))
}
