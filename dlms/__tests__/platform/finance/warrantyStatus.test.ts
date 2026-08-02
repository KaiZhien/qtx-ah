// ---------------------------------------------------------------------------
// Pure warranty-status domain (spec §6.3: "status derived from dates — never
// stored stale"). No I/O; `today` is injected as a 'YYYY-MM-DD' string exactly
// like every other date-sensitive domain module in this codebase.
//
// The whole point of this file is that a warranty's status is a FUNCTION of
// (dates, today) rather than a column. Every case below would need a nightly
// sweep to stay true if `status` were persisted — that is the trap the design
// avoids, and these tests are what stop someone "optimizing" it back.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest'
import {
  EXPIRING_SOON_DAYS,
  WARRANTY_STATUSES,
  warrantyStatus,
  daysUntilExpiry,
  isInForce,
  describeWarranty,
  validateWarrantyPeriod,
  warrantyStatusLabel,
  type WarrantyPeriod,
} from '@/modules/finance/domain/warrantyStatus'

const period = (startDate: string, endDate: string): WarrantyPeriod => ({ startDate, endDate })

describe('warrantyStatus', () => {
  const today = '2026-08-03'

  it('is "none" when the device has no warranty record at all', () => {
    // Spec/brief: no warranty row means NO coverage. It must never fall back to
    // the legacy DLMS "ship_date + 2 years" guess — an invented window is worse
    // than an absent one because it reads as a real commitment.
    expect(warrantyStatus(null, today)).toBe('none')
    expect(warrantyStatus(undefined, today)).toBe('none')
  })

  it('is "active" when the end date is comfortably in the future', () => {
    expect(warrantyStatus(period('2026-01-01', '2028-01-01'), today)).toBe('active')
  })

  it('is "active" on the day before the expiring-soon window opens', () => {
    // EXPIRING_SOON_DAYS + 1 away => still plain active. Boundary, both sides.
    expect(warrantyStatus(period('2024-01-01', '2026-10-03'), today)).toBe('active')
    expect(daysUntilExpiry('2026-10-03', today)).toBe(EXPIRING_SOON_DAYS + 1)
  })

  it('is "expiring_soon" exactly on the boundary day', () => {
    expect(daysUntilExpiry('2026-10-02', today)).toBe(EXPIRING_SOON_DAYS)
    expect(warrantyStatus(period('2024-01-01', '2026-10-02'), today)).toBe('expiring_soon')
  })

  it('is "expiring_soon" when it ends tomorrow', () => {
    expect(warrantyStatus(period('2024-01-01', '2026-08-04'), today)).toBe('expiring_soon')
  })

  it('is "expiring_soon" — not "expired" — on the final day of cover', () => {
    // end_date is INCLUSIVE: a warranty ending today still covers a repair
    // opened today. Off-by-one here silently denies a customer a valid claim.
    expect(daysUntilExpiry(today, today)).toBe(0)
    expect(warrantyStatus(period('2024-01-01', today), today)).toBe('expiring_soon')
  })

  it('is "expired" the day after the end date', () => {
    expect(warrantyStatus(period('2024-01-01', '2026-08-02'), today)).toBe('expired')
    expect(daysUntilExpiry('2026-08-02', today)).toBe(-1)
  })

  it('is "active", not "expired", for a warranty whose cover has not started yet', () => {
    // A pre-registered warranty (start in the future) is a live commitment that
    // simply has not begun. It is NOT expired, and it is NOT in force today.
    const future = period('2027-01-01', '2029-01-01')
    expect(warrantyStatus(future, today)).toBe('active')
    expect(isInForce(future, today)).toBe(false)
  })

  it('enumerates exactly the four statuses the read services promise', () => {
    expect([...WARRANTY_STATUSES]).toEqual(['active', 'expiring_soon', 'expired', 'none'])
  })
})

describe('daysUntilExpiry', () => {
  it('counts calendar days across a month boundary', () => {
    expect(daysUntilExpiry('2026-09-01', '2026-08-31')).toBe(1)
    expect(daysUntilExpiry('2026-09-30', '2026-08-31')).toBe(30)
  })

  it('counts calendar days across a year boundary', () => {
    expect(daysUntilExpiry('2027-01-01', '2026-12-31')).toBe(1)
  })

  it('handles a leap day exactly', () => {
    // 2028 is a leap year: Feb has 29 days.
    expect(daysUntilExpiry('2028-03-01', '2028-02-28')).toBe(2)
    // 2026 is not: Feb has 28.
    expect(daysUntilExpiry('2026-03-01', '2026-02-28')).toBe(1)
  })

  it('is unaffected by daylight-saving boundaries in the host timezone', () => {
    // Parsed as UTC calendar days, never as local instants. A naive
    // `new Date(a) - new Date(b)` / 86400000 returns 30.958... across a
    // northern-hemisphere DST shift and floors to 30. This is the exact bug
    // LOGISTICS hit (commit 6b36485) — pinned here so it cannot come back.
    expect(daysUntilExpiry('2027-04-01', '2027-03-01')).toBe(31)
    expect(daysUntilExpiry('2027-11-01', '2027-10-01')).toBe(31)
  })

  it('rejects a malformed date rather than silently returning NaN', () => {
    expect(() => daysUntilExpiry('03/08/2026', '2026-08-03')).toThrow(/YYYY-MM-DD/)
    expect(() => daysUntilExpiry('2026-13-01', '2026-08-03')).toThrow(/YYYY-MM-DD/)
    expect(() => daysUntilExpiry('2026-02-30', '2026-08-03')).toThrow(/YYYY-MM-DD/)
  })
})

describe('isInForce', () => {
  it('is true on the start date and on the end date (both inclusive)', () => {
    const p = period('2026-08-03', '2026-08-05')
    expect(isInForce(p, '2026-08-03')).toBe(true)
    expect(isInForce(p, '2026-08-04')).toBe(true)
    expect(isInForce(p, '2026-08-05')).toBe(true)
  })

  it('is false before the start and after the end', () => {
    const p = period('2026-08-03', '2026-08-05')
    expect(isInForce(p, '2026-08-02')).toBe(false)
    expect(isInForce(p, '2026-08-06')).toBe(false)
  })
})

describe('describeWarranty', () => {
  it('bundles status, days remaining and in-force for a single render pass', () => {
    expect(describeWarranty(period('2026-01-01', '2026-08-20'), '2026-08-03')).toEqual({
      status: 'expiring_soon', daysRemaining: 17, inForce: true,
    })
  })

  it('reports the absent case without inventing a period', () => {
    expect(describeWarranty(null, '2026-08-03')).toEqual({
      status: 'none', daysRemaining: null, inForce: false,
    })
  })
})

describe('validateWarrantyPeriod', () => {
  it('accepts a normal period', () => {
    expect(validateWarrantyPeriod('2026-01-01', '2028-01-01')).toEqual({ ok: true })
  })

  it('accepts a single-day period (start === end)', () => {
    expect(validateWarrantyPeriod('2026-01-01', '2026-01-01')).toEqual({ ok: true })
  })

  it('rejects an end date before the start date', () => {
    expect(validateWarrantyPeriod('2026-01-02', '2026-01-01'))
      .toEqual({ ok: false, error: 'end_before_start' })
  })

  it('rejects malformed input instead of throwing at the caller', () => {
    expect(validateWarrantyPeriod('not-a-date', '2026-01-01'))
      .toEqual({ ok: false, error: 'malformed_date' })
    expect(validateWarrantyPeriod('2026-01-01', '2026-02-31'))
      .toEqual({ ok: false, error: 'malformed_date' })
  })
})

describe('warrantyStatusLabel', () => {
  it('gives every status a human label', () => {
    for (const s of WARRANTY_STATUSES) {
      expect(warrantyStatusLabel(s)).toMatch(/\S/)
    }
    expect(warrantyStatusLabel('expiring_soon')).toBe('Expiring soon')
    expect(warrantyStatusLabel('none')).toBe('No warranty')
  })
})
