/**
 * CSV import service — the sheet-migration path (§8.8).
 * Uses normalizeSerial, parseSheetDate, coerceQty from domain/normalize (single source of truth).
 */

import { CSV_COLUMN_MAP } from '@/lib/domain/validation'
import { normalizeSerial, parseSheetDate, coerceQty } from '@/lib/domain/normalize'
import { createDevice } from '@/lib/services/deviceService'
import { can, ACTIONS } from '@/lib/auth/permissions'
import { AppError } from '@/lib/types'
import type { ImportPreviewRow, DeviceInput, Role } from '@/lib/types'

/**
 * Remap CSV column headers to device field names using CSV_COLUMN_MAP.
 * Unknown headers are preserved with their original key (for debugging).
 */
function remapRow(raw: Record<string, string>): Record<string, string> {
  const remapped: Record<string, string> = {}
  for (const [header, value] of Object.entries(raw)) {
    const trimmedHeader = header.trim()
    const fieldName = CSV_COLUMN_MAP[trimmedHeader]
    if (fieldName) {
      remapped[fieldName] = value
    }
    // Also always keep the original key available
    remapped[trimmedHeader] = value
  }
  return remapped
}

/**
 * Validate a single mapped row from CSV or Excel.
 * Used by both previewCsvRows and Excel import (Task 3).
 */
export function validateMappedRow(
  mapped: Record<string, string>,
  rowIndex: number,
  validStatuses: string[],
  validPhases: string[],
  raw: Record<string, string>
): ImportPreviewRow {
  const errors: string[] = []

  // Required fields
  if (!mapped.pcba_a_sn?.trim()) errors.push('PCBA-A S/N is required')
  if (!mapped.pcba_a_hw_rev?.trim()) errors.push('HW Rev (PCBA-A) is required')
  if (!mapped.pcba_a_bom_rev?.trim()) errors.push('BOM Rev (PCBA-A) is required')
  if (!mapped.pcba_a_fw_ver?.trim()) errors.push('FW Ver (PCBA-A) is required')
  if (!mapped.status?.trim()) errors.push('Status is required')
  if (!mapped.phase?.trim()) errors.push('Phase is required')

  // Date parsing
  let build_date: string | null = null
  let ship_date: string | null = null
  try {
    build_date = parseSheetDate(mapped.build_date)
  } catch (e) {
    errors.push(`Build Date: ${(e as Error).message}`)
  }
  try {
    ship_date = parseSheetDate(mapped.ship_date)
  } catch (e) {
    errors.push(`Ship Date: ${(e as Error).message}`)
  }

  // Qty coercion
  let qty: number | null = null
  try {
    qty = coerceQty(mapped.qty)
  } catch (e) {
    errors.push(`Qty: ${(e as Error).message}`)
  }

  // Vocabulary validation: flag but don't auto-create (§7, §10)
  if (mapped.status?.trim() && !validStatuses.includes(mapped.status.trim())) {
    errors.push(`Status "${mapped.status.trim()}" is not in the vocabulary`)
  }
  if (mapped.phase?.trim() && !validPhases.includes(mapped.phase.trim())) {
    errors.push(`Phase "${mapped.phase.trim()}" is not in the vocabulary`)
  }

  if (errors.length > 0) {
    return { rowIndex, raw, valid: false, errors }
  }

  // Build parsed DeviceInput — serial fields kept as text (no expansion)
  const parsed: DeviceInput = {
    device_sn:      mapped.device_sn?.trim() || null,
    product_name:   mapped.product_name?.trim() || null,
    model_no:       mapped.model_no?.trim() || null,
    pcba_a_sn:      mapped.pcba_a_sn.trim(),
    pcba_a_hw_rev:  mapped.pcba_a_hw_rev.trim(),
    pcba_a_bom_rev: mapped.pcba_a_bom_rev.trim(),
    pcba_a_fw_ver:  mapped.pcba_a_fw_ver.trim(),
    pcba_b_sn:      mapped.pcba_b_sn?.trim() || null,
    pcba_b_hw_rev:  mapped.pcba_b_hw_rev?.trim() || null,
    pcba_b_bom_rev: mapped.pcba_b_bom_rev?.trim() || null,
    pcba_b_fw_ver:  mapped.pcba_b_fw_ver?.trim() || null,
    screen_model:   mapped.screen_model?.trim() || null,
    hmi_ver:        mapped.hmi_ver?.trim() || null,
    build_date,
    ship_date,
    qty,
    destination:    mapped.destination?.trim() || null,
    customer:       mapped.customer?.trim() || null,
    status:         mapped.status.trim(),
    phase:          mapped.phase.trim(),
    remarks:        mapped.remarks || null,  // preserve verbatim — no trim on remarks (multiline/Chinese)
  }

  return { rowIndex, raw, valid: true, errors: [], parsed }
}

/**
 * Validate and preview a batch of CSV rows (already parsed by PapaParse).
 * Returns per-row results with valid/invalid status and error reasons.
 * Does not write to the DB.
 */
export async function previewCsvRows(
  rows: Record<string, string>[],
  validStatuses: string[],
  validPhases: string[]
): Promise<ImportPreviewRow[]> {
  return rows.map((raw, i) => {
    const mapped = remapRow(raw)
    return validateMappedRow(mapped, i + 1, validStatuses, validPhases, raw)
  })
}

/**
 * Import only the valid rows from a preview result.
 * Never partially writes a bad row. Returns import counts.
 */
export async function importValidRows(
  rows: ImportPreviewRow[],
  actorId: string,
  actorRole: Role
): Promise<{ imported: number; skipped: number }> {
  if (!can(actorRole, ACTIONS.IMPORT_DATA)) {
    throw new AppError({ type: 'permission', message: 'You do not have permission to import data' })
  }

  const validRows = rows.filter((r) => r.valid && r.parsed)
  let imported = 0
  const skipped = rows.length - validRows.length

  for (const row of validRows) {
    try {
      await createDevice(row.parsed!, actorId, actorRole)
      imported++
    } catch {
      // Individual row failure doesn't stop the batch (already validated)
      // In production, collect per-row errors for a detailed report
    }
  }

  return { imported, skipped }
}
