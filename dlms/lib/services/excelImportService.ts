/**
 * Excel import service — parses PCBA_Traceability.xlsx files.
 * Handles bilingual column headers, serial range expansion, and validation.
 * Produces the same ImportPreviewRow[] shape as the CSV import path.
 */

import ExcelJS from 'exceljs'
import { CSV_COLUMN_MAP } from '@/lib/domain/validation'
import { pairSerialRanges } from '@/lib/domain/serialRange'
import { validateMappedRow } from '@/lib/services/importService'
import type { ImportPreviewRow } from '@/lib/types'

/**
 * Resolve a cell header string to a device field name using CSV_COLUMN_MAP.
 * Handles bilingual headers of the form "English (中文)" or "English\n中文".
 * Returns null if no match found (column is ignored).
 */
function resolveHeader(cell: string): string | null {
  const trimmed = cell.trim()
  if (!trimmed) return null

  // Try exact match first
  if (trimmed in CSV_COLUMN_MAP) {
    return CSV_COLUMN_MAP[trimmed] as string
  }

  // Split on newline, then on parentheses (both ASCII and fullwidth)
  const segments = trimmed.split('\n')
  for (const segment of segments) {
    // Split on ( ) （ ）
    const parts = segment.split(/[()（）]/)
    for (const part of parts) {
      const candidate = part.trim()
      if (candidate && candidate in CSV_COLUMN_MAP) {
        return CSV_COLUMN_MAP[candidate] as string
      }
    }
  }

  return null
}

/**
 * Parse an Excel file buffer and return a preview of all rows.
 * Expands serial ranges from PCBA-A and PCBA-B columns into individual units.
 * Each unit is validated and returned as an ImportPreviewRow.
 */
export async function previewExcelBuffer(
  buf: ArrayBuffer,
  validStatuses: string[],
  validPhases: string[]
): Promise<ImportPreviewRow[]> {
  // Step 1: Load the workbook
  const wb = new ExcelJS.Workbook()
  await wb.xlsx.load(buf)

  if (wb.worksheets.length === 0) {
    throw new Error('No worksheets found in workbook')
  }

  // Use the 'Traceability' sheet if present; otherwise fall back to first sheet
  const ws = wb.getWorksheet('Traceability') ?? wb.worksheets[0]

  // Step 2: Detect header row (scan up to row 10)
  let headerRowNumber = -1

  ws.eachRow((row, rowNumber) => {
    if (headerRowNumber !== -1 || rowNumber > 10) return

    row.eachCell((cell) => {
      if (headerRowNumber !== -1) return
      const val = cell.value != null ? String(cell.value) : ''
      if (
        val.includes('Device S/N') ||
        val.includes('设备序列号') ||
        val.includes('PCBA-A S/N') ||
        val.includes('电源板序列号')
      ) {
        headerRowNumber = rowNumber
      }
    })
  })

  if (headerRowNumber === -1) {
    throw new Error('Could not detect header row in workbook')
  }

  // Step 3: Resolve column map from header row
  const headerRow = ws.getRow(headerRowNumber)
  const colMap = new Map<number, string>() // 1-based col index → field name

  headerRow.eachCell((cell, colIdx) => {
    const val = cell.value != null ? String(cell.value) : ''
    const fieldName = resolveHeader(val)
    if (fieldName !== null) {
      colMap.set(colIdx, fieldName)
    }
  })

  // Step 4: Iterate data rows and build results
  const results: ImportPreviewRow[] = []
  let unitRowIndex = 0 // running counter across all output rows

  ws.eachRow((row, rowNumber) => {
    if (rowNumber <= headerRowNumber) return

    // Build raw record from mapped columns
    const rec: Record<string, string> = {}
    colMap.forEach((fieldName, colIdx) => {
      const cell = row.getCell(colIdx)
      let val = ''
      if (cell.value !== null && cell.value !== undefined) {
        if (cell.value instanceof Date) {
          // Format as DD/MM/YYYY so parseSheetDate handles it
          val = `${String(cell.value.getDate()).padStart(2, '0')}/${String(cell.value.getMonth() + 1).padStart(2, '0')}/${cell.value.getFullYear()}`
        } else {
          val = String(cell.value).trim()
        }
      }
      if (val) rec[fieldName] = val
    })

    // Skip fully-empty rows
    if (Object.keys(rec).length === 0) return

    // Skip rows where every mapped value is empty/whitespace
    const hasContent = Object.values(rec).some((v) => v.trim() !== '')
    if (!hasContent) return

    // Step 5: Expand serial ranges and validate
    const pairResult = pairSerialRanges(rec.pcba_a_sn ?? '', rec.pcba_b_sn ?? null)

    if ('error' in pairResult) {
      results.push({
        rowIndex: rowNumber,
        raw: rec,
        valid: false,
        errors: [pairResult.error],
      })
      return
    }

    const { units } = pairResult

    // Skip rows with no serials (empty A serial)
    if (units.length === 0) return

    for (const unit of units) {
      unitRowIndex++
      const unitRec: Record<string, string> = { ...rec, pcba_a_sn: unit.pcba_a_sn, qty: '1' }

      if (unit.pcba_b_sn !== null) {
        unitRec.pcba_b_sn = unit.pcba_b_sn
      } else {
        delete unitRec.pcba_b_sn
      }

      const previewRow = validateMappedRow(unitRec, unitRowIndex, validStatuses, validPhases, rec)
      results.push(previewRow)
    }
  })

  // Step 6: Return flat results
  return results
}
