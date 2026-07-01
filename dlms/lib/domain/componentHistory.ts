/**
 * Component history derivation — pure, no I/O.
 *
 * Reconstructs a per-device component timeline from audit_log entries already
 * fetched by getDeviceHistory(). Groups: PCBA-A, PCBA-B, HMI.
 * Single source of truth for which fields belong to each group: GROUP_LABELS.
 */

import { GROUP_LABELS, FIELD_LABELS } from '@/lib/i18n/fields'
import type { AuditEntry, DeviceRow } from '@/lib/types'

export const COMPONENT_GROUP_KEYS = ['pcba_a', 'pcba_b', 'hmi'] as const
export type ComponentGroupKey = (typeof COMPONENT_GROUP_KEYS)[number]

export type ComponentChange = {
  field: string
  label: string      // FIELD_LABELS[field].en
  oldValue: string
  newValue: string
}

export type ComponentEvent = {
  occurred_at: string
  actorEmail: string | null
  action: string     // 'insert' | 'update' | 'soft_delete'
  changes: ComponentChange[]
}

export type ComponentGroupTimeline = {
  groupKey: ComponentGroupKey
  groupLabelEn: string
  groupLabelZh: string
  currentValues: Record<string, unknown>   // keyed by field name
  events: ComponentEvent[]                 // newest-first
}

// Derived once from GROUP_LABELS — single source of truth
const COMPONENT_FIELDS: Record<ComponentGroupKey, string[]> = Object.fromEntries(
  COMPONENT_GROUP_KEYS.map((key) => {
    const group = GROUP_LABELS.find((g) => g.key === key)!
    return [key, group.fields]
  })
) as Record<ComponentGroupKey, string[]>

const COMPONENT_GROUP_META: Record<ComponentGroupKey, { en: string; zh: string }> = Object.fromEntries(
  COMPONENT_GROUP_KEYS.map((key) => {
    const group = GROUP_LABELS.find((g) => g.key === key)!
    return [key, { en: group.en, zh: group.zh }]
  })
) as Record<ComponentGroupKey, { en: string; zh: string }>

function toStr(val: unknown): string {
  if (val === null || val === undefined) return ''
  return String(val)
}

/**
 * Build a component-focused timeline per group from the full audit history.
 *
 * history — from getDeviceHistory(), newest-first.
 * device  — current device row (for currentValues display).
 */
export function buildComponentTimeline(
  history: AuditEntry[],
  device: DeviceRow,
): ComponentGroupTimeline[] {
  return COMPONENT_GROUP_KEYS.map((groupKey) => {
    const fields = COMPONENT_FIELDS[groupKey]
    const meta = COMPONENT_GROUP_META[groupKey]

    // Current values for the "today" header card
    const currentValues: Record<string, unknown> = {}
    for (const f of fields) {
      currentValues[f] = (device as Record<string, unknown>)[f] ?? null
    }

    // Build events (preserve newest-first order from history)
    const events: ComponentEvent[] = []

    for (const entry of history) {
      if (entry.action === 'insert') {
        // Insert: treat as initial install. Emit one event per group
        // whose fields have at least one non-null value in new_values.
        const changes: ComponentChange[] = []
        for (const f of fields) {
          const newVal = entry.new_values[f]
          if (newVal !== null && newVal !== undefined && newVal !== '') {
            changes.push({
              field: f,
              label: FIELD_LABELS[f]?.en ?? f,
              oldValue: '',
              newValue: toStr(newVal),
            })
          }
        }
        // Always emit the insert event (even if all fields null — changes=[] is fine)
        events.push({
          occurred_at: entry.occurred_at,
          actorEmail: entry.actor_email ?? null,
          action: 'insert',
          changes,
        })
      } else {
        // Update/soft_delete: only emit if at least one component field changed
        const relevantCols = entry.changed_columns.filter((c) => fields.includes(c))
        if (relevantCols.length === 0) continue

        const changes: ComponentChange[] = relevantCols.map((f) => ({
          field: f,
          label: FIELD_LABELS[f]?.en ?? f,
          oldValue: toStr(entry.old_values?.[f]),
          newValue: toStr(entry.new_values[f]),
        }))

        events.push({
          occurred_at: entry.occurred_at,
          actorEmail: entry.actor_email ?? null,
          action: entry.action,
          changes,
        })
      }
    }

    return {
      groupKey,
      groupLabelEn: meta.en,
      groupLabelZh: meta.zh,
      currentValues,
      events,
    }
  })
}
