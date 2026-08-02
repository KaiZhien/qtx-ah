import { describe, it, expect } from 'vitest'
import {
  daysInState, agingBucket, AGING_BUCKETS,
} from '@/modules/shared/reporting/domain/aging'
import {
  expiryBucket, EXPIRY_WINDOWS, daysUntil,
} from '@/modules/shared/reporting/domain/expiry'

const at = (iso: string) => new Date(iso)

describe('daysInState — repair aging (spec §8.5 Maintenance)', () => {
  it('counts whole elapsed days between two instants', () => {
    expect(daysInState(at('2026-08-01T00:00:00Z'), at('2026-08-04T00:00:00Z'))).toBe(3)
  })

  it('is 0 for a state entered today', () => {
    expect(daysInState(at('2026-08-04T09:00:00Z'), at('2026-08-04T17:00:00Z'))).toBe(0)
  })

  it('floors a partial day rather than rounding it up', () => {
    // 3 days and 23 hours is 3 days in state, not 4.
    expect(daysInState(at('2026-08-01T00:00:00Z'), at('2026-08-04T23:00:00Z'))).toBe(3)
  })

  it('is timezone-independent — both arguments are instants, not local dates', () => {
    // The same two moments written in two zones must give the same answer.
    const utc = daysInState(at('2026-08-01T00:00:00Z'), at('2026-08-04T00:00:00Z'))
    const sgt = daysInState(at('2026-08-01T08:00:00+08:00'), at('2026-08-04T08:00:00+08:00'))
    expect(sgt).toBe(utc)
  })

  it('never returns a negative age for a clock skew / future timestamp', () => {
    expect(daysInState(at('2026-08-10T00:00:00Z'), at('2026-08-04T00:00:00Z'))).toBe(0)
  })
})

describe('agingBucket', () => {
  it('buckets by the declared thresholds', () => {
    expect(agingBucket(0)).toBe('0-3')
    expect(agingBucket(3)).toBe('0-3')
    expect(agingBucket(4)).toBe('4-7')
    expect(agingBucket(7)).toBe('4-7')
    expect(agingBucket(8)).toBe('8-14')
    expect(agingBucket(14)).toBe('8-14')
    expect(agingBucket(15)).toBe('15+')
    expect(agingBucket(999)).toBe('15+')
  })

  it('exposes its buckets in ascending order for a stable chart axis', () => {
    expect(AGING_BUCKETS).toEqual(['0-3', '4-7', '8-14', '15+'])
  })

  it('assigns every non-negative day count to exactly one bucket', () => {
    for (let d = 0; d <= 40; d++) {
      expect(AGING_BUCKETS).toContain(agingBucket(d))
    }
  })
})

describe('daysUntil — date-only arithmetic on YYYY-MM-DD', () => {
  it('counts calendar days forward', () => {
    expect(daysUntil('2026-09-03', '2026-08-04')).toBe(30)
  })

  it('is 0 on the day itself', () => {
    expect(daysUntil('2026-08-04', '2026-08-04')).toBe(0)
  })

  it('is negative for a past date', () => {
    expect(daysUntil('2026-08-01', '2026-08-04')).toBe(-3)
  })

  it('takes ISO DATE STRINGS, never Date objects, so no host timezone can shift it', () => {
    // A previous slice shipped a day-shift by round-tripping a date column through
    // toISOString() on a UTC+ host. Date columns stay strings end to end here.
    expect(daysUntil('2026-01-01', '2025-12-31')).toBe(1)
    expect(daysUntil('2026-03-01', '2026-02-28')).toBe(1) // 2026 is not a leap year
  })

  it('crosses a leap day correctly', () => {
    expect(daysUntil('2028-03-01', '2028-02-28')).toBe(2) // 2028 IS a leap year
  })
})

describe('expiryBucket — warranties expiring 30/60/90 d (spec §8.5)', () => {
  const today = '2026-08-04'

  it('buckets by the first window the expiry falls inside', () => {
    expect(expiryBucket('2026-08-04', today)).toBe(30) // today
    expect(expiryBucket('2026-09-03', today)).toBe(30) // +30
    expect(expiryBucket('2026-09-04', today)).toBe(60) // +31
    expect(expiryBucket('2026-10-03', today)).toBe(60) // +60
    expect(expiryBucket('2026-10-04', today)).toBe(90) // +61
    expect(expiryBucket('2026-11-02', today)).toBe(90) // +90
  })

  it('returns null beyond the widest window — not a bucket, not an error', () => {
    expect(expiryBucket('2026-11-03', today)).toBeNull() // +91
    expect(expiryBucket('2027-08-04', today)).toBeNull()
  })

  it('reports an already-expired warranty as "expired", never as 30-day', () => {
    // Folding these into the 30-day bucket would report a lapsed warranty as
    // an upcoming action, which is the opposite of what the widget is for.
    expect(expiryBucket('2026-08-03', today)).toBe('expired')
    expect(expiryBucket('2020-01-01', today)).toBe('expired')
  })

  it('exposes its windows in ascending order', () => {
    expect(EXPIRY_WINDOWS).toEqual([30, 60, 90])
  })

  it('assigns each window boundary to exactly one bucket (no double counting)', () => {
    // 30/60/90 are cumulative in the spec's phrasing but must be disjoint here,
    // or a warranty expiring in 20 days is counted three times.
    const seen = ['2026-09-03', '2026-10-03', '2026-11-02'].map((d) => expiryBucket(d, today))
    expect(seen).toEqual([30, 60, 90])
  })
})
