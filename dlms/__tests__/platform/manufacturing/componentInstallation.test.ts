import { describe, it, expect } from 'vitest'
import {
  currentInstallations, historyForSlot, assertReplacementShape, InvalidReplacementError,
} from '@/modules/manufacturing/domain/componentInstallation'

const row = (over = {}) => ({
  id: 'i1', componentTypeId: 't1', componentUnitId: 'u1', batchNo: null,
  slotNo: 1, installedAt: new Date('2026-01-01'), removedAt: null, ...over,
})

describe('currentInstallations', () => {
  it('returns only rows with no removal date', () => {
    const rows = [row({ id: 'a' }), row({ id: 'b', removedAt: new Date('2026-02-01') })]
    expect(currentInstallations(rows).map((r) => r.id)).toEqual(['a'])
  })
  it('is empty when everything has been removed', () => {
    expect(currentInstallations([row({ removedAt: new Date() })])).toEqual([])
  })
})

describe('historyForSlot', () => {
  it('returns that type+slot newest-first', () => {
    const rows = [
      row({ id: 'old', installedAt: new Date('2026-01-01'), removedAt: new Date('2026-03-01') }),
      row({ id: 'new', installedAt: new Date('2026-03-01') }),
      row({ id: 'other', componentTypeId: 't2' }),
    ]
    expect(historyForSlot(rows, 't1', 1).map((r) => r.id)).toEqual(['new', 'old'])
  })
})

describe('assertReplacementShape', () => {
  it('accepts a serialized swap to a different unit', () => {
    expect(() => assertReplacementShape({
      trackingMode: 'serialized', removingUnitId: 'u1', replacementUnitId: 'u2',
      replacementBatchNo: null,
    })).not.toThrow()
  })
  it('rejects a serialized replacement with no unit', () => {
    expect(() => assertReplacementShape({
      trackingMode: 'serialized', removingUnitId: 'u1', replacementUnitId: null,
      replacementBatchNo: null,
    })).toThrow(InvalidReplacementError)
  })
  it('rejects reusing the very unit being removed', () => {
    expect(() => assertReplacementShape({
      trackingMode: 'serialized', removingUnitId: 'u1', replacementUnitId: 'u1',
      replacementBatchNo: null,
    })).toThrow(InvalidReplacementError)
  })
  it('accepts a batch replacement with a batch number', () => {
    expect(() => assertReplacementShape({
      trackingMode: 'batch', removingUnitId: null, replacementUnitId: null,
      replacementBatchNo: 'LOT-9',
    })).not.toThrow()
  })
  it('rejects a batch replacement with no batch number', () => {
    expect(() => assertReplacementShape({
      trackingMode: 'batch', removingUnitId: null, replacementUnitId: null,
      replacementBatchNo: null,
    })).toThrow(InvalidReplacementError)
  })
})
