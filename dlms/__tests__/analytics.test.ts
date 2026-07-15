import { describe, it, expect, vi, beforeEach } from 'vitest'
// Imported before analyticsService so makeServerModuleMock is initialized when
// the hoisted vi.mock factory below runs (that factory executes as soon as
// analyticsService pulls in the mocked @/lib/supabase/server).
import { makeServerModuleMock } from './supabaseChainMock'
import { parseIntervalToSeconds } from '@/lib/services/analyticsService'

// ---------------------------------------------------------------------------
// Mock the Supabase server client
// ---------------------------------------------------------------------------

const mockSelect = vi.fn()
const mockGte = vi.fn()
const mockOrder = vi.fn()
const mockEq = vi.fn()
const mockIn = vi.fn()
const mockIs = vi.fn()

// Each builder method returns `this` (the builder) so calls can chain.
// The terminal call that actually resolves is the last one; we make each
// builder method return a fresh object that ultimately returns { data, error }.

function buildChain(result: { data: unknown; error: unknown }) {
  const chain: Record<string, unknown> = {}
  const methods = ['select', 'gte', 'order', 'eq', 'in', 'is', 'not', 'lte', 'limit']
  for (const m of methods) {
    chain[m] = vi.fn(() => chain)
  }
  // Make the chain thenable so `await supabase.from(...).select(...)...` resolves
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(result).then(resolve)
  return chain
}

// We'll swap out what `from` returns per test
let fromImpl: (table: string) => unknown

vi.mock('@/lib/supabase/server', () => makeServerModuleMock(() => fromImpl))

// ---------------------------------------------------------------------------
// Unit tests for parseIntervalToSeconds helper
// ---------------------------------------------------------------------------

describe('parseIntervalToSeconds', () => {
  it('parses "2 days 03:00:00" correctly', () => {
    expect(parseIntervalToSeconds('2 days 03:00:00')).toBe(2 * 86400 + 3 * 3600)
  })

  it('parses "0 days 00:30:00" correctly', () => {
    expect(parseIntervalToSeconds('0 days 00:30:00')).toBe(30 * 60)
  })

  it('parses "5:00:00" (no day component)', () => {
    expect(parseIntervalToSeconds('5:00:00')).toBe(5 * 3600)
  })

  it('parses "1 day 00:00:00"', () => {
    expect(parseIntervalToSeconds('1 day 00:00:00')).toBe(86400)
  })

  it('returns 0 for empty string', () => {
    expect(parseIntervalToSeconds('')).toBe(0)
  })

  it('parses "10 days 12:30:45"', () => {
    expect(parseIntervalToSeconds('10 days 12:30:45')).toBe(
      10 * 86400 + 12 * 3600 + 30 * 60 + 45
    )
  })

  it('parses "1 year 2 mons 3 days 04:05:06"', () => {
    expect(parseIntervalToSeconds('1 year 2 mons 3 days 04:05:06')).toBe(
      1 * 31536000 + 2 * 2592000 + 3 * 86400 + 4 * 3600 + 5 * 60 + 6
    )
  })

  it('parses "2 years" (no months/days/time)', () => {
    expect(parseIntervalToSeconds('2 years')).toBe(2 * 31536000)
  })

  it('parses "3 mons 00:00:00"', () => {
    expect(parseIntervalToSeconds('3 mons 00:00:00')).toBe(3 * 2592000)
  })

  it('parses fractional seconds e.g. "2 days 03:14:07.583221"', () => {
    expect(parseIntervalToSeconds('2 days 03:14:07.583221')).toBeCloseTo(
      2 * 86400 + 3 * 3600 + 14 * 60 + 7.583221,
      4
    )
  })
})

// ---------------------------------------------------------------------------
// getOverviewMetrics
// ---------------------------------------------------------------------------

describe('getOverviewMetrics', () => {
  it('aggregates totals and groups by status and phase', async () => {
    const mockRows = [
      { status: 'Stock',    label_en: 'Stock',    label_zh: '库存',  phase: 'Production', phase_label_en: 'Production', phase_label_zh: '生产', device_count: 3, unit_count: 6 },
      { status: 'In Use',   label_en: 'In Use',   label_zh: '使用中', phase: 'Production', phase_label_en: 'Production', phase_label_zh: '生产', device_count: 2, unit_count: 4 },
      { status: 'Stock',    label_en: 'Stock',    label_zh: '库存',  phase: 'Validation', phase_label_en: 'Validation', phase_label_zh: '验证', device_count: 1, unit_count: 2 },
    ]

    fromImpl = () => buildChain({ data: mockRows, error: null })

    const { getOverviewMetrics } = await import('@/lib/services/analyticsService')
    const result = await getOverviewMetrics()

    expect(result.totalDevices).toBe(6)
    expect(result.totalUnits).toBe(12)

    // byStatus: Stock = 4 devices, In Use = 2
    const stockEntry = result.byStatus.find(s => s.status === 'Stock')
    expect(stockEntry?.device_count).toBe(4)
    expect(stockEntry?.unit_count).toBe(8)

    const inUseEntry = result.byStatus.find(s => s.status === 'In Use')
    expect(inUseEntry?.device_count).toBe(2)

    // byPhase: Production = 5 devices, Validation = 1
    const prodEntry = result.byPhase.find(p => p.phase === 'Production')
    expect(prodEntry?.device_count).toBe(5)

    const valEntry = result.byPhase.find(p => p.phase === 'Validation')
    expect(valEntry?.device_count).toBe(1)
  })

  it('throws on query error', async () => {
    fromImpl = () => buildChain({ data: null, error: { message: 'DB failure' } })

    const { getOverviewMetrics } = await import('@/lib/services/analyticsService')
    await expect(getOverviewMetrics()).rejects.toThrow('DB failure')
  })
})

// ---------------------------------------------------------------------------
// getThroughputSeries
// ---------------------------------------------------------------------------

describe('getThroughputSeries', () => {
  it('maps snake_case rows to camelCase ThroughputPoints', async () => {
    const mockRows = [
      { day: '2024-01-01', devices_created: 3, devices_completed: 1 },
      { day: '2024-01-02', devices_created: 5, devices_completed: 2 },
    ]

    fromImpl = () => buildChain({ data: mockRows, error: null })

    const { getThroughputSeries } = await import('@/lib/services/analyticsService')
    const result = await getThroughputSeries('7d')

    expect(result).toHaveLength(2)
    expect(result[0]).toEqual({ day: '2024-01-01', devicesCreated: 3, devicesCompleted: 1 })
    expect(result[1]).toEqual({ day: '2024-01-02', devicesCreated: 5, devicesCompleted: 2 })
  })

  it('returns empty array when no rows', async () => {
    fromImpl = () => buildChain({ data: [], error: null })

    const { getThroughputSeries } = await import('@/lib/services/analyticsService')
    const result = await getThroughputSeries('30d')
    expect(result).toHaveLength(0)
  })

  it('throws on query error', async () => {
    fromImpl = () => buildChain({ data: null, error: { message: 'view error' } })

    const { getThroughputSeries } = await import('@/lib/services/analyticsService')
    await expect(getThroughputSeries('90d')).rejects.toThrow('view error')
  })
})

// ---------------------------------------------------------------------------
// getStatusDurations
// ---------------------------------------------------------------------------

describe('getStatusDurations', () => {
  it('parses interval strings and computes avg/median correctly', async () => {
    // Two entries for 'Stock': 2 days and 4 days → avg=3, median=3
    // One entry for 'Repair': 1 day → avg=1, median=1
    const mockRows = [
      { status: 'Stock',  dwell_interval: '2 days 00:00:00' },
      { status: 'Stock',  dwell_interval: '4 days 00:00:00' },
      { status: 'Repair', dwell_interval: '1 day 00:00:00' },
    ]

    fromImpl = () => buildChain({ data: mockRows, error: null })

    const { getStatusDurations } = await import('@/lib/services/analyticsService')
    const result = await getStatusDurations()

    // Sorted by avgDays desc: Stock (3) before Repair (1)
    expect(result[0].status).toBe('Stock')
    expect(result[0].avgDays).toBeCloseTo(3, 5)
    expect(result[0].medianDays).toBeCloseTo(3, 5)
    expect(result[0].sampleCount).toBe(2)

    expect(result[1].status).toBe('Repair')
    expect(result[1].avgDays).toBeCloseTo(1, 5)
    expect(result[1].medianDays).toBeCloseTo(1, 5)
    expect(result[1].sampleCount).toBe(1)
  })

  it('computes correct median for odd/even sample counts', async () => {
    // 3 entries: 1d, 3d, 5d → median = 3d
    const mockRows = [
      { status: 'Test', dwell_interval: '1 day 00:00:00' },
      { status: 'Test', dwell_interval: '3 days 00:00:00' },
      { status: 'Test', dwell_interval: '5 days 00:00:00' },
    ]

    fromImpl = () => buildChain({ data: mockRows, error: null })

    const { getStatusDurations } = await import('@/lib/services/analyticsService')
    const result = await getStatusDurations()
    expect(result[0].medianDays).toBeCloseTo(3, 5)
  })

  it('throws on query error', async () => {
    fromImpl = () => buildChain({ data: null, error: { message: 'dwell error' } })

    const { getStatusDurations } = await import('@/lib/services/analyticsService')
    await expect(getStatusDurations()).rejects.toThrow('dwell error')
  })
})

// ---------------------------------------------------------------------------
// getMyQueue
// ---------------------------------------------------------------------------

describe('getMyQueue', () => {
  const USER_ID = 'user-abc'

  // Terminal statuses are now derived from this vocabulary flag, not a hardcode.
  const STATUS_VOCAB = [
    { code: 'Stock', is_terminal: false },
    { code: 'In Use', is_terminal: false },
    { code: 'Retired', is_terminal: true },
    { code: 'Lost', is_terminal: true },
  ]

  it('returns devices recently touched by user with non-terminal status', async () => {
    // First audit_log call: find entries by this user (capped at 500)
    const auditByUser = [
      { row_id: 'device-1', actor_id: USER_ID, occurred_at: '2024-02-10T10:00:00Z' },
      { row_id: 'device-2', actor_id: USER_ID, occurred_at: '2024-02-09T10:00:00Z' },
    ]
    // Second audit_log call (verify): most recent entries for candidate devices
    const auditVerify = [
      { row_id: 'device-1', actor_id: USER_ID, occurred_at: '2024-02-10T10:00:00Z' },
      { row_id: 'device-2', actor_id: USER_ID, occurred_at: '2024-02-09T10:00:00Z' },
    ]
    // device rows for those candidates
    const deviceRows = [
      { id: 'device-1', device_sn: 'SN001', model_no: 'ModelA', status: 'Stock', updated_at: '2024-02-10T10:00:00Z' },
      { id: 'device-2', device_sn: 'SN002', model_no: 'ModelB', status: 'In Use', updated_at: '2024-02-09T10:00:00Z' },
    ]

    let auditCallCount = 0
    fromImpl = (table: string) => {
      if (table === 'audit_log') {
        const data = auditCallCount === 0 ? auditByUser : auditVerify
        auditCallCount++
        return buildChain({ data, error: null })
      }
      if (table === 'device') return buildChain({ data: deviceRows, error: null })
      if (table === 'status_option') return buildChain({ data: STATUS_VOCAB, error: null })
      return buildChain({ data: [], error: null })
    }

    const { getMyQueue } = await import('@/lib/services/analyticsService')
    const result = await getMyQueue(USER_ID)

    expect(result).toHaveLength(2)
    expect(result[0].deviceId).toBe('device-1')
    expect(result[0].serialNo).toBe('SN001')
    expect(result[0].status).toBe('Stock')
  })

  it('excludes devices with terminal statuses', async () => {
    const auditByUser = [{ row_id: 'device-3', actor_id: USER_ID, occurred_at: '2024-02-10T10:00:00Z' }]
    const auditVerify = [{ row_id: 'device-3', actor_id: USER_ID, occurred_at: '2024-02-10T10:00:00Z' }]
    const deviceRows = [
      { id: 'device-3', device_sn: 'SN003', model_no: 'ModelA', status: 'Retired', updated_at: '2024-02-10T10:00:00Z' },
    ]

    let auditCallCount = 0
    fromImpl = (table: string) => {
      if (table === 'audit_log') {
        const data = auditCallCount === 0 ? auditByUser : auditVerify
        auditCallCount++
        return buildChain({ data, error: null })
      }
      if (table === 'device') return buildChain({ data: deviceRows, error: null })
      if (table === 'status_option') return buildChain({ data: STATUS_VOCAB, error: null })
      return buildChain({ data: [], error: null })
    }

    const { getMyQueue } = await import('@/lib/services/analyticsService')
    const result = await getMyQueue(USER_ID)
    expect(result).toHaveLength(0)
  })

  it('excludes devices in an admin-added terminal status (flag-derived, not hardcoded)', async () => {
    const auditByUser = [{ row_id: 'device-5', actor_id: USER_ID, occurred_at: '2024-02-10T10:00:00Z' }]
    const auditVerify = [{ row_id: 'device-5', actor_id: USER_ID, occurred_at: '2024-02-10T10:00:00Z' }]
    const deviceRows = [
      { id: 'device-5', device_sn: 'SN005', model_no: 'ModelA', status: 'Scrapped', updated_at: '2024-02-10T10:00:00Z' },
    ]
    const grownVocab = [...STATUS_VOCAB, { code: 'Scrapped', is_terminal: true }]

    let auditCallCount = 0
    fromImpl = (table: string) => {
      if (table === 'audit_log') {
        const data = auditCallCount === 0 ? auditByUser : auditVerify
        auditCallCount++
        return buildChain({ data, error: null })
      }
      if (table === 'device') return buildChain({ data: deviceRows, error: null })
      if (table === 'status_option') return buildChain({ data: grownVocab, error: null })
      return buildChain({ data: [], error: null })
    }

    const { getMyQueue } = await import('@/lib/services/analyticsService')
    const result = await getMyQueue(USER_ID)
    expect(result).toHaveLength(0)
  })

  it('returns empty array when user has no audit entries', async () => {
    fromImpl = () => buildChain({ data: [], error: null })

    const { getMyQueue } = await import('@/lib/services/analyticsService')
    const result = await getMyQueue(USER_ID)
    expect(result).toHaveLength(0)
  })

  it('excludes devices where another user acted more recently', async () => {
    // This user touched device-4, but OTHER_USER acted on it after
    const OTHER_USER = 'user-other'
    const auditByUser = [{ row_id: 'device-4', actor_id: USER_ID, occurred_at: '2024-02-08T10:00:00Z' }]
    // Verify step: most recent entry for device-4 is by OTHER_USER
    const auditVerify = [
      { row_id: 'device-4', actor_id: OTHER_USER, occurred_at: '2024-02-09T10:00:00Z' },
      { row_id: 'device-4', actor_id: USER_ID,   occurred_at: '2024-02-08T10:00:00Z' },
    ]
    const deviceRows = [
      { id: 'device-4', device_sn: 'SN004', model_no: 'ModelA', status: 'Stock', updated_at: '2024-02-09T10:00:00Z' },
    ]

    let auditCallCount = 0
    fromImpl = (table: string) => {
      if (table === 'audit_log') {
        const data = auditCallCount === 0 ? auditByUser : auditVerify
        auditCallCount++
        return buildChain({ data, error: null })
      }
      if (table === 'device') return buildChain({ data: deviceRows, error: null })
      return buildChain({ data: [], error: null })
    }

    const { getMyQueue } = await import('@/lib/services/analyticsService')
    const result = await getMyQueue(USER_ID)
    expect(result).toHaveLength(0)
  })

  it('throws on audit_log query error', async () => {
    fromImpl = () => buildChain({ data: null, error: { message: 'audit error' } })

    const { getMyQueue } = await import('@/lib/services/analyticsService')
    await expect(getMyQueue(USER_ID)).rejects.toThrow('audit error')
  })
})
