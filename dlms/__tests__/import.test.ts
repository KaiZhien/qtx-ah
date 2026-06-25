import { previewCsvRows } from '@/lib/services/importService'
import { previewExcelBuffer } from '@/lib/services/excelImportService'
import ExcelJS from 'exceljs'

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

// ─── Excel import path ────────────────────────────────────────────────────────

const VS = ['Stock', 'In Use', 'Repair', 'Shipped']
const VP = ['Production', 'Validation', 'MP']

const BASE_ROW = {
  pcba_a_sn: 'EE-A-0001', pcba_a_hw_rev: 'V1', pcba_a_bom_rev: 'R1', pcba_a_fw_ver: '1.0',
  status: 'Shipped', phase: 'MP',
}

async function makeWorkbook(dataRows: Record<string, string>[]): Promise<ArrayBuffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Traceability')
  // Header row — use unambiguous prefixed headers so resolveHeader can match them
  ws.addRow([
    'Device S/N\n设备序列号', 'Product Name\n产品名称', 'Model No.\n产品型号',
    'PCBA-A S/N\n电源板序列号', 'PCBA-A HW Rev\n硬件版本', 'PCBA-A BOM Rev\nBOM版本', 'PCBA-A FW Ver\n固件版本',
    'PCBA-B S/N\n控制板序列号', 'PCBA-B HW Rev\n硬件版本', 'PCBA-B BOM Rev\nBOM版本', 'PCBA-B FW Ver\n固件版本',
    'Screen Model\n屏幕型号', 'HMI Ver\nHMI软件版本',
    'Build Date\n生产日期', 'Ship Date\n出货日期', 'Qty\n数量',
    'Destination\n目的地', 'Customer\n客户',
    'Status\n状态', 'Phase\n阶段', 'Remarks\n备注',
  ])
  // Data rows — order matches header
  for (const row of dataRows) {
    ws.addRow([
      row.device_sn ?? '', row.product_name ?? '', row.model_no ?? '',
      row.pcba_a_sn ?? '', row.pcba_a_hw_rev ?? '', row.pcba_a_bom_rev ?? '', row.pcba_a_fw_ver ?? '',
      row.pcba_b_sn ?? '', row.pcba_b_hw_rev ?? '', row.pcba_b_bom_rev ?? '', row.pcba_b_fw_ver ?? '',
      row.screen_model ?? '', row.hmi_ver ?? '',
      row.build_date ?? '', row.ship_date ?? '', row.qty ?? '',
      row.destination ?? '', row.customer ?? '',
      row.status ?? '', row.phase ?? '', row.remarks ?? '',
    ])
  }
  const buf = await wb.xlsx.writeBuffer()
  return buf as ArrayBuffer
}

describe('previewExcelBuffer', () => {
  it('resolves combined bilingual headers', async () => {
    const buf = await makeWorkbook([BASE_ROW])
    const rows = await previewExcelBuffer(buf, VS, VP)
    expect(rows.length).toBe(1)
    expect(rows[0].parsed?.pcba_a_sn).toBe('EE-A-0001')
  })

  it('single row → 1 device row', async () => {
    const buf = await makeWorkbook([BASE_ROW])
    const rows = await previewExcelBuffer(buf, VS, VP)
    expect(rows.length).toBe(1)
    expect(rows[0].valid).toBe(true)
    expect(rows[0].parsed?.qty).toBe(1)
  })

  it('range row → N device rows (lockstep)', async () => {
    const rangeRow = {
      ...BASE_ROW,
      pcba_a_sn: 'EE-A-0001 to 0003',
      pcba_b_sn: 'EE-B-0001 to 0003',
      pcba_b_hw_rev: 'V1',
      pcba_b_bom_rev: 'R1',
      pcba_b_fw_ver: '1.0',
    }
    const buf = await makeWorkbook([rangeRow])
    const rows = await previewExcelBuffer(buf, VS, VP)
    expect(rows.length).toBe(3)
    expect(rows.every((r) => r.valid)).toBe(true)
    expect(rows[0].parsed?.pcba_a_sn).toBe('EE-A-0001')
    expect(rows[0].parsed?.pcba_b_sn).toBe('EE-B-0001')
    expect(rows[2].parsed?.pcba_a_sn).toBe('EE-A-0003')
  })

  it('"and" notation row → rejected', async () => {
    const andRow = { ...BASE_ROW, pcba_a_sn: 'EE-A-0001 and EE-A-0003' }
    const buf = await makeWorkbook([andRow])
    const rows = await previewExcelBuffer(buf, VS, VP)
    expect(rows.length).toBe(1)
    expect(rows[0].valid).toBe(false)
    expect(rows[0].errors.some((e) => e.includes('cannot be auto-expanded'))).toBe(true)
  })

  it('skips fully empty rows', async () => {
    const buf = await makeWorkbook([BASE_ROW, {}, BASE_ROW])
    const rows = await previewExcelBuffer(buf, VS, VP)
    expect(rows.length).toBe(2)
  })

  it('invalid status → rejected', async () => {
    const badStatusRow = { ...BASE_ROW, status: 'Unknown' }
    const buf = await makeWorkbook([badStatusRow])
    const rows = await previewExcelBuffer(buf, VS, VP)
    expect(rows[0].valid).toBe(false)
    expect(rows[0].errors.some((e) => e.includes('Unknown'))).toBe(true)
  })

  it('15-unit range (real-world data)', async () => {
    const rangeRow = {
      ...BASE_ROW,
      pcba_a_sn: 'EE-02A-2603-0001 to 0015',
      pcba_b_sn: 'EE-01-B2020-002-A0001 to 0015',
      pcba_b_hw_rev: 'V1',
      pcba_b_bom_rev: 'R1',
      pcba_b_fw_ver: '1.0',
    }
    const buf = await makeWorkbook([rangeRow])
    const rows = await previewExcelBuffer(buf, VS, VP)
    expect(rows.length).toBe(15)
    expect(rows.every((r) => r.valid)).toBe(true)
    expect(rows[14].parsed?.pcba_a_sn).toBe('EE-02A-2603-0015')
    expect(rows[14].parsed?.pcba_b_sn).toBe('EE-01-B2020-002-A0015')
  })
})
