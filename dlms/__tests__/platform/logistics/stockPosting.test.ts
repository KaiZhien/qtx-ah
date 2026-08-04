// __tests__/platform/logistics/stockPosting.test.ts
//
// The pure half of the receive-posting logic. The lock-ordering assertions in
// "deterministic lock ordering" below are the reason this module exists as a
// separate pure function at all — see modules/logistics/domain/stockPosting.ts.
import { describe, it, expect } from 'vitest'
import {
  planStockPosting, lockKeyOf, compareLockKeys, toScaledQty, fromScaledQty,
  StockPostingError,
} from '@/modules/logistics/domain/stockPosting'

// Fixed uuid-ish ids chosen so lexicographic order is obvious by eye.
const LOC_A = 'aaaaaaaa-0000-0000-0000-000000000001'
const LOC_B = 'bbbbbbbb-0000-0000-0000-000000000002'
const TYPE_X = '11111111-0000-0000-0000-00000000000x'.replace('x', '1')
const TYPE_Y = '22222222-0000-0000-0000-000000000002'
const UNIT_1 = 'cccccccc-0000-0000-0000-000000000001'
const UNIT_2 = 'dddddddd-0000-0000-0000-000000000002'

const base = {
  fromLocationId: LOC_A,
  toLocationId: LOC_B,
  batchLines: [] as { componentTypeId: string; qty: number }[],
  serializedLines: [] as { componentUnitId: string }[],
}

describe('toScaledQty / fromScaledQty', () => {
  it('scales to integer thousandths so aggregation is exact, not floating point', () => {
    expect(toScaledQty(1)).toBe(1000)
    expect(toScaledQty(0.001)).toBe(1)
    expect(toScaledQty(12.345)).toBe(12345)
  })

  it('round-trips back to a fixed(3) string for the numeric column', () => {
    expect(fromScaledQty(1000)).toBe('1.000')
    expect(fromScaledQty(12345)).toBe('12.345')
    expect(fromScaledQty(0)).toBe('0.000')
  })

  it('rejects a quantity finer than the numeric(14,3) column can hold', () => {
    expect(() => toScaledQty(0.0001)).toThrow(StockPostingError)
    expect(() => toScaledQty(1.23456)).toThrow(/three decimal places/i)
  })

  it('accepts large 3-dp values across the whole schema-permitted range', () => {
    // Regression: scaling by `qty * 1000` and testing an ABSOLUTE 1e-6
    // tolerance made representation error grow with magnitude, so this exact
    // value — three decimal places, well inside the schema's max of 99999999 —
    // was rejected as "more than three decimal places". Scaling from the
    // decimal STRING has no magnitude sensitivity at all.
    expect(toScaledQty(16777216.001)).toBe(16777216001)
    expect(toScaledQty(99999999)).toBe(99999999000)
    expect(toScaledQty(99999999.999)).toBe(99999999999)
    expect(fromScaledQty(toScaledQty(16777216.001))).toBe('16777216.001')
  })

  it('round-trips every 3-dp value it accepts, at any magnitude', () => {
    for (const q of [0.001, 0.5, 1.005, 999.999, 1048576.001, 16777216.001, 33554432.007]) {
      expect(fromScaledQty(toScaledQty(q))).toBe(q.toFixed(3))
    }
  })

  it('rejects a value too large to scale exactly as an integer', () => {
    expect(() => toScaledQty(1e15)).toThrow(/range/i)
  })

  it('rejects non-finite quantities', () => {
    expect(() => toScaledQty(Number.NaN)).toThrow(StockPostingError)
    expect(() => toScaledQty(Number.POSITIVE_INFINITY)).toThrow(StockPostingError)
  })

  it('aggregates the classic 0.1 + 0.2 case exactly', () => {
    // 0.1 + 0.2 === 0.30000000000000004 in float; scaled ints give 300 -> "0.300".
    expect(fromScaledQty(toScaledQty(0.1) + toScaledQty(0.2))).toBe('0.300')
  })
})

describe('planStockPosting — batch aggregation', () => {
  it('produces a matched decrement at source and increment at destination', () => {
    const plan = planStockPosting({ ...base, batchLines: [{ componentTypeId: TYPE_X, qty: 5 }] })
    expect(plan.decrements).toEqual([
      { locationId: LOC_A, componentTypeId: TYPE_X, scaledQty: 5000 },
    ])
    expect(plan.increments).toEqual([
      { locationId: LOC_B, componentTypeId: TYPE_X, scaledQty: 5000 },
    ])
  })

  it('aggregates repeated lines of the same component type into ONE movement', () => {
    // Two lines of 3 and 4 must decrement the source by 7 once — not twice,
    // which would take the same row lock twice and check the floor twice
    // against a half-applied balance.
    const plan = planStockPosting({
      ...base,
      batchLines: [{ componentTypeId: TYPE_X, qty: 3 }, { componentTypeId: TYPE_X, qty: 4 }],
    })
    expect(plan.decrements).toHaveLength(1)
    expect(plan.decrements[0].scaledQty).toBe(7000)
    expect(plan.increments).toHaveLength(1)
    expect(plan.increments[0].scaledQty).toBe(7000)
  })

  it('keeps distinct component types as separate movements', () => {
    const plan = planStockPosting({
      ...base,
      batchLines: [{ componentTypeId: TYPE_Y, qty: 1 }, { componentTypeId: TYPE_X, qty: 2 }],
    })
    expect(plan.decrements).toHaveLength(2)
    expect(new Set(plan.decrements.map((d) => d.componentTypeId))).toEqual(new Set([TYPE_X, TYPE_Y]))
  })

  it('rejects a non-positive quantity', () => {
    expect(() => planStockPosting({ ...base, batchLines: [{ componentTypeId: TYPE_X, qty: 0 }] }))
      .toThrow(StockPostingError)
    expect(() => planStockPosting({ ...base, batchLines: [{ componentTypeId: TYPE_X, qty: -1 }] }))
      .toThrow(StockPostingError)
  })

  it('rejects a transfer whose source and destination are the same location', () => {
    expect(() => planStockPosting({
      ...base, toLocationId: LOC_A, batchLines: [{ componentTypeId: TYPE_X, qty: 1 }],
    })).toThrow(/same location/i)
  })

  it('rejects a transfer with no lines at all', () => {
    expect(() => planStockPosting({ ...base })).toThrow(/at least one line/i)
  })
})

describe('planStockPosting — serialized lines', () => {
  it('collects the unit ids and posts NO stock_level movement for them', () => {
    // A serialized unit's location is component_unit.location_id. Counting it
    // in stock_level too would create two disagreeing sources of truth.
    const plan = planStockPosting({
      ...base, serializedLines: [{ componentUnitId: UNIT_2 }, { componentUnitId: UNIT_1 }],
    })
    expect(plan.decrements).toEqual([])
    expect(plan.increments).toEqual([])
    expect(plan.serializedUnitIds).toEqual([UNIT_1, UNIT_2]) // sorted
  })

  it('rejects the same unit appearing twice in one transfer', () => {
    expect(() => planStockPosting({
      ...base, serializedLines: [{ componentUnitId: UNIT_1 }, { componentUnitId: UNIT_1 }],
    })).toThrow(/more than once/i)
  })

  it('handles a mixed batch + serialized transfer', () => {
    const plan = planStockPosting({
      ...base,
      batchLines: [{ componentTypeId: TYPE_X, qty: 2 }],
      serializedLines: [{ componentUnitId: UNIT_1 }],
    })
    expect(plan.decrements).toHaveLength(1)
    expect(plan.serializedUnitIds).toEqual([UNIT_1])
  })
})

describe('planStockPosting — deterministic lock ordering (LOAD-BEARING)', () => {
  it('covers every touched (location, component_type) pair exactly once', () => {
    const plan = planStockPosting({
      ...base,
      batchLines: [{ componentTypeId: TYPE_X, qty: 1 }, { componentTypeId: TYPE_X, qty: 1 },
                   { componentTypeId: TYPE_Y, qty: 1 }],
    })
    // 2 types x 2 locations = 4 distinct rows to lock.
    expect(plan.lockKeys).toHaveLength(4)
    const seen = plan.lockKeys.map(lockKeyOf)
    expect(new Set(seen).size).toBe(4)
  })

  it('sorts lock keys by (locationId, componentTypeId)', () => {
    const plan = planStockPosting({
      ...base,
      batchLines: [{ componentTypeId: TYPE_Y, qty: 1 }, { componentTypeId: TYPE_X, qty: 1 }],
    })
    expect(plan.lockKeys).toEqual([
      { locationId: LOC_A, componentTypeId: TYPE_X },
      { locationId: LOC_A, componentTypeId: TYPE_Y },
      { locationId: LOC_B, componentTypeId: TYPE_X },
      { locationId: LOC_B, componentTypeId: TYPE_Y },
    ])
  })

  it('THE DEADLOCK TEST: A->B and B->A yield the SAME lock order', () => {
    // Two concurrent transfers moving the same component type in opposite
    // directions between the same pair of locations. If each locked its own
    // source first, tx1 would hold (A,X) waiting on (B,X) while tx2 holds
    // (B,X) waiting on (A,X) — a textbook deadlock, and Postgres would abort
    // one of them at random under production load.
    //
    // Sorting globally means BOTH transactions take (A,X) before (B,X), so the
    // second simply waits. Deleting the sort makes this test fail.
    const aToB = planStockPosting({
      fromLocationId: LOC_A, toLocationId: LOC_B,
      batchLines: [{ componentTypeId: TYPE_X, qty: 1 }], serializedLines: [],
    })
    const bToA = planStockPosting({
      fromLocationId: LOC_B, toLocationId: LOC_A,
      batchLines: [{ componentTypeId: TYPE_X, qty: 1 }], serializedLines: [],
    })
    expect(aToB.lockKeys.map(lockKeyOf)).toEqual(bToA.lockKeys.map(lockKeyOf))
  })

  it('lock order does not depend on the order the lines were entered', () => {
    const forward = planStockPosting({
      ...base,
      batchLines: [{ componentTypeId: TYPE_X, qty: 1 }, { componentTypeId: TYPE_Y, qty: 1 }],
    })
    const reversed = planStockPosting({
      ...base,
      batchLines: [{ componentTypeId: TYPE_Y, qty: 1 }, { componentTypeId: TYPE_X, qty: 1 }],
    })
    expect(forward.lockKeys.map(lockKeyOf)).toEqual(reversed.lockKeys.map(lockKeyOf))
  })

  it('sorts serialized unit ids too — they are the second lock class', () => {
    // Global rule: ALL stock_level rows (sorted), THEN all component_unit rows
    // (sorted). Two lock classes, one total order across both.
    const plan = planStockPosting({
      ...base,
      serializedLines: [{ componentUnitId: UNIT_2 }, { componentUnitId: UNIT_1 }],
    })
    expect(plan.serializedUnitIds).toEqual([...plan.serializedUnitIds].sort())
  })

  it('compareLockKeys is a total order (antisymmetric and transitive on ties)', () => {
    const k1 = { locationId: LOC_A, componentTypeId: TYPE_X }
    const k2 = { locationId: LOC_A, componentTypeId: TYPE_Y }
    const k3 = { locationId: LOC_B, componentTypeId: TYPE_X }
    expect(compareLockKeys(k1, k2)).toBeLessThan(0)
    expect(compareLockKeys(k2, k1)).toBeGreaterThan(0)
    expect(compareLockKeys(k1, { ...k1 })).toBe(0)
    expect(compareLockKeys(k1, k3)).toBeLessThan(0)
    expect(compareLockKeys(k2, k3)).toBeLessThan(0) // location dominates component type
  })
})
