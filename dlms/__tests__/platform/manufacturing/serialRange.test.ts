import { describe, it, expect } from 'vitest'
import { expandSerialRange, pairSerialRanges } from '@/modules/manufacturing/domain/serialRange'

describe('expandSerialRange', () => {
  it('returns no serials for blank input', () => {
    expect(expandSerialRange('')).toEqual({ serials: [] })
    expect(expandSerialRange(null)).toEqual({ serials: [] })
  })
  it('returns a single normalized serial when there is no range', () => {
    expect(expandSerialRange(' ee-02a-2603-0001 ')).toEqual({ serials: ['EE-02A-2603-0001'] })
  })
  it('expands a range, zero-padding to the widest endpoint', () => {
    const r = expandSerialRange('EE-02A-2603-0008 to 0011')
    expect(r).toEqual({ serials: [
      'EE-02A-2603-0008', 'EE-02A-2603-0009', 'EE-02A-2603-0010', 'EE-02A-2603-0011',
    ] })
  })
  it('rejects ambiguous notation rather than guessing', () => {
    expect(expandSerialRange('SN-1 and SN-2')).toEqual({
      error: 'SN-1 and SN-2 cannot be auto-expanded — fix this row manually' })
    expect(expandSerialRange('SN-1, SN-2')).toHaveProperty('error')
    expect(expandSerialRange('SN-1 & SN-2')).toHaveProperty('error')
  })
  it('rejects a backwards range', () => {
    expect(expandSerialRange('SN-0010 to 0002')).toEqual({
      error: 'Range end (2) < start (10) in: SN-0010 to 0002' })
  })
  it('rejects an absurdly large range', () => {
    expect(expandSerialRange('SN-0001 to 6000')).toEqual({
      error: 'Range too large (6000 units) — fix this row manually' })
  })
})

describe('pairSerialRanges', () => {
  it('pairs each A serial with null when B is absent', () => {
    expect(pairSerialRanges('A-0001 to 0002', null)).toEqual({ units: [
      { pcbaA: 'A-0001', pcbaB: null },
      { pcbaA: 'A-0002', pcbaB: null },
    ] })
  })
  it('zips A and B in lockstep', () => {
    expect(pairSerialRanges('A-0001 to 0002', 'B-0007 to 0008')).toEqual({ units: [
      { pcbaA: 'A-0001', pcbaB: 'B-0007' },
      { pcbaA: 'A-0002', pcbaB: 'B-0008' },
    ] })
  })
  it('refuses to pair mismatched counts', () => {
    expect(pairSerialRanges('A-0001 to 0003', 'B-0007 to 0008')).toEqual({
      error: 'PCBA-A (3) and PCBA-B (2) counts differ — fix this row manually' })
  })
  it('returns no units when A is blank', () => {
    expect(pairSerialRanges('', 'B-0001')).toEqual({ units: [] })
  })
  it('propagates an A error unprefixed and a B error prefixed', () => {
    expect(pairSerialRanges('A-1 and A-2', null)).toHaveProperty(
      'error', 'A-1 and A-2 cannot be auto-expanded — fix this row manually')
    expect(pairSerialRanges('A-0001', 'B-1 and B-2')).toHaveProperty(
      'error', 'PCBA-B: B-1 and B-2 cannot be auto-expanded — fix this row manually')
  })
})
