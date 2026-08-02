import { describe, it, expect } from 'vitest'
import {
  chronologicalUsageOrder, deriveUsageSeries, summarizeUsage,
  classifyNewReading, daysSinceLastReading,
  type UsageReading,
} from '@/modules/maintenance/domain/usageReadings'

// Readings are built with an explicit createdAt so the "entered later, dated
// earlier" case is expressible — that ordering pair is the whole reason the
// reset flag cannot be a stored column.
let seq = 0
function r(recordedOn: string, cumulativeSessions: number, createdAtIso?: string): UsageReading {
  seq += 1
  return {
    id: `u${seq}`,
    recordedOn,
    cumulativeSessions,
    // Default createdAt marches forward with insertion order, which is what a
    // real append-only table produces when rows are entered in date order.
    createdAt: new Date(createdAtIso ?? `2026-01-01T00:00:${String(seq).padStart(2, '0')}Z`),
  }
}

describe('chronologicalUsageOrder', () => {
  it('orders by recorded_on regardless of the order rows were inserted', () => {
    const late = r('2026-03-01', 300, '2026-05-01T00:00:00Z')
    const early = r('2026-01-01', 100, '2026-05-02T00:00:00Z')
    expect(chronologicalUsageOrder([late, early]).map((x) => x.recordedOn))
      .toEqual(['2026-01-01', '2026-03-01'])
  })

  it('breaks a same-day tie on createdAt, so two readings on one date keep entry order', () => {
    const second = r('2026-03-01', 20, '2026-03-01T10:00:00Z')
    const first = r('2026-03-01', 500, '2026-03-01T09:00:00Z')
    expect(chronologicalUsageOrder([second, first]).map((x) => x.cumulativeSessions))
      .toEqual([500, 20])
  })

  it('is total — a createdAt tie falls back to id so the order is never ambiguous', () => {
    const b = { id: 'b', recordedOn: '2026-03-01', cumulativeSessions: 2, createdAt: new Date('2026-03-01T09:00:00Z') }
    const a = { id: 'a', recordedOn: '2026-03-01', cumulativeSessions: 1, createdAt: new Date('2026-03-01T09:00:00Z') }
    expect(chronologicalUsageOrder([b, a]).map((x) => x.id)).toEqual(['a', 'b'])
    expect(chronologicalUsageOrder([a, b]).map((x) => x.id)).toEqual(['a', 'b'])
  })

  it('does not mutate its input', () => {
    const input = [r('2026-03-01', 300), r('2026-01-01', 100)]
    const snapshot = input.map((x) => x.id)
    chronologicalUsageOrder(input)
    expect(input.map((x) => x.id)).toEqual(snapshot)
  })
})

describe('deriveUsageSeries — the first-ever reading', () => {
  it('is never a reset and opens segment 0', () => {
    const [only] = deriveUsageSeries([r('2026-01-01', 120)])
    expect(only.isReset).toBe(false)
    expect(only.segmentIndex).toBe(0)
    expect(only.delta).toBe(0)
    expect(only.totalSessions).toBe(120)
  })

  it('handles an empty series', () => {
    expect(deriveUsageSeries([])).toEqual([])
  })

  it('treats a first reading of 0 as a real reading, not a missing one', () => {
    const [only] = deriveUsageSeries([r('2026-01-01', 0)])
    expect(only.isReset).toBe(false)
    expect(only.totalSessions).toBe(0)
  })
})

describe('deriveUsageSeries — ordinary growth', () => {
  it('accumulates deltas and keeps everything in one segment', () => {
    const series = deriveUsageSeries([
      r('2026-01-01', 100), r('2026-02-01', 150), r('2026-03-01', 400),
    ])
    expect(series.map((x) => x.delta)).toEqual([0, 50, 250])
    expect(series.map((x) => x.totalSessions)).toEqual([100, 150, 400])
    expect(series.every((x) => x.segmentIndex === 0)).toBe(true)
    expect(series.some((x) => x.isReset)).toBe(false)
  })
})

describe('deriveUsageSeries — equal readings', () => {
  it('an unchanged counter is NOT a reset (the rule is strictly lower)', () => {
    const series = deriveUsageSeries([
      r('2026-01-01', 100), r('2026-02-01', 100), r('2026-03-01', 100),
    ])
    expect(series.map((x) => x.isReset)).toEqual([false, false, false])
    expect(series.map((x) => x.delta)).toEqual([0, 0, 0])
    expect(series.map((x) => x.segmentIndex)).toEqual([0, 0, 0])
    expect(series[2].totalSessions).toBe(100)
  })
})

describe('deriveUsageSeries — a counter reset', () => {
  it('flags the reading that came back lower, and opens a new segment', () => {
    const series = deriveUsageSeries([
      r('2026-01-01', 500), r('2026-02-01', 20),
    ])
    expect(series.map((x) => x.isReset)).toEqual([false, true])
    expect(series.map((x) => x.segmentIndex)).toEqual([0, 1])
  })

  it('accepts the reading rather than rejecting it — the counter really did reset', () => {
    const series = deriveUsageSeries([r('2026-01-01', 500), r('2026-02-01', 20)])
    expect(series).toHaveLength(2)
    expect(series[1].cumulativeSessions).toBe(20)
  })

  it('records no delta across the reset boundary — the lost sessions are unknowable', () => {
    const series = deriveUsageSeries([r('2026-01-01', 500), r('2026-02-01', 20)])
    expect(series[1].delta).toBe(0)
  })

  it('carries the pre-reset total forward, so the lifetime total never goes backwards', () => {
    const series = deriveUsageSeries([r('2026-01-01', 500), r('2026-02-01', 20)])
    expect(series[1].totalSessions).toBe(520)
    expect(series[1].sessionsInSegment).toBe(20)
  })

  it('a reset to exactly 0 is still a reset', () => {
    const series = deriveUsageSeries([r('2026-01-01', 500), r('2026-02-01', 0)])
    expect(series[1].isReset).toBe(true)
    expect(series[1].totalSessions).toBe(500)
  })
})

describe('deriveUsageSeries — a reset followed by growth', () => {
  const series = deriveUsageSeries([
    r('2026-01-01', 500), r('2026-02-01', 20), r('2026-03-01', 90), r('2026-04-01', 130),
  ])

  it('flags only the reset reading, not the growth after it', () => {
    expect(series.map((x) => x.isReset)).toEqual([false, true, false, false])
  })

  it('keeps every post-reset reading in the new segment', () => {
    expect(series.map((x) => x.segmentIndex)).toEqual([0, 1, 1, 1])
  })

  it('measures deltas within the new segment', () => {
    expect(series.map((x) => x.delta)).toEqual([0, 0, 70, 40])
  })

  it('totals across segments as a lower bound on lifetime sessions', () => {
    expect(series.map((x) => x.totalSessions)).toEqual([500, 520, 590, 630])
  })

  it('reports cumulative-since-reset separately from the lifetime total', () => {
    expect(series.map((x) => x.sessionsInSegment)).toEqual([500, 20, 90, 130])
  })

  it('handles two resets in one life', () => {
    const twice = deriveUsageSeries([
      r('2026-01-01', 500), r('2026-02-01', 20), r('2026-03-01', 5),
    ])
    expect(twice.map((x) => x.isReset)).toEqual([false, true, true])
    expect(twice.map((x) => x.segmentIndex)).toEqual([0, 1, 2])
    expect(twice[2].totalSessions).toBe(525)
  })
})

describe('deriveUsageSeries — out-of-order recorded_on insertion', () => {
  // THE case the derived-at-read-time design exists for. A backdated reading is
  // appended to an append-only table long after the rows it now sits between.
  it('sorts a backdated reading into place before deriving anything', () => {
    const series = deriveUsageSeries([
      r('2026-01-01', 100, '2026-01-01T00:00:00Z'),
      r('2026-03-01', 300, '2026-03-01T00:00:00Z'),
      r('2026-02-01', 200, '2026-09-09T00:00:00Z'), // entered last, dated in between
    ])
    expect(series.map((x) => x.recordedOn)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01'])
    expect(series.map((x) => x.cumulativeSessions)).toEqual([100, 200, 300])
    expect(series.some((x) => x.isReset)).toBe(false)
  })

  it('a backdated reading can CREATE a reset flag on a row that had none', () => {
    // Before the backfill: 100 → 300, monotonic, nothing flagged.
    const before = deriveUsageSeries([r('2026-01-01', 100), r('2026-03-01', 300)])
    expect(before.map((x) => x.isReset)).toEqual([false, false])

    // A reading dated between them, entered later, showing a higher counter than
    // March: now MARCH is the reset. The flag moved onto a row nobody touched —
    // which is exactly why it must not be a stored column.
    const after = deriveUsageSeries([
      r('2026-01-01', 100, '2026-01-01T00:00:00Z'),
      r('2026-03-01', 300, '2026-03-01T00:00:00Z'),
      r('2026-02-01', 900, '2026-09-09T00:00:00Z'),
    ])
    expect(after.map((x) => x.recordedOn)).toEqual(['2026-01-01', '2026-02-01', '2026-03-01'])
    expect(after.map((x) => x.isReset)).toEqual([false, false, true])
  })

  it('a backdated reading can REMOVE a reset flag from a row that had one', () => {
    // 500 → 20 reads as a reset on its own.
    const before = deriveUsageSeries([r('2026-01-01', 500), r('2026-03-01', 20)])
    expect(before[1].isReset).toBe(true)

    // Insert a January-dated 10 entered later. Chronologically it is 500 (Jan 1),
    // 10 (Jan 15), 20 (Mar 1) — so the reset is now the January row and March is
    // ordinary growth.
    const after = deriveUsageSeries([
      r('2026-01-01', 500, '2026-01-01T00:00:00Z'),
      r('2026-03-01', 20, '2026-03-01T00:00:00Z'),
      r('2026-01-15', 10, '2026-09-09T00:00:00Z'),
    ])
    expect(after.map((x) => x.recordedOn)).toEqual(['2026-01-01', '2026-01-15', '2026-03-01'])
    expect(after.map((x) => x.isReset)).toEqual([false, true, false])
    expect(after[2].delta).toBe(10)
  })

  it('derives the same answer whatever order the rows arrive in', () => {
    const rows = [
      r('2026-01-01', 500, '2026-01-01T00:00:00Z'),
      r('2026-02-01', 20, '2026-02-01T00:00:00Z'),
      r('2026-03-01', 90, '2026-03-01T00:00:00Z'),
    ]
    const forward = deriveUsageSeries(rows).map((x) => `${x.id}:${x.isReset}:${x.totalSessions}`)
    const backward = deriveUsageSeries([...rows].reverse())
      .map((x) => `${x.id}:${x.isReset}:${x.totalSessions}`)
    expect(backward).toEqual(forward)
  })
})

describe('summarizeUsage', () => {
  it('is empty for a device with no readings', () => {
    const s = summarizeUsage([])
    expect(s.latest).toBeNull()
    expect(s.readingCount).toBe(0)
    expect(s.resetCount).toBe(0)
    expect(s.totalSessions).toBe(0)
    expect(s.currentCounter).toBeNull()
    expect(s.latestRecordedOn).toBeNull()
    expect(s.hasReset).toBe(false)
    expect(s.sessionsSinceReset).toBe(0)
  })

  it('takes latest from max(recorded_on), not from insertion order', () => {
    const s = summarizeUsage([
      r('2026-03-01', 300, '2026-03-01T00:00:00Z'),
      r('2026-01-01', 100, '2026-09-09T00:00:00Z'), // entered last, dated first
    ])
    expect(s.latestRecordedOn).toBe('2026-03-01')
    expect(s.currentCounter).toBe(300)
  })

  it('counts resets and reports the lifetime lower bound', () => {
    const s = summarizeUsage([
      r('2026-01-01', 500), r('2026-02-01', 20), r('2026-03-01', 90),
    ])
    expect(s.readingCount).toBe(3)
    expect(s.resetCount).toBe(1)
    expect(s.hasReset).toBe(true)
    expect(s.totalSessions).toBe(590)
    expect(s.currentCounter).toBe(90)
  })

  it('reports cumulative-since-reset, which is the counter itself after a reset', () => {
    const s = summarizeUsage([
      r('2026-01-01', 500), r('2026-02-01', 20), r('2026-03-01', 90),
    ])
    expect(s.sessionsSinceReset).toBe(90)
  })

  it('with no reset, sessions-since-reset equals the whole life', () => {
    const s = summarizeUsage([r('2026-01-01', 100), r('2026-02-01', 400)])
    expect(s.sessionsSinceReset).toBe(400)
    expect(s.totalSessions).toBe(400)
    expect(s.hasReset).toBe(false)
  })
})

describe('classifyNewReading — the write-path warning', () => {
  it('classifies the first reading for a device', () => {
    expect(classifyNewReading(null, 120)).toEqual({ kind: 'first' })
  })

  it('classifies growth', () => {
    expect(classifyNewReading(500, 620)).toEqual({ kind: 'increase', delta: 120 })
  })

  it('classifies an unchanged counter', () => {
    expect(classifyNewReading(500, 500)).toEqual({ kind: 'unchanged' })
  })

  it('classifies a lower reading as a reset, ACCEPTED with a warning', () => {
    const c = classifyNewReading(500, 20)
    expect(c.kind).toBe('reset')
    // Accepted, not refused — the physical counter reset. The service must not
    // treat this as a validation failure.
    expect(c).toMatchObject({ kind: 'reset', previous: 500, next: 20 })
  })
})

describe('daysSinceLastReading — injectable today', () => {
  it('is null when the device has never been read', () => {
    expect(daysSinceLastReading(null, new Date('2026-08-03T00:00:00Z'))).toBeNull()
  })

  it('counts whole days from the reading date to today', () => {
    expect(daysSinceLastReading('2026-08-01', new Date('2026-08-03T00:00:00Z'))).toBe(2)
    expect(daysSinceLastReading('2026-08-03', new Date('2026-08-03T00:00:00Z'))).toBe(0)
  })

  it('ignores the time of day on `today` rather than reporting a fractional day', () => {
    expect(daysSinceLastReading('2026-08-01', new Date('2026-08-03T23:59:00Z'))).toBe(2)
  })

  it('never returns a negative age for a future-dated reading', () => {
    expect(daysSinceLastReading('2026-09-01', new Date('2026-08-03T00:00:00Z'))).toBe(0)
  })
})
