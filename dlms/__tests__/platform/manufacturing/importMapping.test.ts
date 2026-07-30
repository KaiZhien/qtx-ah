import { describe, it, expect } from 'vitest'
import {
  resolveHeader, mapHeaders, validateSheetRow,
  type ValidationContext,
} from '@/modules/manufacturing/domain/importMapping'

const ctx: ValidationContext = {
  defaultVariantCode: 'pro',
  validVariantCodes: ['pro', 'basic'],
  validStatusCodes: ['in_production', 'in_stock', 'shipped'],
  validPhaseCodes: ['production', 'validation'],
}

const goodRow = () => ({
  pcba_a_sn: 'EE-02A-2603-0001',
  pcba_a_hw_rev: 'V1.2',
  pcba_a_bom_rev: 'B3',
  pcba_a_fw_ver: '1.0.4',
  status: 'in_stock',
  phase: 'production',
})

describe('resolveHeader', () => {
  it('matches an exact English header', () => {
    expect(resolveHeader('PCBA-A S/N')).toBe('pcba_a_sn')
  })
  it('matches a Chinese header', () => {
    expect(resolveHeader('电源板序列号')).toBe('pcba_a_sn')
  })
  it('matches a bilingual header split by newline', () => {
    expect(resolveHeader('PCBA-A S/N\n电源板序列号')).toBe('pcba_a_sn')
  })
  it('matches a bilingual header in ASCII and fullwidth parentheses', () => {
    expect(resolveHeader('Build Date (生产日期)')).toBe('build_date')
    expect(resolveHeader('Build Date（生产日期）')).toBe('build_date')
  })
  it('ignores whitespace around a header', () => {
    expect(resolveHeader('  Status  ')).toBe('status')
  })
  it('returns null for an unknown header', () => {
    expect(resolveHeader('Internal Notes')).toBeNull()
    expect(resolveHeader('')).toBeNull()
  })
})

describe('mapHeaders', () => {
  it('maps positionally and reports what it ignored', () => {
    const r = mapHeaders(['Device S/N', 'Internal Notes', 'Status'])
    expect(r.columns).toEqual(['device_sn', null, 'status'])
    expect(r.unmapped).toEqual(['Internal Notes'])
  })
})

describe('validateSheetRow — happy paths', () => {
  it('produces one valid draft with a pcba_a component', () => {
    const [out] = validateSheetRow(goodRow(), ctx)
    expect(out.status).toBe('valid')
    if (out.status !== 'valid') throw new Error('unreachable')
    expect(out.unitNo).toBe(1)
    expect(out.parsed.variantCode).toBe('pro')
    expect(out.parsed.status).toBe('in_stock')
    expect(out.parsed.components).toEqual([
      { typeCode: 'pcba_a', serialNo: 'EE-02A-2603-0001', hwRev: 'V1.2', bomRev: 'B3', fwVer: '1.0.4' },
    ])
  })

  it('fans a ranged serial out into one outcome per unit', () => {
    const outs = validateSheetRow(
      { ...goodRow(), pcba_a_sn: 'EE-02A-2603-0001 to 0003' }, ctx)
    expect(outs).toHaveLength(3)
    expect(outs.map((o) => o.unitNo)).toEqual([1, 2, 3])
    expect(outs.every((o) => o.status === 'valid')).toBe(true)
    expect(outs.map((o) => (o.status === 'valid' ? o.parsed.components[0].serialNo : null)))
      .toEqual(['EE-02A-2603-0001', 'EE-02A-2603-0002', 'EE-02A-2603-0003'])
  })

  it('pairs PCBA-B in lockstep with PCBA-A', () => {
    const outs = validateSheetRow({
      ...goodRow(),
      pcba_a_sn: 'A-0001 to 0002',
      pcba_b_sn: 'B-0005 to 0006',
      pcba_b_hw_rev: 'V2.0',
    }, ctx)
    expect(outs).toHaveLength(2)
    const second = outs[1]
    if (second.status !== 'valid') throw new Error('expected valid')
    expect(second.parsed.components).toEqual([
      { typeCode: 'pcba_a', serialNo: 'A-0002', hwRev: 'V1.2', bomRev: 'B3', fwVer: '1.0.4' },
      { typeCode: 'pcba_b', serialNo: 'B-0006', hwRev: 'V2.0', bomRev: null, fwVer: null },
    ])
  })

  it('converts sheet dates to ISO', () => {
    const [out] = validateSheetRow({ ...goodRow(), build_date: '14/3/2026' }, ctx)
    if (out.status !== 'valid') throw new Error('expected valid')
    expect(out.parsed.buildDate).toBe('2026-03-14')
  })

  it('leaves status null when the sheet has no status column', () => {
    const row = goodRow()
    delete (row as Partial<typeof row>).status
    const [out] = validateSheetRow(row, ctx)
    if (out.status !== 'valid') throw new Error('expected valid')
    expect(out.parsed.status).toBeNull()
  })

  it('takes the variant from a per-row column when present', () => {
    const [out] = validateSheetRow({ ...goodRow(), variant: 'basic' }, ctx)
    if (out.status !== 'valid') throw new Error('expected valid')
    expect(out.parsed.variantCode).toBe('basic')
  })

  it('preserves remarks verbatim, without trimming', () => {
    const [out] = validateSheetRow({ ...goodRow(), remarks: '  返修记录\n line 2  ' }, ctx)
    if (out.status !== 'valid') throw new Error('expected valid')
    expect(out.parsed.remarks).toBe('  返修记录\n line 2  ')
  })
})

describe('validateSheetRow — HMI screen handling', () => {
  it('componentises the screen when a serial is supplied', () => {
    const [out] = validateSheetRow({
      ...goodRow(), screen_sn: 'SCR-77', screen_model: 'TK-070', hmi_ver: '3.2',
    }, ctx)
    if (out.status !== 'valid') throw new Error('expected valid')
    expect(out.parsed.components).toContainEqual(
      { typeCode: 'hmi_screen', serialNo: 'SCR-77', hwRev: 'TK-070', bomRev: null, fwVer: '3.2' })
    expect(out.parsed.remarks).toBeNull()
  })

  it('carries the screen text into remarks when there is no screen serial', () => {
    const [out] = validateSheetRow({
      ...goodRow(), screen_model: 'TK-070', hmi_ver: '3.2',
    }, ctx)
    if (out.status !== 'valid') throw new Error('expected valid')
    expect(out.parsed.components.map((c) => c.typeCode)).toEqual(['pcba_a'])
    expect(out.parsed.remarks).toBe('HMI: TK-070 / 3.2')
  })

  it('appends the screen line to existing remarks', () => {
    const [out] = validateSheetRow({ ...goodRow(), remarks: 'note', screen_model: 'TK-070' }, ctx)
    if (out.status !== 'valid') throw new Error('expected valid')
    expect(out.parsed.remarks).toBe('note\nHMI: TK-070')
  })
})

describe('validateSheetRow — rejections', () => {
  it('marks a row invalid when the PCBA-A serial is missing', () => {
    const row = goodRow()
    delete (row as Partial<typeof row>).pcba_a_sn
    const [out] = validateSheetRow(row, ctx)
    expect(out.status).toBe('invalid')
    expect(out.errors).toContain('PCBA-A S/N is required')
  })

  it('marks a row needs_review when the serial notation is ambiguous', () => {
    const [out] = validateSheetRow({ ...goodRow(), pcba_a_sn: 'A-1 and A-2' }, ctx)
    expect(out.status).toBe('needs_review')
    expect(out.errors[0]).toMatch(/cannot be auto-expanded/)
    expect(out.unitNo).toBe(1)
  })

  it('marks a row needs_review when A and B counts differ', () => {
    const [out] = validateSheetRow(
      { ...goodRow(), pcba_a_sn: 'A-0001 to 0003', pcba_b_sn: 'B-0001 to 0002' }, ctx)
    expect(out.status).toBe('needs_review')
    expect(out.errors[0]).toMatch(/counts differ/)
  })

  it('rejects a status outside the vocabulary without auto-creating it', () => {
    const [out] = validateSheetRow({ ...goodRow(), status: 'Teleported' }, ctx)
    expect(out.status).toBe('invalid')
    expect(out.errors).toContain('Status "Teleported" is not in the vocabulary')
  })

  it('rejects a phase outside the vocabulary', () => {
    const [out] = validateSheetRow({ ...goodRow(), phase: 'Nope' }, ctx)
    expect(out.status).toBe('invalid')
    expect(out.errors).toContain('Phase "Nope" is not in the vocabulary')
  })

  it('rejects an unknown variant code', () => {
    const [out] = validateSheetRow({ ...goodRow(), variant: 'deluxe' }, ctx)
    expect(out.status).toBe('invalid')
    expect(out.errors).toContain('Variant "deluxe" is not in the vocabulary')
  })

  it('reports a bad date as a row error rather than throwing', () => {
    const [out] = validateSheetRow({ ...goodRow(), ship_date: '31/02/2026' }, ctx)
    expect(out.status).toBe('invalid')
    expect(out.errors[0]).toMatch(/^Ship Date: /)
  })

  it('collects every error on the row, not just the first', () => {
    const [out] = validateSheetRow(
      { pcba_a_sn: 'A-1', status: 'Nope', phase: 'Nope' }, ctx)
    expect(out.status).toBe('invalid')
    expect(out.errors.length).toBeGreaterThanOrEqual(2)
  })

  it('returns nothing at all for a row with no serial and no content', () => {
    expect(validateSheetRow({}, ctx)).toEqual([])
  })
})
