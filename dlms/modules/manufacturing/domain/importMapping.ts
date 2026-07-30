import { normalizeSerial, parseSheetDate } from '@/modules/manufacturing/domain/sheetValues'
import { pairSerialRanges } from '@/modules/manufacturing/domain/serialRange'

/** Every sheet column this importer understands. */
export type ImportField =
  | 'device_sn' | 'variant' | 'product_name' | 'model_no'
  | 'pcba_a_sn' | 'pcba_a_hw_rev' | 'pcba_a_bom_rev' | 'pcba_a_fw_ver'
  | 'pcba_b_sn' | 'pcba_b_hw_rev' | 'pcba_b_bom_rev' | 'pcba_b_fw_ver'
  | 'screen_sn' | 'screen_model' | 'hmi_ver'
  | 'build_date' | 'ship_date' | 'destination' | 'customer'
  | 'status' | 'phase' | 'remarks'

/**
 * Header → field. Ported from the legacy CSV_COLUMN_MAP (lib/domain/validation.ts)
 * and extended with `Variant` and `Screen S/N`, which the platform needs and the
 * legacy flat device table did not have.
 */
export const COLUMN_ALIASES: Record<string, ImportField> = {
  'Device S/N': 'device_sn', 'Device SN': 'device_sn', '设备序列号': 'device_sn',
  'Variant': 'variant', '变体': 'variant',
  'Product Name': 'product_name', '产品名称': 'product_name',
  'Model No.': 'model_no', 'Model No': 'model_no', '产品型号': 'model_no',

  'PCBA-A S/N': 'pcba_a_sn', 'PCBA-A SN': 'pcba_a_sn', '电源板序列号': 'pcba_a_sn',
  'PCBA-A HW Rev': 'pcba_a_hw_rev', 'HW Rev (A)': 'pcba_a_hw_rev', 'PCBA-A 硬件版本': 'pcba_a_hw_rev',
  'PCBA-A BOM Rev': 'pcba_a_bom_rev', 'BOM Rev (A)': 'pcba_a_bom_rev', 'PCBA-A BOM版本': 'pcba_a_bom_rev',
  'PCBA-A FW Ver': 'pcba_a_fw_ver', 'FW Ver (A)': 'pcba_a_fw_ver', 'PCBA-A 固件版本': 'pcba_a_fw_ver',

  'PCBA-B S/N': 'pcba_b_sn', 'PCBA-B SN': 'pcba_b_sn', '控制板序列号': 'pcba_b_sn',
  'PCBA-B HW Rev': 'pcba_b_hw_rev', 'HW Rev (B)': 'pcba_b_hw_rev', 'PCBA-B 硬件版本': 'pcba_b_hw_rev',
  'PCBA-B BOM Rev': 'pcba_b_bom_rev', 'BOM Rev (B)': 'pcba_b_bom_rev', 'PCBA-B BOM版本': 'pcba_b_bom_rev',
  'PCBA-B FW Ver': 'pcba_b_fw_ver', 'FW Ver (B)': 'pcba_b_fw_ver', 'PCBA-B 固件版本': 'pcba_b_fw_ver',

  'Screen S/N': 'screen_sn', 'Screen SN': 'screen_sn', '屏幕序列号': 'screen_sn',
  'Screen Model': 'screen_model', '屏幕型号': 'screen_model',
  'HMI Ver': 'hmi_ver', 'HMI Version': 'hmi_ver', 'HMI软件版本': 'hmi_ver',

  'Build Date': 'build_date', '生产日期': 'build_date',
  'Ship Date': 'ship_date', '出货日期': 'ship_date',
  'Destination': 'destination', '目的地': 'destination',
  'Customer': 'customer', '客户': 'customer',
  'Status': 'status', '状态': 'status',
  'Phase': 'phase', '阶段': 'phase',
  'Remarks': 'remarks', '备注': 'remarks',
}

/**
 * Resolve one header cell to a field. Real sheets carry bilingual headers as
 * "English (中文)", "English（中文）" or "English\n中文", so an exact miss is
 * retried against each newline- and parenthesis-delimited segment.
 */
export function resolveHeader(header: string): ImportField | null {
  const trimmed = header.trim()
  if (!trimmed) return null
  if (trimmed in COLUMN_ALIASES) return COLUMN_ALIASES[trimmed]

  for (const segment of trimmed.split('\n')) {
    for (const part of segment.split(/[()（）]/)) {
      const candidate = part.trim()
      if (candidate && candidate in COLUMN_ALIASES) return COLUMN_ALIASES[candidate]
    }
  }
  return null
}

/** Positional header map + the headers we ignored (shown to the reviewer). */
export function mapHeaders(headers: string[]): {
  columns: Array<ImportField | null>; unmapped: string[]
} {
  const columns = headers.map(resolveHeader)
  const unmapped = headers.filter((h, i) => columns[i] === null && h.trim() !== '')
  return { columns, unmapped }
}

export type ImportComponentDraft = {
  typeCode: 'pcba_a' | 'pcba_b' | 'hmi_screen'
  serialNo: string
  hwRev: string | null
  bomRev: string | null
  fwVer: string | null
}

export type ImportDeviceDraft = {
  deviceSn: string | null
  variantCode: string
  status: string | null        // null → seat at the vocabulary's initial status
  phase: string | null
  productName: string | null
  modelNo: string | null
  customer: string | null
  destination: string | null
  remarks: string | null
  buildDate: string | null     // YYYY-MM-DD
  shipDate: string | null      // YYYY-MM-DD
  components: ImportComponentDraft[]
}

export type ValidationContext = {
  defaultVariantCode: string
  validVariantCodes: string[]
  validStatusCodes: string[]
  validPhaseCodes: string[]
}

export type ImportRowOutcome =
  | { unitNo: number; raw: Record<string, string>; status: 'valid'; parsed: ImportDeviceDraft; errors: [] }
  | { unitNo: number; raw: Record<string, string>; status: 'invalid' | 'needs_review'; errors: string[] }

const text = (v: string | undefined): string | null => (v?.trim() ? v.trim() : null)

/**
 * Validate one sheet row, returning one outcome per physical unit.
 *
 * A row whose PCBA-A cell holds a range fans out: "…0001 to 0003" yields three
 * outcomes, each a complete device draft. Notation that cannot be expanded
 * unambiguously yields a single `needs_review` outcome — the review queue —
 * rather than a guess at a device's identity.
 */
export function validateSheetRow(
  raw: Record<string, string>, ctx: ValidationContext,
): ImportRowOutcome[] {
  const hasContent = Object.values(raw).some((v) => (v ?? '').trim() !== '')
  if (!hasContent) return []

  // Serial expansion first: it decides how many outcomes this row produces, and
  // its failures are review-queue material rather than validation errors.
  const paired = pairSerialRanges(raw.pcba_a_sn ?? '', raw.pcba_b_sn ?? null)
  if ('error' in paired) {
    return [{ unitNo: 1, raw, status: 'needs_review', errors: [paired.error] }]
  }

  // Row-level errors apply identically to every unit the row produces, so they
  // are computed once.
  const rowErrors: string[] = []

  if (paired.units.length === 0) rowErrors.push('PCBA-A S/N is required')

  const variantCode = text(raw.variant) ?? ctx.defaultVariantCode
  if (!ctx.validVariantCodes.includes(variantCode)) {
    rowErrors.push(`Variant "${variantCode}" is not in the vocabulary`)
  }

  const status = text(raw.status)
  if (status && !ctx.validStatusCodes.includes(status)) {
    rowErrors.push(`Status "${status}" is not in the vocabulary`)
  }
  const phase = text(raw.phase)
  if (phase && !ctx.validPhaseCodes.includes(phase)) {
    rowErrors.push(`Phase "${phase}" is not in the vocabulary`)
  }

  let buildDate: string | null = null
  try { buildDate = parseSheetDate(raw.build_date) }
  catch (e) { rowErrors.push(`Build Date: ${(e as Error).message}`) }
  let shipDate: string | null = null
  try { shipDate = parseSheetDate(raw.ship_date) }
  catch (e) { rowErrors.push(`Ship Date: ${(e as Error).message}`) }

  if (rowErrors.length > 0) {
    return [{ unitNo: 1, raw, status: 'invalid', errors: rowErrors }]
  }

  const screenSn = normalizeSerial(raw.screen_sn)
  const screenModel = text(raw.screen_model)
  const hmiVer = text(raw.hmi_ver)

  // remarks is preserved verbatim — bilingual, multiline, never trimmed.
  const baseRemarks = raw.remarks != null && raw.remarks !== '' ? raw.remarks : null
  // No screen serial → no component_unit (serial_no is NOT NULL and inventing an
  // identity would be a lie), so the screen text rides along on remarks instead.
  const screenNote = !screenSn && (screenModel || hmiVer)
    ? `HMI: ${[screenModel, hmiVer].filter(Boolean).join(' / ')}`
    : null
  const remarks = screenNote
    ? (baseRemarks ? `${baseRemarks}\n${screenNote}` : screenNote)
    : baseRemarks

  return paired.units.map((unit, i) => {
    const components: ImportComponentDraft[] = [{
      typeCode: 'pcba_a', serialNo: unit.pcbaA,
      hwRev: text(raw.pcba_a_hw_rev), bomRev: text(raw.pcba_a_bom_rev),
      fwVer: text(raw.pcba_a_fw_ver),
    }]
    if (unit.pcbaB) {
      components.push({
        typeCode: 'pcba_b', serialNo: unit.pcbaB,
        hwRev: text(raw.pcba_b_hw_rev), bomRev: text(raw.pcba_b_bom_rev),
        fwVer: text(raw.pcba_b_fw_ver),
      })
    }
    if (screenSn) {
      components.push({
        typeCode: 'hmi_screen', serialNo: screenSn,
        hwRev: screenModel, bomRev: null, fwVer: hmiVer,
      })
    }

    return {
      unitNo: i + 1, raw, status: 'valid' as const, errors: [] as [],
      parsed: {
        // A ranged row describes many devices but carries one device_sn cell;
        // giving every unit that same serial would collide on device_sn_unique.
        // Only an unfanned row can claim it.
        deviceSn: paired.units.length === 1 ? text(raw.device_sn) : null,
        variantCode, status, phase,
        productName: text(raw.product_name), modelNo: text(raw.model_no),
        customer: text(raw.customer), destination: text(raw.destination),
        remarks, buildDate, shipDate, components,
      },
    }
  })
}
