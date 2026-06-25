import { expandSerialRange, pairSerialRanges } from '@/lib/domain/serialRange'

describe('expandSerialRange', () => {
  it('returns empty serials for empty string', () => {
    const result = expandSerialRange('')
    expect(result).toEqual({ serials: [] })
  })

  it('returns single serial for single value without "to"', () => {
    const result = expandSerialRange('EE-02A-2603-0001')
    expect(result).toEqual({ serials: ['EE-02A-2603-0001'] })
  })

  it('normalises lowercase serial to uppercase', () => {
    const result = expandSerialRange('ee-02a-2603-0001')
    expect(result).toEqual({ serials: ['EE-02A-2603-0001'] })
  })

  it('expands a contiguous range', () => {
    const result = expandSerialRange('EE-02A-2603-0001 to 0003')
    expect(result).toEqual({
      serials: ['EE-02A-2603-0001', 'EE-02A-2603-0002', 'EE-02A-2603-0003'],
    })
  })

  it('preserves leading-zero padding from start length', () => {
    const result = expandSerialRange('PREFIX-001 to 003')
    expect(result).toEqual({ serials: ['PREFIX-001', 'PREFIX-002', 'PREFIX-003'] })
  })

  it('uses max of start/end width for padding', () => {
    const result = expandSerialRange('PREFIX-9 to 11')
    expect(result).toEqual({ serials: ['PREFIX-09', 'PREFIX-10', 'PREFIX-11'] })
  })

  it('handles single-unit range where start equals end', () => {
    const result = expandSerialRange('EE-0001 to 0001')
    expect(result).toEqual({ serials: ['EE-0001'] })
  })

  it('returns error for " and " notation', () => {
    const result = expandSerialRange('EE-02A-2512-0029 and EE-02A-2512-0031')
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('cannot be auto-expanded')
    }
  })

  it('returns error for comma notation', () => {
    const result = expandSerialRange('EE-001, EE-002')
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('cannot be auto-expanded')
    }
  })

  it('returns error for ampersand notation', () => {
    const result = expandSerialRange('EE-001 & EE-002')
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('cannot be auto-expanded')
    }
  })

  it('returns error for descending range', () => {
    const result = expandSerialRange('EE-0010 to 0005')
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error.toLowerCase()).toMatch(/end.*start|end < start/i)
    }
  })

  it('returns error when count exceeds 5000', () => {
    const result = expandSerialRange('EE-0001 to 9999')
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('9999')
    }
  })
})

describe('pairSerialRanges', () => {
  it('single serial A with no B produces one unit with pcba_b_sn null', () => {
    const result = pairSerialRanges('EE-A-0001', null)
    expect(result).toEqual({ units: [{ pcba_a_sn: 'EE-A-0001', pcba_b_sn: null }] })
  })

  it('range A with no B produces multiple units with pcba_b_sn null', () => {
    const result = pairSerialRanges('EE-A-0001 to 0003', null)
    expect('units' in result).toBe(true)
    if ('units' in result) {
      expect(result.units).toHaveLength(3)
      expect(result.units.every((u) => u.pcba_b_sn === null)).toBe(true)
    }
  })

  it('range A and matching range B produces zipped units', () => {
    const result = pairSerialRanges('EE-A-0001 to 0003', 'EE-B-0001 to 0003')
    expect('units' in result).toBe(true)
    if ('units' in result) {
      expect(result.units).toHaveLength(3)
      expect(result.units[0]).toEqual({ pcba_a_sn: 'EE-A-0001', pcba_b_sn: 'EE-B-0001' })
      expect(result.units[1]).toEqual({ pcba_a_sn: 'EE-A-0002', pcba_b_sn: 'EE-B-0002' })
      expect(result.units[2]).toEqual({ pcba_a_sn: 'EE-A-0003', pcba_b_sn: 'EE-B-0003' })
    }
  })

  it('returns error when A and B counts differ', () => {
    const result = pairSerialRanges('EE-A-0001 to 0003', 'EE-B-0001 to 0002')
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('3')
      expect(result.error).toContain('2')
    }
  })

  it('propagates error from A range', () => {
    const result = pairSerialRanges('EE-A-0001 and EE-A-0003', null)
    expect('error' in result).toBe(true)
  })

  it('propagates error from B range prefixed with "PCBA-B: "', () => {
    const result = pairSerialRanges('EE-A-0001 to 0003', 'EE-B-0001 and EE-B-0003')
    expect('error' in result).toBe(true)
    if ('error' in result) {
      expect(result.error).toContain('PCBA-B:')
    }
  })

  it('returns empty units for empty A', () => {
    const result = pairSerialRanges('', null)
    expect(result).toEqual({ units: [] })
  })
})
