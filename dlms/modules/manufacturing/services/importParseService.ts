import { createHash } from 'node:crypto'
import { z } from 'zod'
import ExcelJS from 'exceljs'
import { withTransaction, type Tx } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'
import { ImportParseError } from '@/modules/manufacturing/domain/importErrors'
import { readCsvGrid, type CsvRow } from '@/modules/manufacturing/domain/csvGrid'
import {
  mapHeaders, resolveHeader, validateSheetRow, type ImportField, type ImportRowOutcome,
  type ValidationContext,
} from '@/modules/manufacturing/domain/importMapping'

// Declared in modules/manufacturing/domain/importErrors.ts so the pure readers
// can throw it without a cycle; re-exported here because this service is the
// public face of the parse path.
export { ImportParseError }

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
const HEADER_SCAN_ROWS = 10

/** Rows below the header are inserted in chunks rather than one statement each. */
const INSERT_CHUNK = 500

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
  //
  // Both readers report a physical row number per record rather than leaving it
  // to be inferred: a workbook grid is dense and indexed by sheet row, so
  // index + 1 *is* the sheet row, while a CSV record can span several lines
  // (a quoted newline) and so carries its own.
  const rows: CsvRow[] = data.kind === 'xlsx'
    ? (await readWorkbook(data.bytes)).map((cells, i) => ({ lineNo: i + 1, cells }))
    : readCsvGrid(new TextDecoder().decode(data.bytes))

  const header = findHeaderRow(rows)
  if (header === null) {
    throw new ImportParseError(
      'Could not find a header row — the sheet needs a "Device S/N" or "PCBA-A S/N" column '
      + 'header within its first 10 rows.')
  }
  const { columns, unmapped } = header.mapped

  const ctx = await loadValidationContext(actor, data.defaultVariantCode)

  // Stage every outcome, then mark repeat serials invalid. Doing it here rather
  // than at commit means the reviewer sees the collision before committing
  // anything, instead of a row failing on component_unit_sn mid-batch.
  const staged: Array<{ sourceRowNo: number; outcome: ImportRowOutcome }> = []
  for (let r = header.index + 1; r < rows.length; r++) {
    const raw: Record<string, string> = {}
    rows[r].cells.forEach((cell, c) => {
      const field: ImportField | null = columns[c] ?? null
      if (field && cell !== '') raw[field] = cell
    })
    for (const outcome of validateSheetRow(raw, ctx)) {
      // The record's own line number, never its array index: the reviewer opens
      // the file at this row, and a multi-line quoted cell above would have
      // shifted an index-derived number off by every extra line it spans.
      staged.push({ sourceRowNo: rows[r].lineNo, outcome })
    }
  }
  markDuplicateSerials(staged)

  // An empty batch is never a success: it means a decoy banner was read as the
  // header, or the file is header-only, or a semicolon-delimited CSV collapsed
  // into one column. Thrown here, before any transaction opens, so no batch row
  // can survive to be reviewed as "0 rows, all good".
  if (staged.length === 0) {
    throw new ImportParseError(
      `Found a header row (sheet row ${rows[header.index].lineNo}) but no data rows below it — `
      + 'nothing was staged. Check that the rows sit under the header, and that a CSV is '
      + 'comma-separated.')
  }

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

    await insertStagedRows(tx, batchId, actor.id, staged)

    const count = (s: string) => staged.filter((x) => x.outcome.status === s).length
    return {
      batchId, rowCount: staged.length,
      valid: count('valid'), invalid: count('invalid'), needsReview: count('needs_review'),
      unmappedHeaders: unmapped,
    }
  })
}

/**
 * First row carrying a marker cell that is *itself* a recognised column header,
 * with that row's header map — or null.
 *
 * Containing a marker is not enough: a banner reading "QTX Traceability Report —
 * Device S/N master list" contains one, and picking it as the header maps zero
 * columns and stages zero rows while reporting success. Requiring the
 * marker-bearing cell to resolve to a field via resolveHeader is what separates a
 * table header from prose that mentions a column name — and, unlike counting
 * mapped fields, it does not reject the legitimately minimal sheets that carry a
 * single serial column, or a serial column plus one unrecognised one.
 *
 * The map is returned rather than recomputed by the caller: mapHeaders is a pure
 * function of the row, and running it twice on the winning row invites the two
 * results drifting apart.
 */
function findHeaderRow(
  rows: CsvRow[],
): { index: number; mapped: ReturnType<typeof mapHeaders> } | null {
  const limit = Math.min(rows.length, HEADER_SCAN_ROWS)
  for (let r = 0; r < limit; r++) {
    const { cells } = rows[r]
    const named = cells.some((cell) =>
      HEADER_MARKERS.some((m) => cell.includes(m)) && resolveHeader(cell) !== null)
    if (named) return { index: r, mapped: mapHeaders(cells) }
  }
  return null
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
 * Insert the staged rows in chunked multi-row statements.
 *
 * One sheet row can legitimately expand to thousands of units, so a
 * statement-per-row turns a modest file into tens of thousands of sequential
 * round-trips while holding one of only ten pooled connections. Every chunk runs
 * inside the caller's transaction, so a failure anywhere still stages nothing.
 *
 * `status` is always written explicitly: the column defaults to 'needs_review'
 * precisely so a forgotten status cannot masquerade as ready-to-commit, and
 * leaning on that default would silently reclassify valid rows.
 */
async function insertStagedRows(
  tx: Tx, batchId: string, actorId: string,
  staged: Array<{ sourceRowNo: number; outcome: ImportRowOutcome }>,
): Promise<void> {
  const COLS = 8
  for (let start = 0; start < staged.length; start += INSERT_CHUNK) {
    const chunk = staged.slice(start, start + INSERT_CHUNK)
    const values: unknown[] = []
    const tuples = chunk.map(({ sourceRowNo, outcome }, n) => {
      values.push(
        batchId, sourceRowNo, outcome.unitNo, JSON.stringify(outcome.raw),
        // parsed is non-null only for a valid row (the column's contract).
        outcome.status === 'valid' ? JSON.stringify(outcome.parsed) : null,
        JSON.stringify(outcome.errors), outcome.status, actorId)
      const b = n * COLS
      return `($${b + 1},$${b + 2},$${b + 3},$${b + 4},$${b + 5},$${b + 6},$${b + 7},$${b + 8})`
    })
    await tx.query(
      `INSERT INTO import_row
         (batch_id, source_row_no, unit_no, raw, parsed, errors, status, created_by)
       VALUES ${tuples.join(',')}`, values)
  }
}

/**
 * Two rows claiming the same component serial cannot both become devices — the
 * second would collide on component_unit_sn, which is unique on
 * (component_type_id, serial_no). So every component of every row is checked,
 * not just the PCBA-A one: a shared PCBA-B or screen serial collides just as
 * hard. The first claimant wins; later ones are marked invalid, naming the
 * claiming row *and unit* (a fanned row shares its source_row_no across units,
 * so the row number alone would not identify it).
 */
function markDuplicateSerials(
  staged: Array<{ sourceRowNo: number; outcome: ImportRowOutcome }>,
): void {
  const claimed = new Map<string, { sourceRowNo: number; unitNo: number }>()
  for (const entry of staged) {
    const { outcome } = entry
    if (outcome.status !== 'valid') continue

    // Collisions are gathered before anything is claimed, so a row that is about
    // to be rejected never takes a serial its other components would then own.
    const collisions: string[] = []
    for (const component of outcome.parsed.components) {
      const owner = claimed.get(`${component.typeCode}:${component.serialNo}`)
      if (owner) {
        collisions.push(
          `Duplicate ${component.typeCode} serial "${component.serialNo}" — already claimed by `
          + `sheet row ${owner.sourceRowNo}, unit ${owner.unitNo}`)
      }
    }
    if (collisions.length > 0) {
      entry.outcome = {
        unitNo: outcome.unitNo, raw: outcome.raw, status: 'invalid', errors: collisions,
      }
      continue
    }
    for (const component of outcome.parsed.components) {
      claimed.set(`${component.typeCode}:${component.serialNo}`,
        { sourceRowNo: entry.sourceRowNo, unitNo: outcome.unitNo })
    }
  }
}

/** The tab a real traceability workbook keeps the table on, matched loosely. */
const PREFERRED_SHEET = 'traceability'

/**
 * Workbook → a dense string grid, indexed so that index + 1 is the sheet row.
 *
 * A formula cell yields its cached result when the writer stored one, and empty
 * otherwise — see cellText.
 *
 * The whole read is wrapped, not just the load: a workbook that opens but is
 * internally malformed throws from eachRow/cellText instead, and that must reach
 * the uploader as the same "this file is not readable" message rather than as a
 * raw library error the action layer would report as a server bug.
 */
async function readWorkbook(bytes: Uint8Array): Promise<string[][]> {
  try {
    const wb = new ExcelJS.Workbook()
    // bytes.slice() copies into a buffer whose byteOffset is 0. Passing
    // bytes.buffer directly hands ExcelJS the wrong bytes whenever the array is a
    // view into a larger allocation.
    await wb.xlsx.load(bytes.slice().buffer)
    if (wb.worksheets.length === 0) throw new ImportParseError('The workbook has no sheets.')

    // Matched case- and whitespace-insensitively: a tab named "traceability" or
    // " Traceability " must not fall through to worksheets[0], which on a real
    // workbook is often a cover/legend sheet — parsing that "succeeds" with the
    // wrong data, the worst kind of failure here.
    const ws = wb.worksheets.find((s) => s.name.trim().toLowerCase() === PREFERRED_SHEET)
      ?? wb.worksheets[0]
    const grid: string[][] = []
    ws.eachRow({ includeEmpty: true }, (row, rowNumber) => {
      const cells: string[] = []
      row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
        cells[colNumber - 1] = cellText(cell.value)
      })
      grid[rowNumber - 1] = Array.from(cells, (c) => c ?? '')
    })
    return Array.from(grid, (r) => r ?? [])
  } catch (err) {
    // Already translated (no sheets): pass it through untouched, so it is neither
    // logged twice nor reworded into "not a real .xlsx".
    if (err instanceof ImportParseError) throw err
    // A CSV sent as xlsx, a PDF, random bytes or a truncated upload all surface a
    // JSZip internal ("Can't find end of central directory : is this a zip file ?").
    // Translating it is what lets the action layer tell a bad upload from a server
    // bug — and keeps a library internal away from the uploader. The original is
    // logged once and travels as `cause`, so nothing is swallowed.
    console.error(JSON.stringify({
      level: 'error', msg: 'xlsx read failed', err: (err as Error).message,
    }))
    throw new ImportParseError(
      'Could not read the file as an Excel workbook — check that it is a real .xlsx file '
      + 'and not a renamed CSV, a PDF, or a partial upload.', { cause: err })
  }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null

/**
 * One ExcelJS cell value → text.
 *
 * ExcelJS models a cell as one of several object shapes, and String() on any of
 * them yields the literal "[object Object]" — which, in a serial column, would
 * stage a device whose permanent traceability record reads "[OBJECT OBJECT]". So
 * every shape is handled explicitly and anything unrecognised returns empty.
 *
 * Empty is the deliberate fail-closed choice: a blank required serial makes the
 * row invalid with "PCBA-A S/N is required", which a reviewer sees and fixes. A
 * confidently-wrong serial is permanent.
 */
function cellText(value: unknown): string {
  if (value == null) return ''
  let v: unknown = value

  // A formula cell carries the result the writer cached. Many generators write
  // none (they expect Excel to recalculate on open), and a formula that evaluated
  // to #N/A caches an error object — neither is a value we may invent.
  if (isRecord(v) && ('formula' in v || 'sharedFormula' in v)) {
    if (!('result' in v)) return ''
    v = (v as { result?: unknown }).result ?? null
  }
  if (v == null) return ''

  // Dates are re-rendered as DD/MM/YYYY so parseSheetDate handles them on the
  // same path as text dates. The UTC accessors are load-bearing, not a style
  // choice: ExcelJS converts a date serial to UTC midnight, so getDate() on any
  // host west of UTC reads the previous calendar day and stores the build date
  // one day early. Do not "simplify" these to the local getters.
  if (v instanceof Date) {
    return `${String(v.getUTCDate()).padStart(2, '0')}/`
      + `${String(v.getUTCMonth() + 1).padStart(2, '0')}/${v.getUTCFullYear()}`
  }

  if (isRecord(v)) {
    // Rich text: a partly-bold serial arrives as segments to be joined in order.
    const rich = (v as { richText?: unknown }).richText
    if (Array.isArray(rich)) {
      return rich
        .map((seg) => (isRecord(seg) && typeof seg.text === 'string' ? seg.text : ''))
        .join('').trim()
    }
    // An error cell (#N/A, #REF!, …) has no value to read.
    if ('error' in v) return ''
    // A hyperlink cell keeps its display text in .text, which is itself either a
    // string or a rich-text object.
    if ('hyperlink' in v || 'text' in v) return cellText((v as { text?: unknown }).text)
    return ''
  }

  return String(v).trim()
}
