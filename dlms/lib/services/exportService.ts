import ExcelJS from 'exceljs'
import { FIELD_LABELS } from '@/lib/i18n/fields'
import type { DeviceRow } from '@/lib/types'

export async function buildDeviceWorkbook(rows: DeviceRow[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Devices')

  // Header row — bilingual "English (中文)"
  ws.columns = Object.entries(FIELD_LABELS).map(([key, { en, zh }]) => ({
    header: `${en} (${zh})`,
    key,
    width: 20,
  }))

  // Style header row
  ws.getRow(1).font = { bold: true }
  ws.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFE8EAF6' },
  }

  // Data rows — prefix formula-injection chars so Excel doesn't execute them
  for (const device of rows) {
    const row: Record<string, unknown> = {}
    for (const key of Object.keys(FIELD_LABELS)) {
      const raw = (device as Record<string, unknown>)[key]
      if (raw == null || raw === '') {
        row[key] = ''
      } else {
        const str = String(raw)
        row[key] = /^[=+\-@\t\r]/.test(str) ? `\t${str}` : str
      }
    }
    ws.addRow(row)
  }

  // Return as Buffer
  const arrayBuffer = await wb.xlsx.writeBuffer()
  return Buffer.from(arrayBuffer)
}
