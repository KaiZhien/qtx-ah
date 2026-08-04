// __tests__/engineering/bomEffectivity.test.ts
//
// The BOM effectivity resolver, written first. Effectivity has TWO independent
// axes (calendar date and build serial) and an ECO may carry either or both, so
// the precedence rule between them is the whole design — it is pinned here
// before any SQL exists that could quietly imply a different one.
import { describe, it, expect } from 'vitest'
import {
  serialSortKey, serialAxisVerdict, dateAxisVerdict, lineAppliesAt,
  resolveBomAt, findBomEffectivityConflicts, findUnderdeterminedLines,
  serialOnlyBounds, closesBeforeItOpened, isUsableEffectivityPoint,
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

  it('breaks a MIXED-AXIS tie on the serial axis — the same order as the precedence rule', () => {
    // This is the shape a serial-only ECO leaves behind: the superseded line is
    // dated and serial-unbounded, the successor is serial-bounded and dateless
    // (from = null = "beginning of time"). Ask without a serial and BOTH look
    // effective. Comparing the date start first would pick the SUPERSEDED line —
    // the serial start has to win, exactly as it does in lineAppliesAt.
    const supersededBySerial = [
      line({ id: 'old', effectiveFromDate: '2026-06-01', effectiveToSerial: 'QTX-P-00500' }),
      line({ id: 'new', effectiveFromDate: null, effectiveFromSerial: 'QTX-P-00500', quantity: 7 }),
    ]
    const got = resolveBomAt(supersededBySerial, { date: '2030-01-01' })
    expect(got.map((l) => l.id)).toEqual(['new'])
    expect(resolveBomAt([...supersededBySerial].reverse(), { date: '2030-01-01' }).map((l) => l.id))
      .toEqual(['new'])
    // …and it is reported as ambiguous rather than silently resolved.
    expect(findBomEffectivityConflicts(supersededBySerial, { date: '2030-01-01' }))
      .toEqual([{ componentTypeId: 'ct-a', lineIds: ['old', 'new'] }])
    // Supplying the serial removes the ambiguity entirely.
    expect(findBomEffectivityConflicts(supersededBySerial, { date: '2030-01-01', serial: 'QTX-P-00600' }))
      .toEqual([])
  })

  it('never invents a CROSS-FAMILY serial ordering when breaking a tie', () => {
    // serialAxisVerdict refuses to order 'QTX-B-00900' against 'QTX-P-00100'
    // forty lines earlier — different prefix families, and comparing the digit
    // runs alone would say the B-family line starts 800 units later. The
    // tie-break must refuse the same comparison and fall through to the date.
    const crossFamily = [
      line({ id: 'b', effectiveFromSerial: 'QTX-B-00900', effectiveFromDate: '2026-01-01' }),
      line({ id: 'p', effectiveFromSerial: 'QTX-P-00100', effectiveFromDate: '2026-06-01' }),
    ]
    expect(resolveBomAt(crossFamily, { date: '2030-01-01' }).map((l) => l.id)).toEqual(['p'])
    expect(resolveBomAt([...crossFamily].reverse(), { date: '2030-01-01' }).map((l) => l.id))
      .toEqual(['p'])
  })

  it('still ranks a serial-bounded start above an unbounded one, family or not', () => {
    // An ABSENT lower bound is "since the beginning of time" on both axes, so it
    // loses to any present one — this is the mixed-axis rule above and it must
    // survive the cross-family refusal.
    const mixed = [
      line({ id: 'unbounded', effectiveFromDate: '2026-06-01' }),
      line({ id: 'bounded', effectiveFromSerial: 'QTX-B-00900' }),
    ]
    expect(resolveBomAt(mixed, { date: '2030-01-01' }).map((l) => l.id)).toEqual(['bounded'])
    expect(resolveBomAt([...mixed].reverse(), { date: '2030-01-01' }).map((l) => l.id))
      .toEqual(['bounded'])
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

  // The hole findBomEffectivityConflicts cannot see, and why the sibling below
  // exists: it counts lines per component type, so a disposition that leaves
  // exactly ONE line is invisible to it however wrong that line's verdict is.
  it('is blind to a single serial-bounded line, however wrong the date answer is', () => {
    const removedAtASerial = [line({ id: 'bead', effectiveToSerial: 'QTX-P-00500' })]
    expect(findBomEffectivityConflicts(removedAtASerial, { date: '2030-01-01' })).toEqual([])
  })
})

describe('serialOnlyBounds', () => {
  it('names a bound that exists on the serial axis and NOT on the date axis', () => {
    expect(serialOnlyBounds(line({ id: 'l', effectiveToSerial: 'QTX-P-00500' })))
      .toEqual({ from: null, to: 'QTX-P-00500' })
    expect(serialOnlyBounds(line({ id: 'l', effectiveFromSerial: 'QTX-P-00500' })))
      .toEqual({ from: 'QTX-P-00500', to: null })
  })

  it('is empty when the same edge also carries a date bound — the date was stated', () => {
    expect(serialOnlyBounds(line({
      id: 'l', effectiveFromSerial: 'QTX-P-00500', effectiveFromDate: '2026-06-01',
    }))).toEqual({ from: null, to: null })
  })

  it('judges the two edges independently', () => {
    // Closed by a serial-only ECO, opened by a date-and-serial one.
    expect(serialOnlyBounds(line({
      id: 'l',
      effectiveFromSerial: 'QTX-P-00100', effectiveFromDate: '2026-01-01',
      effectiveToSerial: 'QTX-P-00500',
    }))).toEqual({ from: null, to: 'QTX-P-00500' })
  })

  it('is empty for a line with no serial bounds at all', () => {
    expect(serialOnlyBounds(line({ id: 'l', effectiveFromDate: '2026-06-01' })))
      .toEqual({ from: null, to: null })
  })
})

/**
 * C1 — a serial-only ECO writes NULL on the date axis for the bound it moves,
 * and dateAxisVerdict then answers 'in' for EVERY date. That is the right answer
 * for a line with no date bounds and the WRONG answer for a line whose real
 * bound sits on the other axis. ALL THREE dispositions leave that shape, but
 * only `change` leaves TWO lines — so the overlap detector catches one case in
 * three and the other two are silent.
 *
 * The fix is NOT to invent a date bound at apply time (that would fabricate a
 * calendar claim the engineer never made, on the axis this module documents as
 * "only a proxy"). It is to report the answer as UNDER-DETERMINED, which is what
 * it genuinely is: the honest answer to "what was the BOM on date D" for a
 * per-unit change is "it depends which unit".
 */
describe('findUnderdeterminedLines — the serial-only bound the date axis cannot judge', () => {
  it('REMOVE keyed to a serial: the closed line still reads as effective, forever', () => {
    const removed = [line({ id: 'bead', effectiveToSerial: 'QTX-P-00500' })]
    // The defect, pinned: a date-only question still shows the removed component…
    expect(resolveBomAt(removed, { date: '2030-01-01' }).map((l) => l.id)).toEqual(['bead'])
    // …with one line, so nothing overlaps and the yellow banner never fires…
    expect(findBomEffectivityConflicts(removed, { date: '2030-01-01' })).toEqual([])
    // …which is exactly what this reports instead.
    expect(findUnderdeterminedLines(removed, { date: '2030-01-01' }))
      .toEqual([{ componentTypeId: 'ct-a', lineIds: ['bead'] }])
  })

  it('ADD keyed to a serial: the new line reads as effective years BEFORE the change', () => {
    const added = [line({ id: 'shield', effectiveFromSerial: 'QTX-P-00500' })]
    expect(resolveBomAt(added, { date: '2020-01-01' }).map((l) => l.id)).toEqual(['shield'])
    expect(findBomEffectivityConflicts(added, { date: '2020-01-01' })).toEqual([])
    expect(findUnderdeterminedLines(added, { date: '2020-01-01' }))
      .toEqual([{ componentTypeId: 'ct-a', lineIds: ['shield'] }])
  })

  it('CHANGE keyed to a serial: reports both lines, agreeing with the overlap detector', () => {
    const changed = [
      line({ id: 'old', effectiveFromDate: '2026-06-01', effectiveToSerial: 'QTX-P-00500' }),
      line({ id: 'new', effectiveFromSerial: 'QTX-P-00500', quantity: 7 }),
    ]
    expect(findBomEffectivityConflicts(changed, { date: '2030-01-01' }))
      .toEqual([{ componentTypeId: 'ct-a', lineIds: ['old', 'new'] }])
    expect(findUnderdeterminedLines(changed, { date: '2030-01-01' }))
      .toEqual([{ componentTypeId: 'ct-a', lineIds: ['old', 'new'] }])
  })

  it('a COMPARABLE query serial settles all three — the serial axis decided, so no caveat', () => {
    const removed = [line({ id: 'bead', effectiveToSerial: 'QTX-P-00500' })]
    const added = [line({ id: 'shield', effectiveFromSerial: 'QTX-P-00500' })]
    const at = { date: '2030-01-01', serial: 'QTX-P-00600' }
    expect(findUnderdeterminedLines(removed, at)).toEqual([])
    expect(findUnderdeterminedLines(added, at)).toEqual([])
    // and the answers themselves are now exact
    expect(resolveBomAt(removed, at)).toEqual([])
    expect(resolveBomAt(added, at).map((l) => l.id)).toEqual(['shield'])
  })

  it('an UNCOMPARABLE query serial settles nothing, so the caveat stays', () => {
    // Another prefix family: serialAxisVerdict abstains and the date axis answers
    // — the same guess as with no serial at all, so the same warning.
    const removed = [line({ id: 'bead', effectiveToSerial: 'QTX-P-00500' })]
    expect(findUnderdeterminedLines(removed, { date: '2030-01-01', serial: 'ZZZ-99-00001' }))
      .toEqual([{ componentTypeId: 'ct-a', lineIds: ['bead'] }])
  })

  it('says nothing about a date-keyed change — the ECO made a calendar claim', () => {
    const dated = [
      line({ id: 'old', effectiveToDate: '2026-06-01' }),
      line({ id: 'new', effectiveFromDate: '2026-06-01' }),
    ]
    expect(findUnderdeterminedLines(dated, { date: '2026-07-01' })).toEqual([])
  })

  it('says nothing when the ECO carried BOTH axes — the date bound is stated, not missing', () => {
    const both = [
      line({
        id: 'old', effectiveToDate: '2026-06-01', effectiveToSerial: 'QTX-P-00500',
      }),
      line({
        id: 'new', effectiveFromDate: '2026-06-01', effectiveFromSerial: 'QTX-P-00500',
      }),
    ]
    expect(findUnderdeterminedLines(both, { date: '2026-07-01' })).toEqual([])
  })

  it('reports only lines the answer actually shows', () => {
    // Opened on a date, closed at a serial: BEFORE the from-date the date axis is
    // exact ('out'), so there is nothing to caveat. On and after it, there is.
    const l = line({ id: 'l', effectiveFromDate: '2027-01-01', effectiveToSerial: 'QTX-P-00500' })
    expect(findUnderdeterminedLines([l], { date: '2026-01-01' })).toEqual([])
    expect(findUnderdeterminedLines([l], { date: '2027-01-01' }))
      .toEqual([{ componentTypeId: 'ct-a', lineIds: ['l'] }])
  })

  it('groups by component type and leaves clean types out', () => {
    const mixed = [
      line({ id: 'a1', componentTypeId: 'ct-a', effectiveToSerial: 'QTX-P-00500' }),
      line({ id: 'a2', componentTypeId: 'ct-a', effectiveFromSerial: 'QTX-P-00500' }),
      line({ id: 'b1', componentTypeId: 'ct-b', effectiveFromDate: '2026-01-01' }),
    ]
    expect(findUnderdeterminedLines(mixed, { date: '2030-01-01' }))
      .toEqual([{ componentTypeId: 'ct-a', lineIds: ['a1', 'a2'] }])
  })

  it('is empty for an empty BOM', () => {
    expect(findUnderdeterminedLines([], { date: '2026-01-01' })).toEqual([])
  })
})

/**
 * I4 — ECOs are approved in APPROVAL order, not in effectivity order, so
 * applying one whose point sits BELOW a line's own lower bound is ordinary.
 * The date axis has a CHECK (bom_line_date_window) that turns it into a raw
 * 23514 and a dead-end generic message; the serial axis has none and cannot
 * have one (serials are free text), so the inverted window is simply WRITTEN
 * and the line becomes unreachable at every serial with nothing flagged.
 */
describe('closesBeforeItOpened — the window an out-of-order apply would invert', () => {
  it('is null for a point at or after the line start on both axes', () => {
    const l = line({ id: 'l', effectiveFromDate: '2026-06-01', effectiveFromSerial: 'QTX-P-00300' })
    expect(closesBeforeItOpened(l, { date: '2026-06-02', serial: 'QTX-P-00301' })).toBeNull()
    // Equal is legal: [D, D) is an empty window, which is what two ECOs on the
    // same day legitimately produce.
    expect(closesBeforeItOpened(l, { date: '2026-06-01', serial: 'QTX-P-00300' })).toBeNull()
  })

  it('names the DATE axis when the effectivity date precedes the line start', () => {
    const l = line({ id: 'l', effectiveFromDate: '2026-06-01' })
    expect(closesBeforeItOpened(l, { date: '2026-05-31', serial: null })).toBe('date')
  })

  it('names the SERIAL axis when the effectivity serial precedes the line start', () => {
    // The case the database cannot catch: the line opened at 00500, this ECO is
    // effective at 00300, and [00500, 00300) is accepted without a murmur.
    const l = line({ id: 'l', effectiveFromSerial: 'QTX-P-00500' })
    expect(closesBeforeItOpened(l, { date: null, serial: 'QTX-P-00300' })).toBe('serial')
  })

  it('abstains on an UNCOMPARABLE serial pair rather than inventing an order', () => {
    const l = line({ id: 'l', effectiveFromSerial: 'QTX-B-00900' })
    expect(closesBeforeItOpened(l, { date: null, serial: 'QTX-P-00100' })).toBeNull()
    expect(closesBeforeItOpened(line({ id: 'l', effectiveFromSerial: 'BATCH ONE' }),
      { date: null, serial: 'QTX-P-00100' })).toBeNull()
  })

  it('says nothing about an unbounded line — there is no start to precede', () => {
    expect(closesBeforeItOpened(line({ id: 'l' }), { date: '2020-01-01', serial: 'QTX-P-00001' }))
      .toBeNull()
  })

  it('reports the DATE axis first when both are inverted, so the message is stable', () => {
    const l = line({ id: 'l', effectiveFromDate: '2026-06-01', effectiveFromSerial: 'QTX-P-00500' })
    expect(closesBeforeItOpened(l, { date: '2026-01-01', serial: 'QTX-P-00100' })).toBe('date')
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
