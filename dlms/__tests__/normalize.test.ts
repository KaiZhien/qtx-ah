import { normalizeSerial, parseSheetDate, coerceQty } from '@/lib/domain/normalize'

describe('normalizeSerial', () => {
  it('uppercases and trims', () => {
    expect(normalizeSerial('  abc-123  ')).toBe('ABC-123')
  })
  it('returns empty string for null', () => {
    expect(normalizeSerial(null)).toBe('')
  })
  it('returns empty string for undefined', () => {
    expect(normalizeSerial(undefined)).toBe('')
  })
  it('returns empty string for empty string', () => {
    expect(normalizeSerial('')).toBe('')
  })
  it('preserves range notation verbatim (uppercased)', () => {
    expect(normalizeSerial('abc001-abc010')).toBe('ABC001-ABC010')
  })
})

describe('parseSheetDate', () => {
  it('parses DD/MM/YYYY to ISO', () => {
    expect(parseSheetDate('25/12/2023')).toBe('2023-12-25')
  })
  it('parses single-digit day and month', () => {
    expect(parseSheetDate('1/3/2024')).toBe('2024-03-01')
  })
  it('passes through YYYY-MM-DD unchanged', () => {
    expect(parseSheetDate('2024-06-15')).toBe('2024-06-15')
  })
  it('returns null for null', () => {
    expect(parseSheetDate(null)).toBeNull()
  })
  it('returns null for empty string', () => {
    expect(parseSheetDate('')).toBeNull()
  })
  it('returns null for whitespace', () => {
    expect(parseSheetDate('   ')).toBeNull()
  })
  it('throws for invalid format', () => {
    expect(() => parseSheetDate('25-12-2023')).toThrow()
  })
  it('throws for month 0', () => {
    expect(() => parseSheetDate('01/00/2024')).toThrow()
  })
  it('throws for month 13', () => {
    expect(() => parseSheetDate('01/13/2024')).toThrow()
  })
  it('throws for day 0', () => {
    expect(() => parseSheetDate('00/06/2024')).toThrow()
  })
  it('throws for day 32 in January', () => {
    expect(() => parseSheetDate('32/01/2024')).toThrow()
  })
  it('throws for Feb 29 on non-leap year', () => {
    expect(() => parseSheetDate('29/02/2023')).toThrow()
  })
  it('accepts Feb 29 on leap year', () => {
    expect(parseSheetDate('29/02/2024')).toBe('2024-02-29')
  })
  it('accepts Feb 28 always', () => {
    expect(parseSheetDate('28/02/2023')).toBe('2023-02-28')
  })
  it('throws for day 31 in April', () => {
    expect(() => parseSheetDate('31/04/2024')).toThrow()
  })
})

describe('coerceQty', () => {
  it('returns integer for integer string', () => {
    expect(coerceQty('10')).toBe(10)
  })
  it('rounds float', () => {
    expect(coerceQty('10.7')).toBe(11)
  })
  it('accepts number input', () => {
    expect(coerceQty(5)).toBe(5)
  })
  it('returns null for null', () => {
    expect(coerceQty(null)).toBeNull()
  })
  it('returns null for undefined', () => {
    expect(coerceQty(undefined)).toBeNull()
  })
  it('returns null for empty string', () => {
    expect(coerceQty('')).toBeNull()
  })
  it('throws for negative', () => {
    expect(() => coerceQty('-1')).toThrow()
  })
  it('throws for non-numeric string', () => {
    expect(() => coerceQty('abc')).toThrow()
  })
  it('accepts zero', () => {
    expect(coerceQty(0)).toBe(0)
  })
})
