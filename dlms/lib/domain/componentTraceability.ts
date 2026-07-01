/**
 * Component traceability helpers — pure, no I/O.
 *
 * Answers "which devices carry HW Rev X / firmware Y / BOM rev Z?"
 * by grouping a flat list of DeviceRows by a component-revision field.
 *
 * TRACEABILITY_DIMENSIONS is the single source of truth for the 8 traceable
 * fields (derived from GROUP_LABELS so it automatically tracks schema changes).
 * Serials (fields ending in _sn) are excluded — they are per-unit identifiers,
 * not revision dimensions useful for fleet-wide rollup.
 */

import { GROUP_LABELS, FIELD_LABELS } from '@/lib/i18n/fields'
import type { DeviceRow } from '@/lib/types'

// ── Traceable dimensions ──────────────────────────────────────────────────────

export const TRACEABILITY_GROUP_KEYS = ['pcba_a', 'pcba_b', 'hmi'] as const

export type TraceabilityDimension = {
  field: string
  labelEn: string
  labelZh: string
  groupKey: string
}

/**
 * All fleet-traceable component-revision fields, derived from GROUP_LABELS.
 * Excludes serial-number fields (ending in `_sn`).
 */
export const TRACEABILITY_DIMENSIONS: TraceabilityDimension[] = GROUP_LABELS
  .filter((g) => (TRACEABILITY_GROUP_KEYS as readonly string[]).includes(g.key))
  .flatMap((g) =>
    g.fields
      .filter((f) => !f.endsWith('_sn'))
      .map((f) => ({
        field: f,
        labelEn: FIELD_LABELS[f]?.en ?? f,
        labelZh: FIELD_LABELS[f]?.zh ?? f,
        groupKey: g.key,
      }))
  )

const TRACEABLE_FIELD_SET = new Set(TRACEABILITY_DIMENSIONS.map((d) => d.field))

/** Returns true only for the 8 component-revision fields that are traceability dimensions. */
export function isTraceableField(field: string): boolean {
  return TRACEABLE_FIELD_SET.has(field)
}

// ── Grouping ──────────────────────────────────────────────────────────────────

export type TraceabilityGroup = {
  /** Revision value, or null for the "(unspecified)" bucket. */
  value: string | null
  deviceCount: number
  unitCount: number
}

/**
 * Group a flat list of DeviceRows by one component-revision field.
 *
 * - null, empty-string, and whitespace-only values are collapsed into a single
 *   `value: null` "(unspecified)" bucket.
 * - `unitCount` sums the `qty` column (defaulting to 1 when qty is null).
 * - Result is sorted: deviceCount desc, then value asc (nulls last).
 *
 * Pure (no I/O) so fully deterministic under test.
 */
export function groupDevicesByDimension(
  rows: DeviceRow[],
  field: string,
): TraceabilityGroup[] {
  const map = new Map<string | null, TraceabilityGroup>()

  for (const row of rows) {
    const raw = (row as Record<string, unknown>)[field]
    const rawStr = raw === null || raw === undefined ? null : String(raw)
    const key: string | null =
      rawStr === null || rawStr.trim() === '' ? null : rawStr

    let group = map.get(key)
    if (!group) {
      group = { value: key, deviceCount: 0, unitCount: 0 }
      map.set(key, group)
    }
    group.deviceCount += 1
    group.unitCount += row.qty ?? 1
  }

  return Array.from(map.values()).sort((a, b) => {
    // Primary: deviceCount desc
    if (b.deviceCount !== a.deviceCount) return b.deviceCount - a.deviceCount
    // Secondary: value asc, nulls last
    if (a.value === null && b.value === null) return 0
    if (a.value === null) return 1
    if (b.value === null) return -1
    return a.value.localeCompare(b.value)
  })
}
