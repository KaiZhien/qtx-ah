import { previewCsvRows } from '@/lib/services/importService'

const VALID_STATUSES = ['Stock', 'In Use', 'Repair']
const VALID_PHASES = ['Production', 'Validation', 'Rework']

const VALID_ROW: Record<string, string> = {
  'PCBA-A S/N': 'PA001',
  'PCBA-A HW Rev': 'v1.0',
  'PCBA-A BOM Rev': 'B1',
  'PCBA-A FW Ver': '1.0.0',
  'Status': 'Stock',
  'Phase': 'Production',
}

describe('previewCsvRows — auto-mapping', () => {
  it('maps English headers to device fields', async () => {
    const rows = await previewCsvRows([VALID_ROW], VALID_STATUSES, VALID_PHASES)
    expect(rows[0].valid).toBe(true)
    expect(rows[0].parsed?.pcba_a_sn).toBe('PA001')
  })

  it('maps Chinese headers to device fields', async () => {
    const chineseRow: Record<string, string> = {
      '电源板序列号': 'PA002',
      'PCBA-A 硬件版本': 'v1.1',
      'PCBA-A BOM版本': 'B2',
      'PCBA-A 固件版本': '1.1.0',
      '状态': 'Stock',
      '阶段': 'Production',
    }
    const rows = await previewCsvRows([chineseRow], VALID_STATUSES, VALID_PHASES)
    expect(rows[0].valid).toBe(true)
    expect(rows[0].parsed?.pcba_a_sn).toBe('PA002')
  })

  it('assigns rowIndex starting from 1', async () => {
    const rows = await previewCsvRows([VALID_ROW, VALID_ROW], VALID_STATUSES, VALID_PHASES)
    expect(rows[0].rowIndex).toBe(1)
    expect(rows[1].rowIndex).toBe(2)
  })
})

describe('previewCsvRows — required fields', () => {
  it('rejects row missing pcba_a_sn', async () => {
    const { 'PCBA-A S/N': _, ...rest } = VALID_ROW
    const rows = await previewCsvRows([rest], VALID_STATUSES, VALID_PHASES)
    expect(rows[0].valid).toBe(false)
    expect(rows[0].errors.some(e => e.includes('PCBA-A S/N'))).toBe(true)
  })

  it('rejects row missing status', async () => {
    const rows = await previewCsvRows([{ ...VALID_ROW, Status: '' }], VALID_STATUSES, VALID_PHASES)
    expect(rows[0].valid).toBe(false)
  })

  it('rejects row missing phase', async () => {
    const rows = await previewCsvRows([{ ...VALID_ROW, Phase: '' }], VALID_STATUSES, VALID_PHASES)
    expect(rows[0].valid).toBe(false)
  })
})

describe('previewCsvRows — date parsing', () => {
  it('accepts DD/MM/YYYY build date', async () => {
    const rows = await previewCsvRows([{ ...VALID_ROW, 'Build Date': '25/12/2023' }], VALID_STATUSES, VALID_PHASES)
    expect(rows[0].valid).toBe(true)
    expect(rows[0].parsed?.build_date).toBe('2023-12-25')
  })

  it('rejects invalid build date with error', async () => {
    const rows = await previewCsvRows([{ ...VALID_ROW, 'Build Date': '99/99/2023' }], VALID_STATUSES, VALID_PHASES)
    expect(rows[0].valid).toBe(false)
    expect(rows[0].errors.some(e => e.includes('Build Date'))).toBe(true)
  })

  it('accepts blank build date (optional)', async () => {
    const rows = await previewCsvRows([{ ...VALID_ROW, 'Build Date': '' }], VALID_STATUSES, VALID_PHASES)
    expect(rows[0].valid).toBe(true)
    expect(rows[0].parsed?.build_date).toBeNull()
  })
})

describe('previewCsvRows — qty coercion', () => {
  it('coerces qty string to number', async () => {
    const rows = await previewCsvRows([{ ...VALID_ROW, Qty: '10' }], VALID_STATUSES, VALID_PHASES)
    expect(rows[0].valid).toBe(true)
    expect(rows[0].parsed?.qty).toBe(10)
  })

  it('rejects negative qty', async () => {
    const rows = await previewCsvRows([{ ...VALID_ROW, Qty: '-5' }], VALID_STATUSES, VALID_PHASES)
    expect(rows[0].valid).toBe(false)
    expect(rows[0].errors.some(e => e.includes('Qty'))).toBe(true)
  })
})

describe('previewCsvRows — vocabulary validation', () => {
  it('rejects unknown status', async () => {
    const rows = await previewCsvRows([{ ...VALID_ROW, Status: 'UnknownStatus' }], VALID_STATUSES, VALID_PHASES)
    expect(rows[0].valid).toBe(false)
    expect(rows[0].errors.some(e => e.includes('UnknownStatus'))).toBe(true)
  })

  it('rejects unknown phase', async () => {
    const rows = await previewCsvRows([{ ...VALID_ROW, Phase: 'UnknownPhase' }], VALID_STATUSES, VALID_PHASES)
    expect(rows[0].valid).toBe(false)
    expect(rows[0].errors.some(e => e.includes('UnknownPhase'))).toBe(true)
  })

  it('does not auto-create vocabulary entries for unknown values', async () => {
    // Just verifies the row is rejected, not silently inserted
    const rows = await previewCsvRows([{ ...VALID_ROW, Status: 'NewStatus' }], VALID_STATUSES, VALID_PHASES)
    expect(rows[0].valid).toBe(false)
  })
})

describe('previewCsvRows — verbatim preservation', () => {
  it('preserves multiline remarks verbatim', async () => {
    const remarks = 'First line\nSecond line\n第三行备注'
    const rows = await previewCsvRows([{ ...VALID_ROW, Remarks: remarks }], VALID_STATUSES, VALID_PHASES)
    expect(rows[0].valid).toBe(true)
    expect(rows[0].parsed?.remarks).toBe(remarks)
  })

  it('preserves serial range as-is (not expanded)', async () => {
    const rows = await previewCsvRows([{ ...VALID_ROW, 'Device S/N': 'QTX-001~QTX-010' }], VALID_STATUSES, VALID_PHASES)
    expect(rows[0].valid).toBe(true)
    expect(rows[0].parsed?.device_sn).toBe('QTX-001~QTX-010')
  })
})

describe('previewCsvRows — mixed batches', () => {
  it('handles a batch of valid and invalid rows, returning all results', async () => {
    const { 'PCBA-A S/N': _, ...missingSerial } = VALID_ROW
    const rows = await previewCsvRows([VALID_ROW, missingSerial, VALID_ROW], VALID_STATUSES, VALID_PHASES)
    expect(rows).toHaveLength(3)
    expect(rows[0].valid).toBe(true)
    expect(rows[1].valid).toBe(false)
    expect(rows[2].valid).toBe(true)
  })
})
