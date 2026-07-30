import { describe, it, expect } from 'vitest'
import {
  resolveHeader, mapHeaders, resolveVocab, validateSheetRow,
  type ValidationContext,
} from '@/modules/manufacturing/domain/importMapping'

const ctx: ValidationContext = {
  defaultVariantCode: 'pro',
  variants: [
    { code: 'pro', labels: ['Pro', 'Pro Model', '专业版'] },
    { code: 'basic', labels: ['Basic', '基础版'] },
  ],
  statuses: [
    { code: 'in_production', labels: ['In Production', '生产中'] },
    { code: 'in_stock', labels: ['In Stock', '库存'] },
    { code: 'shipped', labels: ['Shipped', '已发货'] },
    { code: 'under_repair', labels: ['Under Repair', '维修中'] },
  ],
  phases: [
    { code: 'production', labels: ['Production', '量产'] },
    { code: 'validation', labels: ['Validation', '验证'] },
  ],
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
  it('matches a parenthesised alias followed by a fullwidth translation', () => {
    expect(resolveHeader('HW Rev (A)（硬件版本）')).toBe('pcba_a_hw_rev')
    expect(resolveHeader('BOM Rev (B)（BOM版本）')).toBe('pcba_b_bom_rev')
    expect(resolveHeader('FW Ver (A)（固件版本）')).toBe('pcba_a_fw_ver')
  })
  it('matches a parenthesised alias above its translation', () => {
    expect(resolveHeader('HW Rev (A)\n硬件版本(A)')).toBe('pcba_a_hw_rev')
    expect(resolveHeader('FW Ver (B)\n固件版本(B)')).toBe('pcba_b_fw_ver')
  })
  it('ignores whitespace around a header', () => {
    expect(resolveHeader('  Status  ')).toBe('status')
  })
  it('ignores header casing', () => {
    expect(resolveHeader('status')).toBe('status')
    expect(resolveHeader('STATUS')).toBe('status')
    expect(resolveHeader('pcba-a s/n')).toBe('pcba_a_sn')
    expect(resolveHeader('hw rev (a)（硬件版本）')).toBe('pcba_a_hw_rev')
  })
  it('recognises the Qty column in both languages', () => {
    expect(resolveHeader('Qty')).toBe('qty')
    expect(resolveHeader('数量')).toBe('qty')
    expect(resolveHeader('Qty (数量)')).toBe('qty')
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

describe('resolveVocab', () => {
  const statuses = ctx.statuses

  it('matches a code exactly', () => {
    expect(resolveVocab('in_stock', statuses)).toBe('in_stock')
  })
  it('matches a code case-insensitively', () => {
    expect(resolveVocab('IN_STOCK', statuses)).toBe('in_stock')
    expect(resolveVocab('In_Stock', statuses)).toBe('in_stock')
  })
  it('treats spaces and underscores as equivalent in a code', () => {
    expect(resolveVocab('in stock', statuses)).toBe('in_stock')
    expect(resolveVocab('IN STOCK', statuses)).toBe('in_stock')
    expect(resolveVocab('  under repair  ', statuses)).toBe('under_repair')
  })
  it('matches a human label and returns the code', () => {
    expect(resolveVocab('In Stock', statuses)).toBe('in_stock')
    expect(resolveVocab('Under Repair', statuses)).toBe('under_repair')
    expect(resolveVocab('under repair', statuses)).toBe('under_repair')
    expect(resolveVocab('生产中', statuses)).toBe('in_production')
  })
  it('matches a multi-word label the code does not resemble', () => {
    expect(resolveVocab('Pro Model', ctx.variants)).toBe('pro')
  })
  it('returns null when nothing matches', () => {
    expect(resolveVocab('Teleported', statuses)).toBeNull()
    expect(resolveVocab('', statuses)).toBeNull()
    expect(resolveVocab('in_stock', [])).toBeNull()
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

describe('validateSheetRow — vocabulary resolution', () => {
  it('stores the status code when the sheet carries the human label', () => {
    const [out] = validateSheetRow({ ...goodRow(), status: 'In Stock' }, ctx)
    if (out.status !== 'valid') throw new Error('expected valid')
    expect(out.parsed.status).toBe('in_stock')
  })

  it('stores the phase code when the sheet carries the human label', () => {
    const [out] = validateSheetRow({ ...goodRow(), phase: 'Validation' }, ctx)
    if (out.status !== 'valid') throw new Error('expected valid')
    expect(out.parsed.phase).toBe('validation')
  })

  it('stores the variant code when the sheet carries the human label', () => {
    const [out] = validateSheetRow({ ...goodRow(), variant: 'Pro Model' }, ctx)
    if (out.status !== 'valid') throw new Error('expected valid')
    expect(out.parsed.variantCode).toBe('pro')
  })

  it('never stores the raw sheet text as a code', () => {
    const [out] = validateSheetRow({ ...goodRow(), status: 'UNDER REPAIR' }, ctx)
    if (out.status !== 'valid') throw new Error('expected valid')
    expect(out.parsed.status).toBe('under_repair')
  })

  it('resolves the context default variant through the vocabulary too', () => {
    const [out] = validateSheetRow(goodRow(), { ...ctx, defaultVariantCode: 'Pro Model' })
    if (out.status !== 'valid') throw new Error('expected valid')
    expect(out.parsed.variantCode).toBe('pro')
  })

  it('quotes the sheet text, not the normalized form, in the error', () => {
    const [out] = validateSheetRow({ ...goodRow(), status: 'In Orbit' }, ctx)
    expect(out.status).toBe('invalid')
    expect(out.errors).toContain('Status "In Orbit" is not in the vocabulary')
  })
})

describe('validateSheetRow — device serial', () => {
  it('takes the device serial when the row produces one unit', () => {
    const [out] = validateSheetRow({ ...goodRow(), device_sn: 'DEV-0001' }, ctx)
    if (out.status !== 'valid') throw new Error('expected valid')
    expect(out.parsed.deviceSn).toBe('DEV-0001')
  })

  it('leaves the device serial null on a fanned row that has no device_sn cell', () => {
    const outs = validateSheetRow({ ...goodRow(), pcba_a_sn: 'A-0001 to 0002' }, ctx)
    expect(outs).toHaveLength(2)
    expect(outs.every((o) => o.status === 'valid' && o.parsed.deviceSn === null)).toBe(true)
  })

  it('routes a fanned row carrying a device serial to needs_review', () => {
    const outs = validateSheetRow(
      { ...goodRow(), pcba_a_sn: 'A-0001 to 0003', device_sn: 'DEV-0001' }, ctx)
    expect(outs).toHaveLength(1)
    const [out] = outs
    expect(out.status).toBe('needs_review')
    expect(out.unitNo).toBe(1)
    expect(out.errors[0]).toBe(
      'Device S/N "DEV-0001" cannot describe 3 devices — split this row into one per device, or clear the device serial')
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

  it('expands a ranged screen serial and zips it with the PCBA-A units', () => {
    const outs = validateSheetRow({
      ...goodRow(),
      pcba_a_sn: 'A-0001 to 0003',
      screen_sn: 'SCR-0001 to 0003',
      screen_model: 'TK-070',
      hmi_ver: '3.2',
    }, ctx)
    expect(outs).toHaveLength(3)
    expect(outs.map((o) => (o.status === 'valid'
      ? o.parsed.components.find((c) => c.typeCode === 'hmi_screen')?.serialNo
      : null))).toEqual(['SCR-0001', 'SCR-0002', 'SCR-0003'])
    const [first] = outs
    if (first.status !== 'valid') throw new Error('expected valid')
    expect(first.parsed.remarks).toBeNull()
  })

  it('marks the row needs_review when the screen and PCBA-A counts differ', () => {
    const outs = validateSheetRow(
      { ...goodRow(), pcba_a_sn: 'A-0001 to 0003', screen_sn: 'SCR-0001' }, ctx)
    expect(outs).toHaveLength(1)
    const [out] = outs
    expect(out.status).toBe('needs_review')
    expect(out.errors[0]).toBe(
      'Screen (1) and PCBA-A (3) counts differ — fix this row manually')
  })

  it('marks the row needs_review when a wider screen range outnumbers PCBA-A', () => {
    const [out] = validateSheetRow({ ...goodRow(), screen_sn: 'SCR-0001 to 0003' }, ctx)
    expect(out.status).toBe('needs_review')
    expect(out.errors[0]).toBe(
      'Screen (3) and PCBA-A (1) counts differ — fix this row manually')
  })

  it('marks the row needs_review when the screen serial notation is ambiguous', () => {
    const [out] = validateSheetRow(
      { ...goodRow(), pcba_a_sn: 'A-0001 to 0003', screen_sn: 'SCR-1 and SCR-2' }, ctx)
    expect(out.status).toBe('needs_review')
    expect(out.errors[0]).toMatch(/^Screen: /)
    expect(out.errors[0]).toMatch(/cannot be auto-expanded/)
  })

  it('keeps the remarks fallback on a fanned row with no screen serial', () => {
    const outs = validateSheetRow({
      ...goodRow(), pcba_a_sn: 'A-0001 to 0002', screen_model: 'TK-070', hmi_ver: '3.2',
    }, ctx)
    expect(outs).toHaveLength(2)
    for (const out of outs) {
      if (out.status !== 'valid') throw new Error('expected valid')
      expect(out.parsed.components.map((c) => c.typeCode)).toEqual(['pcba_a'])
      expect(out.parsed.remarks).toBe('HMI: TK-070 / 3.2')
    }
  })
})

describe('validateSheetRow — qty cross-check', () => {
  it('accepts a qty that agrees with the expanded serial count', () => {
    const outs = validateSheetRow(
      { ...goodRow(), pcba_a_sn: 'A-0001 to 0003', qty: '3' }, ctx)
    expect(outs).toHaveLength(3)
    expect(outs.every((o) => o.status === 'valid')).toBe(true)
  })

  it('marks the row needs_review when qty disagrees with the expanded count', () => {
    const outs = validateSheetRow(
      { ...goodRow(), pcba_a_sn: 'A-0001 to 0003', qty: '2' }, ctx)
    expect(outs).toHaveLength(1)
    const [out] = outs
    expect(out.status).toBe('needs_review')
    expect(out.errors[0]).toBe('Qty (2) and expanded serial count (3) differ — fix this row manually')
  })

  it('ignores a blank, zero or non-numeric qty', () => {
    for (const qty of ['', '   ', '0', 'many', '2 pcs']) {
      const outs = validateSheetRow({ ...goodRow(), qty }, ctx)
      expect(outs).toHaveLength(1)
      expect(outs[0].status).toBe('valid')
    }
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

  it('reports the row errors alongside an unexpandable serial, expansion first', () => {
    const [out] = validateSheetRow({
      pcba_a_sn: 'A-1 and A-2', status: 'Nope', ship_date: '31/02/2026',
    }, ctx)
    expect(out.status).toBe('needs_review')
    expect(out.errors).toHaveLength(3)
    expect(out.errors[0]).toMatch(/cannot be auto-expanded/)
    expect(out.errors).toContain('Status "Nope" is not in the vocabulary')
    expect(out.errors.some((e) => e.startsWith('Ship Date: '))).toBe(true)
  })

  it('reports the row errors alongside a screen expansion failure too', () => {
    const [out] = validateSheetRow({
      ...goodRow(), screen_sn: 'SCR-1, SCR-2', phase: 'Nope',
    }, ctx)
    expect(out.status).toBe('needs_review')
    expect(out.errors[0]).toMatch(/^Screen: /)
    expect(out.errors).toContain('Phase "Nope" is not in the vocabulary')
  })

  it('returns nothing at all for a row with no serial and no content', () => {
    expect(validateSheetRow({}, ctx)).toEqual([])
  })
})
