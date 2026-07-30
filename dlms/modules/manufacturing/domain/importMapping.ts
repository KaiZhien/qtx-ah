import { parseSheetDate } from '@/modules/manufacturing/domain/sheetValues'
import { expandSerialRange, pairSerialRanges } from '@/modules/manufacturing/domain/serialRange'

/** Every sheet column this importer understands. */
export type ImportField =
  | 'device_sn' | 'variant' | 'product_name' | 'model_no'
  | 'pcba_a_sn' | 'pcba_a_hw_rev' | 'pcba_a_bom_rev' | 'pcba_a_fw_ver'
  | 'pcba_b_sn' | 'pcba_b_hw_rev' | 'pcba_b_bom_rev' | 'pcba_b_fw_ver'
  | 'screen_sn' | 'screen_model' | 'hmi_ver'
  | 'build_date' | 'ship_date' | 'qty' | 'destination' | 'customer'
  | 'status' | 'phase' | 'remarks'

/**
 * Header → field. A deliberate copy of the legacy CSV_COLUMN_MAP
 * (lib/domain/validation.ts), not an import: the legacy module belongs to the
 * frozen /legacy app and the module boundary rule forbids reaching into it.
 *
 * Every legacy header is carried over verbatim, including `Qty`/`数量`, which
 * the platform keeps as a count cross-check rather than a stored column. Added
 * on top of the legacy set: `Variant`/`变体` (the platform seats devices on a
 * variant) and the screen serial headers `Screen S/N`/`Screen SN`/`屏幕序列号`
 * (the platform componentises the HMI screen; the legacy flat device table only
 * had the screen's model and firmware text).
 *
 * Kept as a plain, human-readable table — it doubles as the documentation of
 * which headers a sheet may use. Matching normalizes case, so the spelling here
 * is the canonical form, not the only accepted one.
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
  'Qty': 'qty', '数量': 'qty',
  'Destination': 'destination', '目的地': 'destination',
  'Customer': 'customer', '客户': 'customer',
  'Status': 'status', '状态': 'status',
  'Phase': 'phase', '阶段': 'phase',
  'Remarks': 'remarks', '备注': 'remarks',
}

/** Header lookup key: trimmed and case-folded. Sheets vary casing between tabs. */
const headerKey = (header: string): string => header.trim().toLowerCase()

/** Case-folded index over COLUMN_ALIASES, so that table stays readable. */
const ALIAS_LOOKUP: Map<string, ImportField> = new Map(
  Object.entries(COLUMN_ALIASES).map(([header, field]) => [headerKey(header), field]),
)

/**
 * Resolve one header cell to a field, case-insensitively.
 *
 * Real sheets carry bilingual headers as "English (中文)", "English（中文）" or
 * "English\n中文". Fullwidth parentheses only ever wrap a translation, so they
 * delimit segments alongside newlines; ASCII parentheses can be part of an
 * alias ("HW Rev (A)"), so each segment is tried whole *before* being split on
 * them — otherwise "HW Rev (A)（硬件版本）" would never resolve.
 */
export function resolveHeader(header: string): ImportField | null {
  const trimmed = header.trim()
  if (!trimmed) return null

  const direct = ALIAS_LOOKUP.get(headerKey(trimmed))
  if (direct) return direct

  for (const segment of trimmed.split(/[\n（）]/)) {
    const whole = segment.trim()
    if (!whole) continue
    const wholeHit = ALIAS_LOOKUP.get(headerKey(whole))
    if (wholeHit) return wholeHit

    for (const part of whole.split(/[()]/)) {
      const candidate = part.trim()
      if (!candidate) continue
      const partHit = ALIAS_LOOKUP.get(headerKey(candidate))
      if (partHit) return partHit
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

/** One vocabulary row: the stored code plus the human labels sheets may use. */
export type VocabOption = { code: string; labels: string[] }

export type ValidationContext = {
  defaultVariantCode: string
  variants: VocabOption[]
  statuses: VocabOption[]
  phases: VocabOption[]
}

/** Vocabulary comparison key: case-folded, spaces and underscores equivalent. */
const vocabKey = (value: string): string =>
  value.trim().toLowerCase().replace(/[\s_]+/g, ' ').trim()

/**
 * Resolve a sheet cell to a vocabulary **code**, or null if nothing matches.
 *
 * Sheets carry human labels ("In Stock", "Under Repair") while status_option.code
 * is snake_case ("in_stock"), so a code-only lookup would reject every real
 * spreadsheet. Match order: exact code, then case-folded code with spaces and
 * underscores treated as equivalent, then the same folding against labels.
 */
export function resolveVocab(value: string, options: VocabOption[]): string | null {
  const raw = value.trim()
  if (!raw) return null

  for (const option of options) {
    if (option.code === raw) return option.code
  }

  const key = vocabKey(raw)
  for (const option of options) {
    if (vocabKey(option.code) === key) return option.code
  }
  for (const option of options) {
    for (const label of option.labels ?? []) {
      if (vocabKey(label) === key) return option.code
    }
  }
  return null
}

export type ImportRowOutcome =
  | { unitNo: number; raw: Record<string, string>; status: 'valid'; parsed: ImportDeviceDraft; errors: [] }
  | { unitNo: number; raw: Record<string, string>; status: 'invalid' | 'needs_review'; errors: string[] }

const text = (v: string | undefined): string | null => (v?.trim() ? v.trim() : null)

/** A qty cell only counts as a cross-check when it reads as a positive integer. */
function parseQty(value: string | undefined): number | null {
  const raw = text(value)
  if (!raw) return null
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) return null
  return n
}

/**
 * Validate one sheet row, returning one outcome per physical unit.
 *
 * A row whose PCBA-A cell holds a range fans out: "…0001 to 0003" yields three
 * outcomes, each a complete device draft. PCBA-B and the screen serial expand
 * with it and pair in lockstep. Notation that cannot be expanded unambiguously —
 * or a row whose counts contradict each other — yields a single `needs_review`
 * outcome (the review queue) rather than a guess at a device's identity. Those
 * outcomes still carry the row's other validation errors, so one re-upload
 * clears everything the reviewer needs to fix.
 */
export function validateSheetRow(
  raw: Record<string, string>, ctx: ValidationContext,
): ImportRowOutcome[] {
  const hasContent = Object.values(raw).some((v) => (v ?? '').trim() !== '')
  if (!hasContent) return []

  // Serial expansion decides how many outcomes this row produces. Its failures
  // are review-queue material rather than validation errors, but they never
  // suppress the row's other errors — see rowErrors below.
  const paired = pairSerialRanges(raw.pcba_a_sn ?? '', raw.pcba_b_sn ?? null)
  const unitCount = 'error' in paired ? null : paired.units.length

  // Row-level errors apply identically to every unit the row produces, so they
  // are computed once — and before any early return, so an unexpandable serial
  // cannot hide a bad status or an impossible date.
  const rowErrors: string[] = []

  if (unitCount === 0) rowErrors.push('PCBA-A S/N is required')

  const rawVariant = text(raw.variant) ?? ctx.defaultVariantCode
  const variantCode = resolveVocab(rawVariant, ctx.variants)
  if (variantCode === null) {
    rowErrors.push(`Variant "${rawVariant}" is not in the vocabulary`)
  }

  const rawStatus = text(raw.status)
  let status: string | null = null
  if (rawStatus) {
    status = resolveVocab(rawStatus, ctx.statuses)
    if (status === null) rowErrors.push(`Status "${rawStatus}" is not in the vocabulary`)
  }
  const rawPhase = text(raw.phase)
  let phase: string | null = null
  if (rawPhase) {
    phase = resolveVocab(rawPhase, ctx.phases)
    if (phase === null) rowErrors.push(`Phase "${rawPhase}" is not in the vocabulary`)
  }

  let buildDate: string | null = null
  try { buildDate = parseSheetDate(raw.build_date) }
  catch (e) { rowErrors.push(`Build Date: ${(e as Error).message}`) }
  let shipDate: string | null = null
  try { shipDate = parseSheetDate(raw.ship_date) }
  catch (e) { rowErrors.push(`Ship Date: ${(e as Error).message}`) }

  if ('error' in paired) {
    return [{ unitNo: 1, raw, status: 'needs_review', errors: [paired.error, ...rowErrors] }]
  }

  // Contradictions between the row's own counts: nothing here is a value error,
  // it is a row a human has to split or correct.
  const reviewErrors: string[] = []

  // The screen serial ranges exactly like PCBA-B: expanded, then zipped.
  let screenSerials: string[] = []
  const screen = expandSerialRange(raw.screen_sn)
  if ('error' in screen) {
    reviewErrors.push(`Screen: ${screen.error}`)
  } else {
    screenSerials = screen.serials
    if (paired.units.length > 0 && screenSerials.length > 0 && screenSerials.length !== paired.units.length) {
      reviewErrors.push(
        `Screen (${screenSerials.length}) and PCBA-A (${paired.units.length}) counts differ — fix this row manually`)
    }
  }

  // A fanned row describes many devices but carries one device_sn cell.
  // device.device_sn is uniquely indexed, so replicating it would collide — and
  // silently dropping what the user typed is worse than asking.
  const deviceSn = text(raw.device_sn)
  if (paired.units.length > 1 && deviceSn) {
    reviewErrors.push(
      `Device S/N "${deviceSn}" cannot describe ${paired.units.length} devices — split this row into one per device, or clear the device serial`)
  }

  const qty = parseQty(raw.qty)
  if (paired.units.length > 0 && qty !== null && qty !== paired.units.length) {
    reviewErrors.push(
      `Qty (${qty}) and expanded serial count (${paired.units.length}) differ — fix this row manually`)
  }

  if (reviewErrors.length > 0) {
    return [{ unitNo: 1, raw, status: 'needs_review', errors: [...reviewErrors, ...rowErrors] }]
  }
  if (rowErrors.length > 0) {
    return [{ unitNo: 1, raw, status: 'invalid', errors: rowErrors }]
  }

  const screenModel = text(raw.screen_model)
  const hmiVer = text(raw.hmi_ver)

  // remarks is preserved verbatim — bilingual, multiline, never trimmed.
  const baseRemarks = raw.remarks != null && raw.remarks !== '' ? raw.remarks : null
  // No screen serial → no component_unit (serial_no is NOT NULL and inventing an
  // identity would be a lie), so the screen text rides along on remarks instead.
  const screenNote = screenSerials.length === 0 && (screenModel || hmiVer)
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
    if (screenSerials.length > 0) {
      components.push({
        typeCode: 'hmi_screen', serialNo: screenSerials[i],
        hwRev: screenModel, bomRev: null, fwVer: hmiVer,
      })
    }

    return {
      unitNo: i + 1, raw, status: 'valid' as const, errors: [] as [],
      parsed: {
        // Only an unfanned row can claim the device_sn cell; a fanned row that
        // carries one never reaches here (it is needs_review above).
        deviceSn: paired.units.length === 1 ? deviceSn : null,
        // variantCode is non-null here: an unresolvable variant is a rowError.
        variantCode: variantCode ?? rawVariant,
        status, phase,
        productName: text(raw.product_name), modelNo: text(raw.model_no),
        customer: text(raw.customer), destination: text(raw.destination),
        remarks, buildDate, shipDate, components,
      },
    }
  })
}
