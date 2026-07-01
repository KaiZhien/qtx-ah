/**
 * History view helpers — pure, no I/O.
 *
 * Provides filtering, date-grouping, and version extraction for the Change
 * History tab. Single source of truth for group options: GROUP_LABELS.
 */

import { GROUP_LABELS } from '@/lib/i18n/fields'
import type { AuditEntry } from '@/lib/types'

// ── Group options (for the Section filter dropdown) ───────────────────────────

export type HistoryGroupOption = { key: string; labelEn: string }

export const HISTORY_GROUP_OPTIONS: HistoryGroupOption[] = GROUP_LABELS.map((g) => ({
  key: g.key,
  labelEn: g.en,
}))

// Reverse map: field name → group key. Built once.
const FIELD_TO_GROUP: Map<string, string> = new Map(
  GROUP_LABELS.flatMap((g) => g.fields.map((f) => [f, g.key]))
)

export function groupKeyOfField(field: string): string | null {
  return FIELD_TO_GROUP.get(field) ?? null
}

// ── Version extraction ────────────────────────────────────────────────────────

export function deviceVersionOf(entry: AuditEntry): number | null {
  const raw = entry.new_values?.['version']
  if (raw === null || raw === undefined) return null
  const n = Number(raw)
  return Number.isFinite(n) ? n : null
}

// ── Filtering ─────────────────────────────────────────────────────────────────

export type HistoryFilter = {
  action?: string   // 'insert' | 'update' | 'soft_delete'
  group?: string    // group key from HISTORY_GROUP_OPTIONS
}

export function filterHistoryEntries(entries: AuditEntry[], filter: HistoryFilter): AuditEntry[] {
  return entries.filter((entry) => {
    // Action filter
    if (filter.action && entry.action !== filter.action) return false

    // Group filter — insert/soft_delete are whole-record events; always pass
    if (filter.group) {
      const isWholeRecord = entry.action === 'insert' || entry.action === 'soft_delete'
      if (!isWholeRecord) {
        const hasGroupField = entry.changed_columns.some(
          (col) => groupKeyOfField(col) === filter.group
        )
        if (!hasGroupField) return false
      }
    }

    return true
  })
}

// ── Date grouping ─────────────────────────────────────────────────────────────

export type DateGroup = { dateKey: string; entries: AuditEntry[] }

/** Group entries by calendar date (YYYY-MM-DD), preserving newest-first order. */
export function groupEntriesByDate(entries: AuditEntry[]): DateGroup[] {
  const groups: DateGroup[] = []
  const seen = new Map<string, DateGroup>()

  for (const entry of entries) {
    const dateKey = entry.occurred_at.slice(0, 10) // 'YYYY-MM-DD'
    let group = seen.get(dateKey)
    if (!group) {
      group = { dateKey, entries: [] }
      groups.push(group)
      seen.set(dateKey, group)
    }
    group.entries.push(entry)
  }

  return groups
}
