import {
  SERVICE_INTERVAL_DAYS,
  baselineDate,
  serviceStatus,
  computeOverdueDeviceIds,
} from '@/lib/domain/serviceSchedule'

// Fixed today for deterministic tests
const TODAY = new Date('2026-07-01')

// ── baselineDate ────────────────────────────────────────────────────────────

describe('baselineDate', () => {
  it('prefers lastServiceDate when both present', () => {
    expect(baselineDate('2026-05-01', '2020-01-01')).toBe('2026-05-01')
  })

  it('falls back to shipDate when no lastServiceDate', () => {
    expect(baselineDate(null, '2020-01-01')).toBe('2020-01-01')
  })

  it('returns null when neither present', () => {
    expect(baselineDate(null, null)).toBeNull()
  })
})

// ── serviceStatus ───────────────────────────────────────────────────────────

describe('serviceStatus', () => {
  it('overdue when baseline is more than intervalDays in the past', () => {
    // 2026-07-01 minus 200 days > 180-day interval
    const result = serviceStatus('2026-01-01', null, SERVICE_INTERVAL_DAYS, TODAY)
    expect(result.overdue).toBe(true)
  })

  it('not overdue when baseline is exactly intervalDays in the past', () => {
    // 180 days before 2026-07-01 is 2026-01-02
    const result = serviceStatus('2026-01-02', null, 180, TODAY)
    expect(result.overdue).toBe(false)
    expect(result.daysSinceBaseline).toBe(180)
  })

  it('not overdue when baseline is within intervalDays', () => {
    const result = serviceStatus('2026-06-01', null, SERVICE_INTERVAL_DAYS, TODAY)
    expect(result.overdue).toBe(false)
  })

  it('uses shipDate baseline when no service event has ever been logged', () => {
    const result = serviceStatus(null, '2025-01-01', SERVICE_INTERVAL_DAYS, TODAY)
    expect(result.overdue).toBe(true)
    expect(result.baselineDate).toBe('2025-01-01')
  })

  it('not overdue when neither a service event nor a ship date exists', () => {
    const result = serviceStatus(null, null, SERVICE_INTERVAL_DAYS, TODAY)
    expect(result.overdue).toBe(false)
    expect(result.daysSinceBaseline).toBeNull()
    expect(result.baselineDate).toBeNull()
  })
})

// ── computeOverdueDeviceIds ─────────────────────────────────────────────────

describe('computeOverdueDeviceIds', () => {
  it('returns ids of devices overdue by their latest service event', () => {
    const devices = [
      { id: 'dev-1', ship_date: '2020-01-01' },
      { id: 'dev-2', ship_date: '2020-01-01' },
    ]
    const latestByDevice = new Map([
      ['dev-1', '2026-01-01'], // overdue
      ['dev-2', '2026-06-01'], // not overdue
    ])
    const result = computeOverdueDeviceIds(devices, latestByDevice, SERVICE_INTERVAL_DAYS, TODAY)
    expect(result).toEqual(['dev-1'])
  })

  it('falls back to ship_date for devices with no logged service event', () => {
    const devices = [{ id: 'dev-3', ship_date: '2020-01-01' }]
    const latestByDevice = new Map<string, string>()
    const result = computeOverdueDeviceIds(devices, latestByDevice, SERVICE_INTERVAL_DAYS, TODAY)
    expect(result).toEqual(['dev-3'])
  })

  it('excludes devices with no baseline at all', () => {
    const devices = [{ id: 'dev-4', ship_date: null }]
    const latestByDevice = new Map<string, string>()
    const result = computeOverdueDeviceIds(devices, latestByDevice, SERVICE_INTERVAL_DAYS, TODAY)
    expect(result).toEqual([])
  })
})
