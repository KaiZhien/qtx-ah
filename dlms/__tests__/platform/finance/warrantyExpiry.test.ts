import { describe, it, expect } from 'vitest'
import {
  WARRANTY_EXPIRY_MILESTONES, milestoneFor, warrantyExpiryDedupeKey,
  buildWarrantyExpiryReminders,
} from '@/modules/finance/domain/warrantyExpiry'

/**
 * The pure half of the warranty-expiry sweep.
 *
 * Two properties carry the whole design and are asserted first, because everything else
 * is arithmetic around them:
 *
 *   THE KEY HAS NO DAY COMPONENT. Task reminders deliberately include the UTC day so an
 *   overdue task nags daily; a warranty milestone must fire ONCE EVER, and omitting the
 *   day is exactly what makes that true.
 *
 *   THE KEY IS PER WARRANTY, NEVER PER DEVICE. A renewal mints a NEW warranty row and
 *   soft-deletes the old one (warranty_device_live_unique is partial on
 *   deleted_at IS NULL). Keyed on the device, a renewed warranty would never notify again.
 */

const W = (over: Partial<Parameters<typeof buildWarrantyExpiryReminders>[0][number]> = {}) => ({
  warrantyId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  deviceId: 'dddddddd-dddd-dddd-dddd-dddddddddddd',
  deviceSn: 'SN-00042',
  endDate: '2026-09-03',
  ...over,
})

describe('warrantyExpiryDedupeKey', () => {
  it('contains the warranty id and the milestone, and NOTHING date-shaped', () => {
    const key = warrantyExpiryDedupeKey('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', 30)
    expect(key).toBe('warranty_expiring:aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa:30')
    // The regression guard. A YYYY-MM-DD anywhere in here turns "once ever" into "once a
    // day" — the reminder sweep's behaviour, which is right there and wrong here.
    expect(key).not.toMatch(/\d{4}-\d{2}-\d{2}/)
  })

  it('is keyed on the WARRANTY, so a renewal is a new key', () => {
    const original = warrantyExpiryDedupeKey('11111111-1111-1111-1111-111111111111', 30)
    const renewal = warrantyExpiryDedupeKey('22222222-2222-2222-2222-222222222222', 30)
    expect(renewal).not.toBe(original)
  })

  it('is distinct per milestone, so 90/60/30 are three separate messages', () => {
    const keys = WARRANTY_EXPIRY_MILESTONES.map((m) => warrantyExpiryDedupeKey('w-1', m))
    expect(new Set(keys).size).toBe(WARRANTY_EXPIRY_MILESTONES.length)
  })

  it('does NOT append the recipient — fanOutInTx owns that half', () => {
    expect(warrantyExpiryDedupeKey('w-1', 30)).not.toMatch(/:[0-9a-f-]{36}$/)
  })
})

describe('milestoneFor', () => {
  /** Buckets are CUMULATIVE (30 ⊆ 60 ⊆ 90), so the answer is the TIGHTEST one reached. */
  it.each([
    [0, 30], [1, 30], [29, 30], [30, 30],
    [31, 60], [59, 60], [60, 60],
    [61, 90], [89, 90], [90, 90],
  ])('%i days remaining is the %i-day milestone', (days, expected) => {
    expect(milestoneFor(days)).toBe(expected)
  })

  it('is null beyond the widest bucket — nothing to say yet', () => {
    expect(milestoneFor(91)).toBeNull()
    expect(milestoneFor(400)).toBeNull()
  })

  /**
   * Already expired is null, not the 30-day bucket. The radar is a call to action
   * ("renew these"), and getExpiringWarranties excludes expired rows for the same reason —
   * but the domain must not depend on that filter to be correct.
   */
  it('is null once the warranty has already lapsed', () => {
    expect(milestoneFor(-1)).toBeNull()
    expect(milestoneFor(-400)).toBeNull()
  })
})

describe('buildWarrantyExpiryReminders', () => {
  it('emits one reminder per warranty, at the tightest milestone it has reached', () => {
    const out = buildWarrantyExpiryReminders([
      W({ warrantyId: 'w-30', endDate: '2026-08-20' }),   // 16 days out
      W({ warrantyId: 'w-60', endDate: '2026-09-20' }),   // 47 days out
      W({ warrantyId: 'w-90', endDate: '2026-10-20' }),   // 77 days out
    ], '2026-08-04')

    expect(out.map((r) => [r.warrantyId, r.milestone])).toEqual([
      ['w-30', 30], ['w-60', 60], ['w-90', 90],
    ])
    expect(out.map((r) => r.dedupeKey)).toEqual([
      'warranty_expiring:w-30:30',
      'warranty_expiring:w-60:60',
      'warranty_expiring:w-90:90',
    ])
  })

  /**
   * THE PROPERTY THE WHOLE SWEEP RESTS ON. A warranty that ticks from 25 days to 24 days
   * overnight is still the 30-day milestone, so the key is byte-identical and the second
   * day's insert is suppressed by notification_dedupe_idx. Were the day in the key, this
   * would be a daily nag for thirty days.
   */
  it('produces the SAME key on consecutive days within one bucket', () => {
    const w = [W({ warrantyId: 'w-1', endDate: '2026-08-29' })]
    const day1 = buildWarrantyExpiryReminders(w, '2026-08-04')   // 25 days
    const day2 = buildWarrantyExpiryReminders(w, '2026-08-05')   // 24 days
    expect(day1[0].daysRemaining).toBe(25)
    expect(day2[0].daysRemaining).toBe(24)
    expect(day2[0].dedupeKey).toBe(day1[0].dedupeKey)
  })

  /** Crossing INTO a tighter bucket is a new message, which is the point of three. */
  it('produces a NEW key when the warranty crosses into a tighter bucket', () => {
    const w = [W({ warrantyId: 'w-1', endDate: '2026-09-03' })]
    const before = buildWarrantyExpiryReminders(w, '2026-08-03')  // 31 days -> 60
    const after = buildWarrantyExpiryReminders(w, '2026-08-04')   // 30 days -> 30
    expect(before[0].milestone).toBe(60)
    expect(after[0].milestone).toBe(30)
    expect(after[0].dedupeKey).not.toBe(before[0].dedupeKey)
  })

  it('skips warranties outside every bucket, in both directions', () => {
    const out = buildWarrantyExpiryReminders([
      W({ warrantyId: 'far', endDate: '2027-08-04' }),      // 365 days
      W({ warrantyId: 'lapsed', endDate: '2026-08-03' }),   // yesterday
      W({ warrantyId: 'today', endDate: '2026-08-04' }),    // 0 days — still covered
    ], '2026-08-04')
    expect(out.map((r) => r.warrantyId)).toEqual(['today'])
    expect(out[0].milestone).toBe(30)
  })

  it('carries the device label through, null serial and all', () => {
    const out = buildWarrantyExpiryReminders(
      [W({ deviceSn: null, endDate: '2026-08-10' })], '2026-08-04')
    expect(out[0].deviceSn).toBeNull()
    expect(out[0].deviceId).toBe('dddddddd-dddd-dddd-dddd-dddddddddddd')
    expect(out[0].endDate).toBe('2026-08-10')
  })

  /**
   * A malformed date must not silently become NaN days and land in a bucket by accident —
   * daysUntilExpiry throws on it, which is the behaviour warrantyStatus.ts documents.
   */
  it('refuses a malformed date rather than inventing a bucket', () => {
    expect(() => buildWarrantyExpiryReminders(
      [W({ endDate: '2026-02-30' })], '2026-08-04')).toThrow(/calendar date/i)
    expect(() => buildWarrantyExpiryReminders(
      [W({ endDate: '2026-08-10' })], 'not-a-date')).toThrow(/calendar date/i)
  })

  it('is empty for an empty input, without touching anything', () => {
    expect(buildWarrantyExpiryReminders([], '2026-08-04')).toEqual([])
  })
})
