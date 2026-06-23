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

  let totalSeconds = 0
  let remaining = interval.trim()

  // Extract days component: "N day(s)"
  const dayMatch = remaining.match(/(\d+)\s+days?/)
  if (dayMatch) {
    totalSeconds += parseInt(dayMatch[1], 10) * 86400
    remaining = remaining.replace(dayMatch[0], '').trim()
  }

  // Extract HH:MM:SS component
  const timeMatch = remaining.match(/(\d+):(\d+):(\d+(?:\.\d+)?)/)
  if (timeMatch) {
    totalSeconds += parseInt(timeMatch[1], 10) * 3600
    totalSeconds += parseInt(timeMatch[2], 10) * 60
    totalSeconds += parseFloat(timeMatch[3])
  }

  return totalSeconds
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
        label_en: row.label_en ?? key,
        label_zh: row.label_zh ?? key,
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
    const email = (userRecord as { email?: string } | null)?.email ?? actorId
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

const TERMINAL_STATUSES = new Set(['shipped', 'completed', 'closed'])

/**
 * Devices where the given user was the last actor and status is non-terminal.
 */
export async function getMyQueue(userId: string): Promise<MyQueueItem[]> {
  const supabase = createAdminClient()

  // Get all audit log entries for this user on device table, most recent first
  const { data: auditRows, error: auditError } = await supabase
    .from('audit_log')
    .select('row_id, occurred_at')
    .eq('table_name', 'device')
    .eq('actor_id', userId)
    .order('occurred_at', { ascending: false })

  if (auditError) throw new Error(auditError.message)

  // Keep only the distinct device IDs where this user was the last actor.
  // Since we need to verify this user is THE last actor (not just any actor),
  // we collect candidate device IDs first, then filter below.
  const candidateDeviceIds = new Set<string>()
  for (const row of auditRows ?? []) {
    if (row.row_id) candidateDeviceIds.add(row.row_id as string)
  }

  if (candidateDeviceIds.size === 0) return []

  // Fetch the last audit entry per device to confirm this user was the last actor
  const { data: lastActorRows, error: lastActorError } = await supabase
    .from('audit_log')
    .select('row_id, actor_id, occurred_at')
    .eq('table_name', 'device')
    .in('row_id', Array.from(candidateDeviceIds))
    .order('occurred_at', { ascending: false })

  if (lastActorError) throw new Error(lastActorError.message)

  // Deduplicate: keep first (most recent) occurrence per row_id
  const lastActorByDevice = new Map<string, string>()
  for (const row of lastActorRows ?? []) {
    const rowId = row.row_id as string
    if (!lastActorByDevice.has(rowId)) {
      lastActorByDevice.set(rowId, row.actor_id as string)
    }
  }

  // Filter to devices where this user is the last actor
  const myDeviceIds = Array.from(lastActorByDevice.entries())
    .filter(([, actorId]) => actorId === userId)
    .map(([rowId]) => rowId)

  if (myDeviceIds.length === 0) return []

  // Fetch those devices, filtering out deleted and terminal statuses
  const { data: devices, error: deviceError } = await supabase
    .from('device')
    .select('id, pcba_a_sn, status, phase, updated_at')
    .in('id', myDeviceIds)
    .is('deleted_at', null)

  if (deviceError) throw new Error(deviceError.message)

  const now = Date.now()
  const results: MyQueueItem[] = (devices ?? [])
    .filter((d) => !TERMINAL_STATUSES.has((d.status as string).toLowerCase()))
    .map((d) => ({
      deviceId: d.id as string,
      pcbaASn: d.pcba_a_sn as string,
      status: d.status as string,
      phase: d.phase as string,
      updatedAt: d.updated_at as string,
      staleDays: Math.floor((now - new Date(d.updated_at as string).getTime()) / 86400000),
    }))
    .sort((a, b) => b.staleDays - a.staleDays)

  return results
}
