import { deviceSchema } from '@/lib/domain/validation'

const VALID_BASE = {
  pcba_a_sn: 'PA001',
  pcba_a_hw_rev: 'v1.0',
  pcba_a_bom_rev: 'B1',
  pcba_a_fw_ver: '1.0.0',
  status: 'Stock',
  phase: 'Production',
}

describe('deviceSchema', () => {
  it('accepts a minimal valid input', () => {
    const result = deviceSchema.safeParse(VALID_BASE)
    expect(result.success).toBe(true)
  })

  it('rejects missing pcba_a_sn', () => {
    const { pcba_a_sn, ...rest } = VALID_BASE
    const result = deviceSchema.safeParse(rest)
    expect(result.success).toBe(false)
    if (!result.success) expect(result.error.issues[0].path).toContain('pcba_a_sn')
  })

  it('rejects missing status', () => {
    const result = deviceSchema.safeParse({ ...VALID_BASE, status: '' })
    expect(result.success).toBe(false)
  })

  it('transforms DD/MM/YYYY build_date to ISO', () => {
    const result = deviceSchema.safeParse({ ...VALID_BASE, build_date: '25/12/2023' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.build_date).toBe('2023-12-25')
  })

  it('rejects invalid build_date', () => {
    const result = deviceSchema.safeParse({ ...VALID_BASE, build_date: '99/99/2023' })
    expect(result.success).toBe(false)
  })

  it('returns null for blank build_date', () => {
    const result = deviceSchema.safeParse({ ...VALID_BASE, build_date: '' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.build_date).toBeNull()
  })

  it('coerces qty string to number', () => {
    const result = deviceSchema.safeParse({ ...VALID_BASE, qty: '5' })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.qty).toBe(5)
  })

  it('accepts null device_sn (partial index allows duplicates)', () => {
    const result = deviceSchema.safeParse({ ...VALID_BASE, device_sn: null })
    expect(result.success).toBe(true)
  })

  it('preserves remarks verbatim (multiline)', () => {
    const multiline = 'Line 1\nLine 2\n备注内容'
    const result = deviceSchema.safeParse({ ...VALID_BASE, remarks: multiline })
    expect(result.success).toBe(true)
    if (result.success) expect(result.data.remarks).toBe(multiline)
  })
})
