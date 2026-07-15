import { describe, it, expect } from 'vitest'
import ExcelJS from 'exceljs'
import { buildDeviceWorkbook } from '@/lib/services/exportService'
import { FIELD_LABELS } from '@/lib/i18n/fields'
import type { DeviceRow } from '@/lib/types'

// Column order is driven by the insertion order of FIELD_LABELS; a field's 1-based
// column index is its position in that map.
const FIELDS = Object.keys(FIELD_LABELS)
const col = (field: string) => FIELDS.indexOf(field) + 1

// buildDeviceWorkbook returns a Buffer<ArrayBufferLike>; ExcelJS's .load() is typed
// against a differently-resolved Buffer, so cast to its exact expected parameter.
type LoadArg = Parameters<ExcelJS.Xlsx['load']>[0]

async function loadDevicesSheet(rows: Array<Record<string, unknown>>): Promise<ExcelJS.Worksheet> {
  const buf = await buildDeviceWorkbook(rows as unknown as DeviceRow[])
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf as unknown as LoadArg)
  return wb.getWorksheet('Devices')!
}

describe('buildDeviceWorkbook — output shape', () => {
  it('returns a Node Buffer', async () => {
    const buf = await buildDeviceWorkbook([])
    expect(Buffer.isBuffer(buf)).toBe(true)
  })

  it('writes one sheet named "Devices"', async () => {
    const buf = await buildDeviceWorkbook([])
    const wb = new ExcelJS.Workbook()
    await wb.xlsx.load(buf as unknown as LoadArg)
    expect(wb.getWorksheet('Devices')).toBeDefined()
  })
})

describe('buildDeviceWorkbook — bilingual headers', () => {
  it('writes an "English (中文)" header for every FIELD_LABELS field', async () => {
    const ws = await loadDevicesSheet([])
    for (const [field, { en, zh }] of Object.entries(FIELD_LABELS)) {
      expect(ws.getRow(1).getCell(col(field)).value).toBe(`${en} (${zh})`)
    }
  })

  it('emits exactly one header column per field (no extras, no gaps)', async () => {
    const ws = await loadDevicesSheet([])
    // getRow(1).values is 1-indexed with a leading null slot.
    const headerCells = (ws.getRow(1).values as unknown[]).slice(1)
    expect(headerCells).toHaveLength(FIELDS.length)
  })
})

describe('buildDeviceWorkbook — formula-injection guard', () => {
  // Excel executes any cell whose text begins with one of these; the workbook must
  // neutralize each by prefixing a tab so the cell is treated as literal text.
  const DANGEROUS = ['=', '+', '-', '@', '\t', '\r']

  for (const ch of DANGEROUS) {
    it(`neutralizes a value starting with ${JSON.stringify(ch)} by tab-prefixing it`, async () => {
      // The security property under test is "cell no longer begins with the trigger
      // char" — asserted as a leading tab. (Exact byte preservation is checked below
      // for a printable char; the XLSX/XML round-trip rewrites bare \r → \n.)
      const ws = await loadDevicesSheet([{ pcba_a_sn: `${ch}cmd|'/C calc'!A0` }])
      const cell = ws.getRow(2).getCell(col('pcba_a_sn')).value as string
      expect(cell.startsWith('\t')).toBe(true)
    })
  }

  it('prefixes the tab in front of the original payload (printable trigger, exact)', async () => {
    const payload = "=cmd|'/C calc'!A0"
    const ws = await loadDevicesSheet([{ pcba_a_sn: payload }])
    expect(ws.getRow(2).getCell(col('pcba_a_sn')).value).toBe(`\t${payload}`)
  })

  it('leaves a benign value untouched', async () => {
    const ws = await loadDevicesSheet([{ pcba_a_sn: 'PA-001', customer: 'Acme Corp' }])
    expect(ws.getRow(2).getCell(col('pcba_a_sn')).value).toBe('PA-001')
    expect(ws.getRow(2).getCell(col('customer')).value).toBe('Acme Corp')
  })

  it('does not touch a dangerous char that is not in the leading position', async () => {
    // The guard is anchored to the start of the string (^), so an interior "+" is safe.
    const ws = await loadDevicesSheet([{ pcba_a_sn: '2+2=fine' }])
    expect(ws.getRow(2).getCell(col('pcba_a_sn')).value).toBe('2+2=fine')
  })

  it('coerces a non-string cell value (number) through the guard as text', async () => {
    const ws = await loadDevicesSheet([{ qty: 42 }])
    expect(ws.getRow(2).getCell(col('qty')).value).toBe('42')
  })
})

describe('buildDeviceWorkbook — blank + empty handling', () => {
  it('renders an empty cell for null and empty-string fields', async () => {
    const ws = await loadDevicesSheet([{ pcba_a_sn: null, customer: '' }])
    // ExcelJS reads an empty text cell back as null.
    expect(ws.getRow(2).getCell(col('pcba_a_sn')).value ?? '').toBe('')
    expect(ws.getRow(2).getCell(col('customer')).value ?? '').toBe('')
  })

  it('an empty dataset produces the header row only', async () => {
    const ws = await loadDevicesSheet([])
    expect(ws.rowCount).toBe(1)
  })

  it('writes exactly one data row per device', async () => {
    const ws = await loadDevicesSheet([{ pcba_a_sn: 'A' }, { pcba_a_sn: 'B' }])
    expect(ws.rowCount).toBe(3) // header + 2 rows
  })
})
