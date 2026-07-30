import { describe, it, expect } from 'vitest'
import { normalizeSerial, parseSheetDate } from '@/modules/manufacturing/domain/sheetValues'

describe('normalizeSerial', () => {
  it('uppercases and trims', () => {
    expect(normalizeSerial('  ee-02a-2603-0001 ')).toBe('EE-02A-2603-0001')
  })
  it('returns empty string for nullish or empty input', () => {
    expect(normalizeSerial(null)).toBe('')
    expect(normalizeSerial(undefined)).toBe('')
    expect(normalizeSerial('')).toBe('')
    expect(normalizeSerial('   ')).toBe('')
  })
})

describe('parseSheetDate', () => {
  it('passes ISO through', () => {
    expect(parseSheetDate('2026-03-14')).toBe('2026-03-14')
  })
  it('converts DD/MM/YYYY to ISO', () => {
    expect(parseSheetDate('14/3/2026')).toBe('2026-03-14')
    expect(parseSheetDate('01/12/2026')).toBe('2026-12-01')
  })
  it('returns null for blank input', () => {
    expect(parseSheetDate(null)).toBeNull()
    expect(parseSheetDate('   ')).toBeNull()
  })
  it('rejects an impossible calendar day', () => {
    expect(() => parseSheetDate('31/02/2026')).toThrow(/day 31 out of range/)
  })
  it('accepts a real leap day and rejects a fake one', () => {
    expect(parseSheetDate('29/02/2024')).toBe('2024-02-29')
    expect(() => parseSheetDate('29/02/2026')).toThrow(/out of range/)
  })
  it('rejects an out-of-range month', () => {
    expect(() => parseSheetDate('01/13/2026')).toThrow(/month 13 out of range/)
  })
  it('rejects an unrecognised format', () => {
    expect(() => parseSheetDate('March 14 2026')).toThrow(/Invalid date format/)
  })
})
