import {
  HISTORY_GROUP_OPTIONS,
  groupKeyOfField,
  deviceVersionOf,
  filterHistoryEntries,
  groupEntriesByDate,
} from '@/lib/domain/historyView'
import type { AuditEntry } from '@/lib/types'

function makeEntry(overrides: Partial<AuditEntry> & Pick<AuditEntry, 'action'>): AuditEntry {
  return {
    id: `e-${Math.random()}`,
    actor_id: 'u-1',
    actor_email: 'eng@quantumtx.com',
    table_name: 'device',
    row_id: 'dev-1',
    old_values: null,
    new_values: { version: 2 },
    changed_columns: [],
    request_id: null,
    occurred_at: '2025-06-01T10:00:00Z',
    ...overrides,
  }
}

// ── HISTORY_GROUP_OPTIONS ─────────────────────────────────────────────────────

describe('HISTORY_GROUP_OPTIONS', () => {
  it('contains an entry for each GROUP_LABELS group key', () => {
    const keys = HISTORY_GROUP_OPTIONS.map((o) => o.key)
    expect(keys).toEqual(['device_info', 'pcba_a', 'pcba_b', 'hmi', 'shipment', 'status_notes'])
  })

  it('each option has a non-empty labelEn', () => {
    HISTORY_GROUP_OPTIONS.forEach((o) => {
      expect(typeof o.labelEn).toBe('string')
      expect(o.labelEn.length).toBeGreaterThan(0)
    })
  })
})

// ── groupKeyOfField ───────────────────────────────────────────────────────────

describe('groupKeyOfField', () => {
  it('maps a pcba_a field to pcba_a', () => {
    expect(groupKeyOfField('pcba_a_fw_ver')).toBe('pcba_a')
  })

  it('maps a pcba_b field to pcba_b', () => {
    expect(groupKeyOfField('pcba_b_sn')).toBe('pcba_b')
  })

  it('maps hmi fields to hmi', () => {
    expect(groupKeyOfField('screen_model')).toBe('hmi')
    expect(groupKeyOfField('hmi_ver')).toBe('hmi')
  })

  it('maps status to status_notes', () => {
    expect(groupKeyOfField('status')).toBe('status_notes')
  })

  it('maps remarks to status_notes', () => {
    expect(groupKeyOfField('remarks')).toBe('status_notes')
  })

  it('maps device_sn to device_info', () => {
    expect(groupKeyOfField('device_sn')).toBe('device_info')
  })

  it('maps ship_date to shipment', () => {
    expect(groupKeyOfField('ship_date')).toBe('shipment')
  })

  it('returns null for an unknown field', () => {
    expect(groupKeyOfField('nonexistent_column')).toBeNull()
  })

  it('returns null for empty string', () => {
    expect(groupKeyOfField('')).toBeNull()
  })
})

// ── deviceVersionOf ───────────────────────────────────────────────────────────

describe('deviceVersionOf', () => {
  it('returns the numeric version from new_values', () => {
    const entry = makeEntry({ action: 'update', new_values: { version: 5 } })
    expect(deviceVersionOf(entry)).toBe(5)
  })

  it('returns null when version is absent from new_values', () => {
    const entry = makeEntry({ action: 'update', new_values: {} })
    expect(deviceVersionOf(entry)).toBeNull()
  })

  it('returns null when new_values.version is a non-numeric string', () => {
    const entry = makeEntry({ action: 'update', new_values: { version: 'bad' } })
    expect(deviceVersionOf(entry)).toBeNull()
  })

  it('returns null when new_values.version is null', () => {
    const entry = makeEntry({ action: 'update', new_values: { version: null } })
    expect(deviceVersionOf(entry)).toBeNull()
  })

  it('coerces a numeric string to a number', () => {
    const entry = makeEntry({ action: 'update', new_values: { version: '3' } })
    expect(deviceVersionOf(entry)).toBe(3)
  })
})

// ── filterHistoryEntries ──────────────────────────────────────────────────────

describe('filterHistoryEntries — no filter', () => {
  it('returns all entries when no filter is provided', () => {
    const entries = [makeEntry({ action: 'insert' }), makeEntry({ action: 'update' })]
    expect(filterHistoryEntries(entries, {})).toHaveLength(2)
  })

  it('returns empty array for empty input', () => {
    expect(filterHistoryEntries([], {})).toEqual([])
  })
})

describe('filterHistoryEntries — action filter', () => {
  it('keeps only insert entries when action=insert', () => {
    const entries = [
      makeEntry({ action: 'insert' }),
      makeEntry({ action: 'update' }),
      makeEntry({ action: 'soft_delete' }),
    ]
    const result = filterHistoryEntries(entries, { action: 'insert' })
    expect(result).toHaveLength(1)
    expect(result[0].action).toBe('insert')
  })

  it('keeps only update entries when action=update', () => {
    const entries = [makeEntry({ action: 'insert' }), makeEntry({ action: 'update' })]
    const result = filterHistoryEntries(entries, { action: 'update' })
    expect(result).toHaveLength(1)
    expect(result[0].action).toBe('update')
  })
})

describe('filterHistoryEntries — group filter', () => {
  it('keeps update entry when a changed field belongs to the filter group', () => {
    const entry = makeEntry({ action: 'update', changed_columns: ['pcba_a_fw_ver'] })
    const result = filterHistoryEntries([entry], { group: 'pcba_a' })
    expect(result).toHaveLength(1)
  })

  it('drops update entry when no changed fields belong to the filter group', () => {
    const entry = makeEntry({ action: 'update', changed_columns: ['status'] })
    const result = filterHistoryEntries([entry], { group: 'pcba_a' })
    expect(result).toHaveLength(0)
  })

  it('always passes insert entries through the group filter', () => {
    const entry = makeEntry({ action: 'insert', changed_columns: [] })
    const result = filterHistoryEntries([entry], { group: 'pcba_a' })
    expect(result).toHaveLength(1)
  })

  it('always passes soft_delete entries through the group filter', () => {
    const entry = makeEntry({ action: 'soft_delete', changed_columns: ['deleted_at'] })
    const result = filterHistoryEntries([entry], { group: 'pcba_b' })
    expect(result).toHaveLength(1)
  })
})

describe('filterHistoryEntries — combined action + group filters', () => {
  it('applies both filters: keeps update entry with matching group', () => {
    const entries = [
      makeEntry({ action: 'update', changed_columns: ['pcba_a_fw_ver'] }),
      makeEntry({ action: 'update', changed_columns: ['status'] }),
      makeEntry({ action: 'insert', changed_columns: [] }),
    ]
    const result = filterHistoryEntries(entries, { action: 'update', group: 'pcba_a' })
    expect(result).toHaveLength(1)
    expect(result[0].changed_columns).toContain('pcba_a_fw_ver')
  })
})

// ── groupEntriesByDate ────────────────────────────────────────────────────────

describe('groupEntriesByDate', () => {
  it('returns empty array for empty input', () => {
    expect(groupEntriesByDate([])).toEqual([])
  })

  it('groups two entries on the same date into one group', () => {
    const entries = [
      makeEntry({ action: 'update', occurred_at: '2025-06-01T10:00:00Z' }),
      makeEntry({ action: 'insert', occurred_at: '2025-06-01T08:00:00Z' }),
    ]
    const result = groupEntriesByDate(entries)
    expect(result).toHaveLength(1)
    expect(result[0].dateKey).toBe('2025-06-01')
    expect(result[0].entries).toHaveLength(2)
  })

  it('produces separate groups for entries on different dates', () => {
    const entries = [
      makeEntry({ action: 'update', occurred_at: '2025-06-03T10:00:00Z' }),
      makeEntry({ action: 'update', occurred_at: '2025-06-01T10:00:00Z' }),
    ]
    const result = groupEntriesByDate(entries)
    expect(result).toHaveLength(2)
    expect(result[0].dateKey).toBe('2025-06-03')
    expect(result[1].dateKey).toBe('2025-06-01')
  })

  it('preserves newest-first ordering of groups (newest date first)', () => {
    const entries = [
      makeEntry({ action: 'update', occurred_at: '2025-06-03T10:00:00Z' }),
      makeEntry({ action: 'update', occurred_at: '2025-06-02T10:00:00Z' }),
      makeEntry({ action: 'update', occurred_at: '2025-06-01T10:00:00Z' }),
    ]
    const result = groupEntriesByDate(entries)
    expect(result.map((g) => g.dateKey)).toEqual(['2025-06-03', '2025-06-02', '2025-06-01'])
  })

  it('preserves the order of entries within a group (newest-first)', () => {
    const entries = [
      makeEntry({ action: 'update', occurred_at: '2025-06-01T15:00:00Z' }),
      makeEntry({ action: 'update', occurred_at: '2025-06-01T08:00:00Z' }),
    ]
    const result = groupEntriesByDate(entries)
    expect(result[0].entries[0].occurred_at).toBe('2025-06-01T15:00:00Z')
    expect(result[0].entries[1].occurred_at).toBe('2025-06-01T08:00:00Z')
  })

  it('handles a single entry', () => {
    const entry = makeEntry({ action: 'insert', occurred_at: '2025-01-15T00:00:00Z' })
    const result = groupEntriesByDate([entry])
    expect(result).toHaveLength(1)
    expect(result[0].dateKey).toBe('2025-01-15')
    expect(result[0].entries).toHaveLength(1)
  })
})
