// __tests__/engineering/bomEffectivity.test.ts
//
// The BOM effectivity resolver, written first. Effectivity has TWO independent
// axes (calendar date and build serial) and an ECO may carry either or both, so
// the precedence rule between them is the whole design — it is pinned here
// before any SQL exists that could quietly imply a different one.
import { describe, it, expect } from 'vitest'
import {
  serialSortKey, serialAxisVerdict, dateAxisVerdict, lineAppliesAt,
  resolveBomAt, findBomEffectivityConflicts, isUsableEffectivityPoint,
  type BomLineEffectivity,
} from '@/modules/engineering/domain/bomEffectivity'

// Minimal line factory — every field explicit so a test never depends on a default.
function line(over: Partial<BomLineEffectivity> & { id: string }): BomLineEffectivity {
  return {
    componentTypeId: 'ct-a',
    quantity: 1,
    effectiveFromDate: null,
    effectiveToDate: null,
    effectiveFromSerial: null,
    effectiveToSerial: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  }
}

describe('serialSortKey', () => {
  it('splits a serial into a normalized prefix family and a trailing sequence', () => {
    expect(serialSortKey('QTX-P-00412')).toEqual({ prefix: 'QTXP', seq: 412 })
  })

  it('normalizes case, spaces and hyphens so the same unit compares equal', () => {
    expect(serialSortKey('qtx p 412')).toEqual(serialSortKey('QTX-P-00412'))
  })

  it('handles a bare number', () => {
    expect(serialSortKey('412')).toEqual({ prefix: '', seq: 412 })
  })

  it('returns null when there is no trailing digit run to order by', () => {
    expect(serialSortKey('QTX-PROTO')).toBeNull()
    expect(serialSortKey('')).toBeNull()
    expect(serialSortKey(null)).toBeNull()
    expect(serialSortKey(undefined)).toBeNull()
  })
})

describe('dateAxisVerdict — half-open [from, to)', () => {
  it('an unbounded line is always in', () => {
    expect(dateAxisVerdict(line({ id: 'l' }), '2026-05-05')).toBe('in')
  })

  it('includes the from-date and EXCLUDES the to-date', () => {
    const l = line({ id: 'l', effectiveFromDate: '2026-03-01', effectiveToDate: '2026-09-01' })
    expect(dateAxisVerdict(l, '2026-02-28')).toBe('out')
    expect(dateAxisVerdict(l, '2026-03-01')).toBe('in')
    expect(dateAxisVerdict(l, '2026-08-31')).toBe('in')
    expect(dateAxisVerdict(l, '2026-09-01')).toBe('out') // successor owns this day
  })
})

describe('serialAxisVerdict — half-open [from, to), fail-soft on uncomparable serials', () => {
  it('is unknown when the line carries no serial bound at all', () => {
    expect(serialAxisVerdict(line({ id: 'l' }), 'QTX-P-00412')).toBe('unknown')
  })

  it('includes the from-serial and EXCLUDES the to-serial', () => {
    const l = line({ id: 'l', effectiveFromSerial: 'QTX-P-00100', effectiveToSerial: 'QTX-P-00412' })
    expect(serialAxisVerdict(l, 'QTX-P-00099')).toBe('out')
    expect(serialAxisVerdict(l, 'QTX-P-00100')).toBe('in')
    expect(serialAxisVerdict(l, 'QTX-P-00411')).toBe('in')
    expect(serialAxisVerdict(l, 'QTX-P-00412')).toBe('out')
  })

  it('is unknown — never a guess — when the families differ or either side is unorderable', () => {
    const l = line({ id: 'l', effectiveFromSerial: 'QTX-P-00100' })
    expect(serialAxisVerdict(l, 'QTX-B-00200')).toBe('unknown') // different prefix family
    expect(serialAxisVerdict(l, 'QTX-PROTO')).toBe('unknown')   // query has no sequence
    expect(serialAxisVerdict(line({ id: 'l', effectiveFromSerial: 'BATCH ONE' }), 'QTX-P-00100'))
      .toBe('unknown')                                          // bound has no sequence
  })
})

describe('lineAppliesAt — the precedence rule', () => {
  // The rule: when the query names a serial AND the line carries a comparable
  // serial bound, the SERIAL axis decides. Otherwise the DATE axis decides.
  it('lets the serial axis OVERRIDE the date axis when both are usable', () => {
    // Date says the line is long gone; the serial bound says this specific unit
    // still carries it. The unit-level fact wins.
    const l = line({
      id: 'l',
      effectiveFromDate: '2026-01-01', effectiveToDate: '2026-06-01',
      effectiveFromSerial: 'QTX-P-00100', effectiveToSerial: 'QTX-P-00900',
    })
    expect(dateAxisVerdict(l, '2026-12-31')).toBe('out')
    expect(lineAppliesAt(l, { date: '2026-12-31', serial: 'QTX-P-00500' })).toBe(true)
  })

  it('and overrides in the other direction too', () => {
    const l = line({
      id: 'l',
      effectiveFromDate: '2026-01-01', effectiveToDate: null,
      effectiveFromSerial: 'QTX-P-00100', effectiveToSerial: 'QTX-P-00400',
    })
    expect(dateAxisVerdict(l, '2026-12-31')).toBe('in')
    expect(lineAppliesAt(l, { date: '2026-12-31', serial: 'QTX-P-00900' })).toBe(false)
  })

  it('falls back to the date axis when the line has no serial bound', () => {
    const l = line({ id: 'l', effectiveFromDate: '2026-06-01' })
    expect(lineAppliesAt(l, { date: '2026-05-01', serial: 'QTX-P-00500' })).toBe(false)
    expect(lineAppliesAt(l, { date: '2026-06-01', serial: 'QTX-P-00500' })).toBe(true)
  })

  it('falls back to the date axis when the serials are uncomparable', () => {
    const l = line({ id: 'l', effectiveFromDate: '2026-06-01', effectiveFromSerial: 'QTX-B-00100' })
    expect(lineAppliesAt(l, { date: '2026-07-01', serial: 'QTX-P-00500' })).toBe(true)
  })

  it('uses the date axis when the query names no serial at all', () => {
    const l = line({ id: 'l', effectiveFromSerial: 'QTX-P-00100', effectiveFromDate: '2026-06-01' })
    expect(lineAppliesAt(l, { date: '2026-05-01' })).toBe(false)
    expect(lineAppliesAt(l, { date: '2026-07-01' })).toBe(true)
  })
})

describe('resolveBomAt', () => {
  // One component type superseded by an ECO effective 2026-06-01: the old line is
  // closed on that date, the new one opens on it. Half-open windows mean exactly
  // one is effective on any day — no overlap, no gap.
  const supersededByDate = [
    line({ id: 'old', componentTypeId: 'ct-a', quantity: 1, effectiveToDate: '2026-06-01' }),
    line({ id: 'new', componentTypeId: 'ct-a', quantity: 2, effectiveFromDate: '2026-06-01' }),
  ]

  it('answers "what was the BOM on date D"', () => {
    expect(resolveBomAt(supersededByDate, { date: '2026-05-31' }).map((l) => l.id)).toEqual(['old'])
    expect(resolveBomAt(supersededByDate, { date: '2026-06-01' }).map((l) => l.id)).toEqual(['new'])
  })

  it('answers "what was the BOM at serial S"', () => {
    const bySerial = [
      line({ id: 'old', effectiveToSerial: 'QTX-P-00412' }),
      line({ id: 'new', effectiveFromSerial: 'QTX-P-00412' }),
    ]
    expect(resolveBomAt(bySerial, { date: '2026-01-01', serial: 'QTX-P-00411' }).map((l) => l.id)).toEqual(['old'])
    expect(resolveBomAt(bySerial, { date: '2026-01-01', serial: 'QTX-P-00412' }).map((l) => l.id)).toEqual(['new'])
  })

  it('drops a removed component type entirely once its line is closed', () => {
    const removed = [line({ id: 'gone', componentTypeId: 'ct-z', effectiveToDate: '2026-06-01' })]
    expect(resolveBomAt(removed, { date: '2026-05-31' })).toHaveLength(1)
    expect(resolveBomAt(removed, { date: '2026-06-01' })).toHaveLength(0)
  })

  it('returns at most one line per component type, preserving input order', () => {
    const mixed = [
      line({ id: 'b', componentTypeId: 'ct-b' }),
      ...supersededByDate,
      line({ id: 'c', componentTypeId: 'ct-c' }),
    ]
    const got = resolveBomAt(mixed, { date: '2026-06-02' })
    expect(got.map((l) => l.id)).toEqual(['b', 'new', 'c'])
  })

  it('is deterministic when overlapping windows exist: the latest-starting line wins', () => {
    // The UI must never render a doubled BOM, so the resolver still returns
    // exactly one line — see findBomEffectivityConflicts for surfacing it.
    const overlapping = [
      line({ id: 'early', effectiveFromDate: '2026-01-01', createdAt: '2026-01-01T00:00:00.000Z' }),
      line({ id: 'late', effectiveFromDate: '2026-06-01', createdAt: '2026-06-01T00:00:00.000Z' }),
    ]
    expect(resolveBomAt(overlapping, { date: '2026-12-01' }).map((l) => l.id)).toEqual(['late'])
    // input order must not change the answer
    expect(resolveBomAt([...overlapping].reverse(), { date: '2026-12-01' }).map((l) => l.id)).toEqual(['late'])
  })

  it('treats a null from-bound as the beginning of time, not as the latest start', () => {
    const overlapping = [
      line({ id: 'always', effectiveFromDate: null, createdAt: '2026-09-01T00:00:00.000Z' }),
      line({ id: 'dated', effectiveFromDate: '2026-06-01', createdAt: '2026-01-01T00:00:00.000Z' }),
    ]
    expect(resolveBomAt(overlapping, { date: '2026-12-01' }).map((l) => l.id)).toEqual(['dated'])
  })

  it('is empty for an empty BOM', () => {
    expect(resolveBomAt([], { date: '2026-01-01' })).toEqual([])
  })
})

describe('findBomEffectivityConflicts', () => {
  it('reports nothing for a well-formed BOM', () => {
    const clean = [
      line({ id: 'old', effectiveToDate: '2026-06-01' }),
      line({ id: 'new', effectiveFromDate: '2026-06-01' }),
    ]
    expect(findBomEffectivityConflicts(clean, { date: '2026-07-01' })).toEqual([])
  })

  it('names the component type and every overlapping line so the UI can warn', () => {
    const overlapping = [
      line({ id: 'a', componentTypeId: 'ct-a', effectiveFromDate: '2026-01-01' }),
      line({ id: 'b', componentTypeId: 'ct-a', effectiveFromDate: '2026-06-01' }),
      line({ id: 'c', componentTypeId: 'ct-b' }),
    ]
    expect(findBomEffectivityConflicts(overlapping, { date: '2026-12-01' }))
      .toEqual([{ componentTypeId: 'ct-a', lineIds: ['a', 'b'] }])
  })
})

describe('isUsableEffectivityPoint', () => {
  it('needs at least one axis — an ECO with neither cannot be applied to a BOM', () => {
    expect(isUsableEffectivityPoint({ date: null, serial: null })).toBe(false)
    expect(isUsableEffectivityPoint({ date: null, serial: '   ' })).toBe(false)
    expect(isUsableEffectivityPoint({ date: '2026-06-01', serial: null })).toBe(true)
    expect(isUsableEffectivityPoint({ date: null, serial: 'QTX-P-00412' })).toBe(true)
    expect(isUsableEffectivityPoint({ date: '2026-06-01', serial: 'QTX-P-00412' })).toBe(true)
  })
})
