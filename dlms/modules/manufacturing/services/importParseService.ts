import { createHash } from 'node:crypto'
import { z } from 'zod'
import ExcelJS from 'exceljs'
import { withTransaction } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'
import {
  mapHeaders, validateSheetRow, type ImportField, type ImportRowOutcome,
  type ValidationContext,
} from '@/modules/manufacturing/domain/importMapping'

export class ImportParseError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportParseError'
  }
}

export type StagedBatch = {
  batchId: string; rowCount: number
  valid: number; invalid: number; needsReview: number
  unmappedHeaders: string[]
}

const stageSchema = z.object({
  filename: z.string().min(1).max(255),
  kind: z.enum(['xlsx', 'csv']),
  // Written as z.custom rather than z.instanceof(Uint8Array): the latter infers
  // Uint8Array<ArrayBuffer> (TypeScript 5.7 parameterised the typed arrays and
  // the constructor's instance type pins the buffer), which rejects the plain
  // Uint8Array callers legitimately hold — a Node Buffer, or any view whose
  // buffer type is only known as ArrayBufferLike. The runtime guard is identical.
  bytes: z.custom<Uint8Array>(
    (v) => v instanceof Uint8Array, 'Expected the file body as a Uint8Array'),
  defaultVariantCode: z.string().min(1).max(50),
})
export type StageImportInput = z.input<typeof stageSchema>

// A header row is one that names a serial column — the only columns the sheet
// cannot omit. Scanning the first 10 rows tolerates the title/legend banners
// real traceability workbooks carry above the table.
const HEADER_MARKERS = ['Device S/N', '设备序列号', 'PCBA-A S/N', '电源板序列号']

/**
 * Parse an uploaded spreadsheet and stage it as an import_batch + import_rows.
 *
 * Writes no devices. Parsing happens entirely server-side and the parsed drafts
 * live in the database, so the commit step (importCommitService) re-reads them
 * rather than trusting anything the browser sends back.
 */
export async function stageImportFile(
  actor: Actor, input: StageImportInput,
): Promise<StagedBatch> {
  authorize(actor, 'import_data', 'manufacturing')
  const data = stageSchema.parse(input)

  // Parse outside the transaction — ExcelJS on a large workbook must not hold a
  // pooled connection open.
  const grid = data.kind === 'xlsx'
    ? await readWorkbook(data.bytes)
    : readCsv(new TextDecoder().decode(data.bytes))

  const headerIdx = grid.findIndex((row) =>
    row.some((cell) => HEADER_MARKERS.some((m) => cell.includes(m))))
  if (headerIdx === -1 || headerIdx > 9) {
    throw new ImportParseError(
      'Could not find a header row — the sheet needs a "Device S/N" or "PCBA-A S/N" column in its first 10 rows.')
  }

  const { columns, unmapped } = mapHeaders(grid[headerIdx])

  const ctx = await loadValidationContext(actor, data.defaultVariantCode)

  // Stage every outcome, then mark repeat serials invalid. Doing it here rather
  // than at commit means the reviewer sees the collision before committing
  // anything, instead of a row failing on component_unit_sn mid-batch.
  const staged: Array<{ sourceRowNo: number; outcome: ImportRowOutcome }> = []
  for (let r = headerIdx + 1; r < grid.length; r++) {
    const raw: Record<string, string> = {}
    grid[r].forEach((cell, c) => {
      const field: ImportField | null = columns[c] ?? null
      if (field && cell !== '') raw[field] = cell
    })
    for (const outcome of validateSheetRow(raw, ctx)) {
      staged.push({ sourceRowNo: r + 1, outcome })  // 1-based, matches the spreadsheet
    }
  }
  markDuplicateSerials(staged)

  const sha256 = createHash('sha256').update(data.bytes).digest('hex')

  return withTransaction(actor.id, async (tx) => {
    const { rows: vRows } = await tx.query<{ id: string }>(
      `SELECT id FROM device_variant WHERE code = $1 AND active`, [data.defaultVariantCode])
    if (vRows.length === 0) {
      throw new ImportParseError(`Unknown or inactive variant: ${data.defaultVariantCode}`)
    }

    const { rows: bRows } = await tx.query<{ id: string }>(
      `INSERT INTO import_batch
         (source_filename, source_sha256, source_kind, default_variant_id,
          row_count, unmapped_headers, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id`,
      [data.filename, sha256, data.kind, vRows[0].id, staged.length,
       JSON.stringify(unmapped), actor.id])
    const batchId = bRows[0].id

    for (const { sourceRowNo, outcome } of staged) {
      await tx.query(
        `INSERT INTO import_row
           (batch_id, source_row_no, unit_no, raw, parsed, errors, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
        [batchId, sourceRowNo, outcome.unitNo, JSON.stringify(outcome.raw),
         outcome.status === 'valid' ? JSON.stringify(outcome.parsed) : null,
         JSON.stringify(outcome.errors), outcome.status, actor.id])
    }

    const count = (s: string) => staged.filter((x) => x.outcome.status === s).length
    return {
      batchId, rowCount: staged.length,
      valid: count('valid'), invalid: count('invalid'), needsReview: count('needs_review'),
      unmappedHeaders: unmapped,
    }
  })
}

/**
 * Live vocabulary — statuses/phases/variants are admin-editable rows, not
 * constants. Labels travel alongside codes because real traceability sheets
 * carry human labels ("In Stock", "Production"), not the snake_case codes;
 * resolveVocab in the domain matches either.
 */
async function loadValidationContext(
  actor: Actor, defaultVariantCode: string,
): Promise<ValidationContext> {
  return withTransaction(actor.id, async (tx) => {
    const { rows: variants } = await tx.query<{ code: string; name: string }>(
      `SELECT code, name FROM device_variant WHERE active`)
    const { rows: statuses } = await tx.query<{
      code: string; label_en: string; label_zh: string }>(
      `SELECT code, label_en, label_zh FROM status_option WHERE active`)
    const { rows: phases } = await tx.query<{
      code: string; label_en: string; label_zh: string }>(
      `SELECT code, label_en, label_zh FROM phase_option WHERE active`)
    return {
      defaultVariantCode,
      variants: variants.map((v) => ({ code: v.code, labels: [v.name] })),
      statuses: statuses.map((s) => ({ code: s.code, labels: [s.label_en, s.label_zh] })),
      phases: phases.map((p) => ({ code: p.code, labels: [p.label_en, p.label_zh] })),
    }
  })
}

/**
 * Two rows claiming the same PCBA-A serial cannot both become devices — the
 * second would collide on component_unit_sn. The first wins; later ones are
 * marked invalid, naming the row that took it.
 */
function markDuplicateSerials(
  staged: Array<{ sourceRowNo: number; outcome: ImportRowOutcome }>,
): void {
  const claimed = new Map<string, number>()
  for (const entry of staged) {
    const { outcome } = entry
    if (outcome.status !== 'valid') continue
    const primary = outcome.parsed.components[0]?.serialNo
    if (!primary) continue
    const owner = claimed.get(primary)
    if (owner !== undefined) {
      entry.outcome = {
        unitNo: outcome.unitNo, raw: outcome.raw, status: 'invalid',
        errors: [`Duplicate serial "${primary}" — already claimed by sheet row ${owner}`],
      }
    } else {
      claimed.set(primary, entry.sourceRowNo)
    }
  }
}

/** Workbook → a dense string grid. Formula cells yield their computed result. */
async function readWorkbook(bytes: Uint8Array): Promise<string[][]> {
  const wb = new ExcelJS.Workbook()
  // bytes.slice() copies into a buffer whose byteOffset is 0. Passing
  // bytes.buffer directly hands ExcelJS the wrong bytes whenever the array is a
  // view into a larger allocation.
  await wb.xlsx.load(bytes.slice().buffer)
  if (wb.worksheets.length === 0) throw new ImportParseError('The workbook has no sheets.')

  const ws = wb.getWorksheet('Traceability') ?? wb.worksheets[0]
  const grid: string[][] = []
  ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
    const cells: string[] = []
    row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
      cells[colNumber - 1] = cellText(cell.value)
    })
    grid[rowNumber - 1] = Array.from(cells, (c) => c ?? '')
  })
  return Array.from(grid, (r) => r ?? [])
}

function cellText(value: unknown): string {
  if (value == null) return ''
  let v: unknown = value
  if (typeof v === 'object' && v !== null && 'result' in v) {
    v = (v as { result?: unknown }).result ?? null
  }
  if (v == null) return ''
  // Dates are re-rendered as DD/MM/YYYY so parseSheetDate handles them on the
  // same path as text dates.
  if (v instanceof Date) {
    return `${String(v.getDate()).padStart(2, '0')}/${String(v.getMonth() + 1).padStart(2, '0')}/${v.getFullYear()}`
  }
  return String(v).trim()
}

/** Minimal RFC-4180 CSV reader: quoted fields, doubled quotes, embedded newlines. */
function readCsv(body: string): string[][] {
  const grid: string[][] = []
  let row: string[] = []
  let field = ''
  let quoted = false

  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (quoted) {
      if (ch === '"') {
        if (body[i + 1] === '"') { field += '"'; i++ } else { quoted = false }
      } else field += ch
      continue
    }
    if (ch === '"') { quoted = true; continue }
    if (ch === ',') { row.push(field.trim()); field = ''; continue }
    if (ch === '\r') continue
    if (ch === '\n') { row.push(field.trim()); grid.push(row); row = []; field = ''; continue }
    field += ch
  }
  if (field !== '' || row.length > 0) { row.push(field.trim()); grid.push(row) }
  return grid.filter((r) => r.some((c) => c !== ''))
}
