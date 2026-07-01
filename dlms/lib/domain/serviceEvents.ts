/**
 * Service events domain helpers — pure, no I/O.
 *
 * Provides date-grouping and label formatting for the Service Events tab.
 */

import { format, parseISO, subDays } from 'date-fns'
import type { ServiceEvent } from '@/lib/types'

// ── Types ─────────────────────────────────────────────────────────────────────

export type ServiceEventWithActor = ServiceEvent & { actor_email: string | null }

export type ServiceEventGroup = {
  date: string   // ISO "YYYY-MM-DD"
  label: string  // "Today", "Yesterday", or formatted date e.g. "Jun 28, 2026"
  events: ServiceEventWithActor[]
}

// ── Label helpers ─────────────────────────────────────────────────────────────

function labelForDate(dateStr: string, todayKey: string, yesterdayKey: string): string {
  if (dateStr === todayKey) return 'Today'
  if (dateStr === yesterdayKey) return 'Yesterday'
  return format(parseISO(dateStr), 'MMM d, yyyy')
}

// ── groupServiceEventsByDate ──────────────────────────────────────────────────

/**
 * Group service events by `occurred_on` date (ISO "YYYY-MM-DD"), most-recent
 * date first. Within each group, events are sorted by `created_at` descending.
 *
 * @param today - Injected for deterministic testing; defaults to `new Date()`.
 */
export function groupServiceEventsByDate(
  events: ServiceEventWithActor[],
  today: Date = new Date()
): ServiceEventGroup[] {
  if (events.length === 0) return []

  const todayKey = format(today, 'yyyy-MM-dd')
  const yesterdayKey = format(subDays(today, 1), 'yyyy-MM-dd')

  // Build map: date → events (preserve insertion order for now)
  const groupMap = new Map<string, ServiceEventWithActor[]>()
  for (const event of events) {
    const date = event.occurred_on
    if (!groupMap.has(date)) groupMap.set(date, [])
    groupMap.get(date)!.push(event)
  }

  // Sort dates descending (most-recent first)
  const sortedDates = [...groupMap.keys()].sort((a, b) => b.localeCompare(a))

  return sortedDates.map((date) => {
    const groupEvents = groupMap.get(date)!
    // Sort events within group by created_at descending
    groupEvents.sort((a, b) => b.created_at.localeCompare(a.created_at))

    return {
      date,
      label: labelForDate(date, todayKey, yesterdayKey),
      events: groupEvents,
    }
  })
}

// ── formatOccurredOn ──────────────────────────────────────────────────────────

/**
 * Format a "YYYY-MM-DD" date string for display (e.g. in the add-event form).
 * Returns "Today", "Yesterday", or a formatted date like "Jun 28, 2026".
 *
 * @param today - Injected for deterministic testing; defaults to `new Date()`.
 */
export function formatOccurredOn(dateStr: string, today: Date = new Date()): string {
  const todayKey = format(today, 'yyyy-MM-dd')
  const yesterdayKey = format(subDays(today, 1), 'yyyy-MM-dd')
  return labelForDate(dateStr, todayKey, yesterdayKey)
}
