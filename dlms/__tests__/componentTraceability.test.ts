import {
  TRACEABILITY_DIMENSIONS,
  isTraceableField,
  groupDevicesByDimension,
} from '@/lib/domain/componentTraceability'
import type { DeviceRow } from '@/lib/types'

// ── helpers ──────────────────────────────────────────────────────────────────

function makeRow(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    id: `d-${Math.random()}`,
    device_sn: null,
    product_name: null,
    model_no: null,
    pcba_a_sn: 'SN001',
    pcba_a_sn_normalized: 'SN001',
    pcba_a_hw_rev: '1.0',
    pcba_a_bom_rev: 'A',
    pcba_a_fw_ver: '1.0.0',
    pcba_b_sn: null,
    pcba_b_sn_normalized: null,
    pcba_b_hw_rev: null,
    pcba_b_bom_rev: null,
    pcba_b_fw_ver: null,
    screen_model: null,
    hmi_ver: null,
    build_date: null,
    ship_date: null,
    warranty_expiry: null,
    qty: 1,
    destination: null,
    customer: null,
    status: 'in_production',
    phase: 'assembly',
    remarks: null,
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    deleted_at: null,
    created_by: null,
    updated_by: null,
    version: 1,
    device_sn_normalized: null,
    replaced_by: null,
    ...overrides,
  } as unknown as DeviceRow
}

// ── TRACEABILITY_DIMENSIONS ───────────────────────────────────────────────────

describe('TRACEABILITY_DIMENSIONS', () => {
  it('contains exactly 8 fields', () => {
    expect(TRACEABILITY_DIMENSIONS).toHaveLength(8)
  })

  it('includes all 3 PCBA-A rev/ver fields', () => {
    const fields = TRACEABILITY_DIMENSIONS.map((d) => d.field)
    expect(fields).toContain('pcba_a_hw_rev')
    expect(fields).toContain('pcba_a_bom_rev')
    expect(fields).toContain('pcba_a_fw_ver')
  })

  it('includes all 3 PCBA-B rev/ver fields', () => {
    const fields = TRACEABILITY_DIMENSIONS.map((d) => d.field)
    expect(fields).toContain('pcba_b_hw_rev')
    expect(fields).toContain('pcba_b_bom_rev')
    expect(fields).toContain('pcba_b_fw_ver')
  })

  it('includes HMI fields', () => {
    const fields = TRACEABILITY_DIMENSIONS.map((d) => d.field)
    expect(fields).toContain('screen_model')
    expect(fields).toContain('hmi_ver')
  })

  it('excludes serial-number fields (fields ending in _sn)', () => {
    const fields = TRACEABILITY_DIMENSIONS.map((d) => d.field)
    for (const f of fields) {
      expect(f.endsWith('_sn')).toBe(false)
    }
  })

  it('each dimension has a non-empty labelEn and labelZh', () => {
    for (const d of TRACEABILITY_DIMENSIONS) {
      expect(typeof d.labelEn).toBe('string')
      expect(d.labelEn.length).toBeGreaterThan(0)
      expect(typeof d.labelZh).toBe('string')
      expect(d.labelZh.length).toBeGreaterThan(0)
    }
  })

  it('each dimension has a groupKey of pcba_a, pcba_b, or hmi', () => {
    const validGroups = new Set(['pcba_a', 'pcba_b', 'hmi'])
    for (const d of TRACEABILITY_DIMENSIONS) {
      expect(validGroups.has(d.groupKey)).toBe(true)
    }
  })
})

// ── isTraceableField ──────────────────────────────────────────────────────────

describe('isTraceableField', () => {
  it('returns true for pcba_a_hw_rev', () => {
    expect(isTraceableField('pcba_a_hw_rev')).toBe(true)
  })

  it('returns true for pcba_a_bom_rev', () => {
    expect(isTraceableField('pcba_a_bom_rev')).toBe(true)
  })

  it('returns true for pcba_a_fw_ver', () => {
    expect(isTraceableField('pcba_a_fw_ver')).toBe(true)
  })

  it('returns true for pcba_b_hw_rev', () => {
    expect(isTraceableField('pcba_b_hw_rev')).toBe(true)
  })

  it('returns true for screen_model', () => {
    expect(isTraceableField('screen_model')).toBe(true)
  })

  it('returns true for hmi_ver', () => {
    expect(isTraceableField('hmi_ver')).toBe(true)
  })

  it('returns false for serial number field pcba_a_sn', () => {
    expect(isTraceableField('pcba_a_sn')).toBe(false)
  })

  it('returns false for pcba_b_sn', () => {
    expect(isTraceableField('pcba_b_sn')).toBe(false)
  })

  it('returns false for an unknown field', () => {
    expect(isTraceableField('nonexistent_column')).toBe(false)
  })

  it('returns false for empty string', () => {
    expect(isTraceableField('')).toBe(false)
  })

  it('returns false for device_sn (not a component rev field)', () => {
    expect(isTraceableField('device_sn')).toBe(false)
  })
})

// ── groupDevicesByDimension ───────────────────────────────────────────────────

describe('groupDevicesByDimension — basic grouping', () => {
  it('returns empty array for empty input', () => {
    expect(groupDevicesByDimension([], 'pcba_a_hw_rev')).toEqual([])
  })

  it('groups rows by the specified field', () => {
    const rows = [
      makeRow({ pcba_a_hw_rev: '2.0' }),
      makeRow({ pcba_a_hw_rev: '1.0' }),
      makeRow({ pcba_a_hw_rev: '2.0' }),
    ]
    const result = groupDevicesByDimension(rows, 'pcba_a_hw_rev')
    const byValue = Object.fromEntries(result.map((g) => [g.value, g]))
    expect(byValue['2.0'].deviceCount).toBe(2)
    expect(byValue['1.0'].deviceCount).toBe(1)
  })

  it('sets unitCount as sum of qty', () => {
    const rows = [
      makeRow({ pcba_a_hw_rev: '2.0', qty: 3 }),
      makeRow({ pcba_a_hw_rev: '2.0', qty: 5 }),
    ]
    const result = groupDevicesByDimension(rows, 'pcba_a_hw_rev')
    expect(result[0].unitCount).toBe(8)
  })

  it('treats null qty as 1 when computing unitCount', () => {
    const rows = [
      makeRow({ pcba_a_hw_rev: '1.0', qty: null }),
      makeRow({ pcba_a_hw_rev: '1.0', qty: 2 }),
    ]
    const result = groupDevicesByDimension(rows, 'pcba_a_hw_rev')
    expect(result[0].unitCount).toBe(3)
  })
})

describe('groupDevicesByDimension — null/empty bucketing', () => {
  it('treats null value as a single (unspecified) bucket with value null', () => {
    const rows = [
      makeRow({ pcba_b_hw_rev: null }),
      makeRow({ pcba_b_hw_rev: null }),
    ]
    const result = groupDevicesByDimension(rows, 'pcba_b_hw_rev')
    expect(result).toHaveLength(1)
    expect(result[0].value).toBeNull()
    expect(result[0].deviceCount).toBe(2)
  })

  it('treats empty-string value as the null bucket', () => {
    const rows = [
      makeRow({ pcba_b_hw_rev: '' as any }),
      makeRow({ pcba_b_hw_rev: null }),
    ]
    const result = groupDevicesByDimension(rows, 'pcba_b_hw_rev')
    expect(result).toHaveLength(1)
    expect(result[0].value).toBeNull()
    expect(result[0].deviceCount).toBe(2)
  })

  it('treats whitespace-only string as the null bucket', () => {
    const rows = [makeRow({ pcba_b_hw_rev: '   ' as any })]
    const result = groupDevicesByDimension(rows, 'pcba_b_hw_rev')
    expect(result[0].value).toBeNull()
  })

  it('mixes null and empty into one bucket while keeping non-null separate', () => {
    const rows = [
      makeRow({ screen_model: null }),
      makeRow({ screen_model: '7in-LCD' }),
      makeRow({ screen_model: '' as any }),
    ]
    const result = groupDevicesByDimension(rows, 'screen_model')
    const byValue = Object.fromEntries(result.map((g) => [String(g.value), g]))
    expect(byValue['null'].deviceCount).toBe(2)
    expect(byValue['7in-LCD'].deviceCount).toBe(1)
  })
})

describe('groupDevicesByDimension — sort order', () => {
  it('sorts by deviceCount desc', () => {
    const rows = [
      makeRow({ pcba_a_hw_rev: '1.0' }),
      makeRow({ pcba_a_hw_rev: '2.0' }),
      makeRow({ pcba_a_hw_rev: '2.0' }),
      makeRow({ pcba_a_hw_rev: '2.0' }),
    ]
    const result = groupDevicesByDimension(rows, 'pcba_a_hw_rev')
    expect(result[0].value).toBe('2.0')
    expect(result[1].value).toBe('1.0')
  })

  it('sorts alphabetically asc when deviceCounts are equal', () => {
    const rows = [
      makeRow({ pcba_a_fw_ver: 'C' }),
      makeRow({ pcba_a_fw_ver: 'A' }),
      makeRow({ pcba_a_fw_ver: 'B' }),
    ]
    const result = groupDevicesByDimension(rows, 'pcba_a_fw_ver')
    expect(result.map((g) => g.value)).toEqual(['A', 'B', 'C'])
  })

  it('places the null bucket after named values with the same count', () => {
    const rows = [
      makeRow({ pcba_b_fw_ver: null }),
      makeRow({ pcba_b_fw_ver: 'Z' }),
    ]
    const result = groupDevicesByDimension(rows, 'pcba_b_fw_ver')
    // Both have deviceCount=1 → alphabetical, null last
    expect(result[0].value).toBe('Z')
    expect(result[1].value).toBeNull()
  })

  it('places the null bucket after higher-count named values', () => {
    const rows = [
      makeRow({ pcba_b_fw_ver: null }),
      makeRow({ pcba_b_fw_ver: null }),
      makeRow({ pcba_b_fw_ver: '1.0' }),
      makeRow({ pcba_b_fw_ver: '1.0' }),
      makeRow({ pcba_b_fw_ver: '1.0' }),
    ]
    const result = groupDevicesByDimension(rows, 'pcba_b_fw_ver')
    // '1.0' has 3, null has 2 → '1.0' first
    expect(result[0].value).toBe('1.0')
    expect(result[1].value).toBeNull()
  })
})

describe('groupDevicesByDimension — single-row edge cases', () => {
  it('returns one group for a single row', () => {
    const rows = [makeRow({ pcba_a_hw_rev: '3.0' })]
    const result = groupDevicesByDimension(rows, 'pcba_a_hw_rev')
    expect(result).toHaveLength(1)
    expect(result[0].value).toBe('3.0')
    expect(result[0].deviceCount).toBe(1)
    expect(result[0].unitCount).toBe(1)
  })

  it('works for hmi_ver field', () => {
    const rows = [
      makeRow({ hmi_ver: 'v2' }),
      makeRow({ hmi_ver: 'v2' }),
      makeRow({ hmi_ver: 'v1' }),
    ]
    const result = groupDevicesByDimension(rows, 'hmi_ver')
    expect(result[0].value).toBe('v2')
    expect(result[0].deviceCount).toBe(2)
  })
})
