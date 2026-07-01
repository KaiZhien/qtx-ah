import {
  buildComponentTimeline,
  COMPONENT_GROUP_KEYS,
  type ComponentGroupTimeline,
} from '@/lib/domain/componentHistory'
import type { AuditEntry, DeviceRow } from '@/lib/types'

// Minimal DeviceRow stub — only the component fields + required system fields
function makeDevice(overrides: Partial<DeviceRow> = {}): DeviceRow {
  return {
    id: 'dev-1',
    created_at: '2025-01-01T00:00:00Z',
    updated_at: '2025-01-01T00:00:00Z',
    created_by: 'user-1',
    updated_by: null,
    deleted_at: null,
    version: 1,
    device_sn: null,
    device_sn_normalized: null,
    product_name: null,
    model_no: null,
    pcba_a_sn: 'EE-A-001',
    pcba_a_sn_normalized: 'ee-a-001',
    pcba_a_hw_rev: 'HW1',
    pcba_a_bom_rev: 'BOM1',
    pcba_a_fw_ver: 'FW1.0',
    pcba_b_sn: 'EE-B-001',
    pcba_b_sn_normalized: 'ee-b-001',
    pcba_b_hw_rev: 'HW2',
    pcba_b_bom_rev: 'BOM2',
    pcba_b_fw_ver: 'FW2.0',
    screen_model: 'LCD-7',
    hmi_ver: 'v1.0',
    build_date: null,
    ship_date: null,
    qty: 1,
    destination: null,
    customer: null,
    status: 'in_stock',
    phase: 'production',
    remarks: null,
    warranty_expiry: null,
    replaced_by: null,
    next_service_date: null,
    ...overrides,
  } as DeviceRow
}

function makeAuditEntry(overrides: Partial<AuditEntry> & Pick<AuditEntry, 'action' | 'changed_columns' | 'new_values'>): AuditEntry {
  return {
    id: `entry-${Math.random()}`,
    actor_id: 'user-1',
    actor_email: 'eng@quantumtx.com',
    table_name: 'device',
    row_id: 'dev-1',
    old_values: null,
    request_id: null,
    occurred_at: '2025-06-01T10:00:00Z',
    ...overrides,
  }
}

// ── COMPONENT_GROUP_KEYS ──────────────────────────────────────────────────────

describe('COMPONENT_GROUP_KEYS', () => {
  it('contains exactly pcba_a, pcba_b, and hmi', () => {
    expect(COMPONENT_GROUP_KEYS).toEqual(['pcba_a', 'pcba_b', 'hmi'])
  })
})

// ── buildComponentTimeline — structure ───────────────────────────────────────

describe('buildComponentTimeline — structure', () => {
  it('returns one entry per component group', () => {
    const result = buildComponentTimeline([], makeDevice())
    expect(result).toHaveLength(3)
    expect(result.map((g) => g.groupKey)).toEqual(['pcba_a', 'pcba_b', 'hmi'])
  })

  it('populates currentValues from the device row for pcba_a', () => {
    const device = makeDevice({ pcba_a_sn: 'SN-A', pcba_a_hw_rev: 'HW3', pcba_a_bom_rev: 'B3', pcba_a_fw_ver: 'FW3' })
    const result = buildComponentTimeline([], device)
    const pcbaA = result.find((g) => g.groupKey === 'pcba_a')!
    expect(pcbaA.currentValues).toMatchObject({
      pcba_a_sn: 'SN-A',
      pcba_a_hw_rev: 'HW3',
      pcba_a_bom_rev: 'B3',
      pcba_a_fw_ver: 'FW3',
    })
  })

  it('populates currentValues from the device row for hmi', () => {
    const device = makeDevice({ screen_model: 'OLED-10', hmi_ver: 'v2.5' })
    const result = buildComponentTimeline([], device)
    const hmi = result.find((g) => g.groupKey === 'hmi')!
    expect(hmi.currentValues).toMatchObject({ screen_model: 'OLED-10', hmi_ver: 'v2.5' })
  })
})

// ── buildComponentTimeline — event filtering ─────────────────────────────────

describe('buildComponentTimeline — event filtering', () => {
  it('emits no events when history is empty', () => {
    const result = buildComponentTimeline([], makeDevice())
    result.forEach((g) => expect(g.events).toHaveLength(0))
  })

  it('emits no events for a change that only touches unrelated columns (status, remarks)', () => {
    const entry = makeAuditEntry({
      action: 'update',
      changed_columns: ['status', 'remarks'],
      old_values: { status: 'in_stock', remarks: null },
      new_values: { status: 'in_use', remarks: 'note' },
    })
    const result = buildComponentTimeline([entry], makeDevice())
    result.forEach((g) => expect(g.events).toHaveLength(0))
  })

  it('emits one event in pcba_a only when pcba_a_fw_ver changes', () => {
    const entry = makeAuditEntry({
      action: 'update',
      changed_columns: ['pcba_a_fw_ver'],
      old_values: { pcba_a_fw_ver: 'FW1.0' },
      new_values: { pcba_a_fw_ver: 'FW2.0' },
    })
    const result = buildComponentTimeline([entry], makeDevice())
    const pcbaA = result.find((g) => g.groupKey === 'pcba_a')!
    const pcbaB = result.find((g) => g.groupKey === 'pcba_b')!
    const hmi   = result.find((g) => g.groupKey === 'hmi')!
    expect(pcbaA.events).toHaveLength(1)
    expect(pcbaB.events).toHaveLength(0)
    expect(hmi.events).toHaveLength(0)
  })

  it('emits an event in both pcba_a and hmi when a single edit touches both groups', () => {
    const entry = makeAuditEntry({
      action: 'update',
      changed_columns: ['pcba_a_hw_rev', 'hmi_ver'],
      old_values: { pcba_a_hw_rev: 'HW1', hmi_ver: 'v1.0' },
      new_values: { pcba_a_hw_rev: 'HW2', hmi_ver: 'v2.0' },
    })
    const result = buildComponentTimeline([entry], makeDevice())
    expect(result.find((g) => g.groupKey === 'pcba_a')!.events).toHaveLength(1)
    expect(result.find((g) => g.groupKey === 'hmi')!.events).toHaveLength(1)
    expect(result.find((g) => g.groupKey === 'pcba_b')!.events).toHaveLength(0)
  })
})

// ── buildComponentTimeline — event content ───────────────────────────────────

describe('buildComponentTimeline — event content', () => {
  it('includes correct field, label, oldValue, and newValue in a change event', () => {
    const entry = makeAuditEntry({
      action: 'update',
      occurred_at: '2025-06-15T08:30:00Z',
      actor_email: 'jane@quantumtx.com',
      changed_columns: ['pcba_a_fw_ver'],
      old_values: { pcba_a_fw_ver: 'FW1.0' },
      new_values: { pcba_a_fw_ver: 'FW2.0' },
    })
    const result = buildComponentTimeline([entry], makeDevice())
    const event = result.find((g) => g.groupKey === 'pcba_a')!.events[0]

    expect(event.occurred_at).toBe('2025-06-15T08:30:00Z')
    expect(event.actorEmail).toBe('jane@quantumtx.com')
    expect(event.action).toBe('update')
    expect(event.changes).toHaveLength(1)
    expect(event.changes[0]).toMatchObject({
      field: 'pcba_a_fw_ver',
      label: 'FW Ver',        // FIELD_LABELS['pcba_a_fw_ver'].en
      oldValue: 'FW1.0',
      newValue: 'FW2.0',
    })
  })

  it('renders null old/new values as empty string', () => {
    const entry = makeAuditEntry({
      action: 'update',
      changed_columns: ['pcba_b_sn'],
      old_values: { pcba_b_sn: null },
      new_values: { pcba_b_sn: 'EE-B-NEW' },
    })
    const result = buildComponentTimeline([entry], makeDevice())
    const event = result.find((g) => g.groupKey === 'pcba_b')!.events[0]
    expect(event.changes[0].oldValue).toBe('')
    expect(event.changes[0].newValue).toBe('EE-B-NEW')
  })

  it('only includes the component fields of the group in each event, not the unrelated ones from the same audit entry', () => {
    const entry = makeAuditEntry({
      action: 'update',
      changed_columns: ['pcba_a_fw_ver', 'status'],
      old_values: { pcba_a_fw_ver: 'FW1.0', status: 'in_stock' },
      new_values: { pcba_a_fw_ver: 'FW2.0', status: 'in_use' },
    })
    const result = buildComponentTimeline([entry], makeDevice())
    const event = result.find((g) => g.groupKey === 'pcba_a')!.events[0]
    // 'status' must not appear — only pcba_a_fw_ver
    expect(event.changes.map((c) => c.field)).toEqual(['pcba_a_fw_ver'])
  })
})

// ── buildComponentTimeline — insert (initial install) ────────────────────────

describe('buildComponentTimeline — insert initial install', () => {
  it('treats an insert audit entry as the initial installed event for each component group', () => {
    const entry = makeAuditEntry({
      action: 'insert',
      changed_columns: [],          // inserts have empty changed_columns
      old_values: null,
      new_values: {
        pcba_a_sn: 'EE-A-001',
        pcba_a_hw_rev: 'HW1',
        pcba_a_bom_rev: 'BOM1',
        pcba_a_fw_ver: 'FW1.0',
        pcba_b_sn: 'EE-B-001',
        pcba_b_hw_rev: 'HW2',
        pcba_b_bom_rev: 'BOM2',
        pcba_b_fw_ver: 'FW2.0',
        screen_model: 'LCD-7',
        hmi_ver: 'v1.0',
      },
    })
    const result = buildComponentTimeline([entry], makeDevice())
    // All three groups should each have exactly one install event
    result.forEach((g) => expect(g.events).toHaveLength(1))
    result.forEach((g) => expect(g.events[0].action).toBe('insert'))
  })

  it('insert event changes have empty oldValue and non-empty newValue for present fields', () => {
    const entry = makeAuditEntry({
      action: 'insert',
      changed_columns: [],
      old_values: null,
      new_values: { pcba_a_sn: 'EE-A-001', pcba_a_hw_rev: 'HW1', pcba_a_bom_rev: 'BOM1', pcba_a_fw_ver: 'FW1.0' },
    })
    const result = buildComponentTimeline([entry], makeDevice())
    const pcbaA = result.find((g) => g.groupKey === 'pcba_a')!
    pcbaA.events[0].changes.forEach((c) => {
      expect(c.oldValue).toBe('')
      expect(typeof c.newValue).toBe('string')
    })
  })

  it('insert event for a group with all-null component fields emits no changes for that group', () => {
    const entry = makeAuditEntry({
      action: 'insert',
      changed_columns: [],
      old_values: null,
      new_values: {
        pcba_a_sn: 'SN-A',
        pcba_a_hw_rev: 'HW1',
        pcba_a_bom_rev: 'B1',
        pcba_a_fw_ver: 'F1',
        // PCBA-B all null/absent
        pcba_b_sn: null,
        pcba_b_hw_rev: null,
        pcba_b_bom_rev: null,
        pcba_b_fw_ver: null,
        screen_model: 'LCD-7',
        hmi_ver: 'v1.0',
      },
    })
    const result = buildComponentTimeline([entry], makeDevice())
    // PCBA-B had no component data on insert — its changes list should be empty
    const pcbaB = result.find((g) => g.groupKey === 'pcba_b')!
    expect(pcbaB.events[0].changes).toHaveLength(0)
  })
})

// ── buildComponentTimeline — ordering ────────────────────────────────────────

describe('buildComponentTimeline — ordering', () => {
  it('preserves newest-first ordering of events within a group', () => {
    const older = makeAuditEntry({
      action: 'update',
      occurred_at: '2025-03-01T00:00:00Z',
      changed_columns: ['pcba_a_fw_ver'],
      old_values: { pcba_a_fw_ver: 'FW1.0' },
      new_values: { pcba_a_fw_ver: 'FW2.0' },
    })
    const newer = makeAuditEntry({
      action: 'update',
      occurred_at: '2025-06-01T00:00:00Z',
      changed_columns: ['pcba_a_fw_ver'],
      old_values: { pcba_a_fw_ver: 'FW2.0' },
      new_values: { pcba_a_fw_ver: 'FW3.0' },
    })
    // history comes in newest-first from getDeviceHistory
    const result = buildComponentTimeline([newer, older], makeDevice())
    const events = result.find((g) => g.groupKey === 'pcba_a')!.events
    expect(events[0].occurred_at).toBe('2025-06-01T00:00:00Z')
    expect(events[1].occurred_at).toBe('2025-03-01T00:00:00Z')
  })
})
