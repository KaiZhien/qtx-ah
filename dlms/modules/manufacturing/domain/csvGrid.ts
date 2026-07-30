import { ImportParseError } from '@/modules/manufacturing/domain/importErrors'

/**
 * One CSV record: the 1-based physical line it **starts** on, plus its fields.
 *
 * The line number is reported rather than inferred from the array index because
 * a record and a line are not the same thing — a quoted field may contain a
 * newline, so one record can span several lines. The importer stores this as
 * `source_row_no`, which is the number a reviewer types into their spreadsheet
 * to find "row 42"; an index would silently point at the wrong row for every
 * record below a multi-line value.
 */
export type CsvRow = { lineNo: number; cells: string[] }

/**
 * Minimal RFC-4180 CSV reader: a body → records with their line numbers. Pure,
 * no I/O.
 *
 * Three properties are load-bearing for the importer that consumes this, and all
 * three are the reason it is a hand-rolled reader with tests rather than a
 * one-line split:
 *
 * 1. **A quote only quotes when it opens the field.** Traceability sheets are
 *    full of inch marks — `10.1" HMI` is a real Screen Model value. Treating a
 *    mid-field quote as the start of a quoted field swallows the delimiter, the
 *    newline, and every remaining row of the file into one field, and the import
 *    then reports success having silently dropped them. A `"` is only special
 *    while the field is still empty; once any non-whitespace character has been
 *    read it is literal text. Whitespace does *not* count as a start: a writer
 *    that emits `a, "b,c" ,d` still means three fields, and treating that quote
 *    as literal shifts every later column — a silent corruption rather than a
 *    failure. Leading whitespace before an opening quote is dropped with the
 *    quote itself.
 *
 * 2. **An unterminated quoted field throws.** Truncating a traceability file in
 *    silence is the worst possible failure: the batch looks complete. Loud is
 *    the only safe option.
 *
 * 3. **Every physical line yields a record, blank ones included — and each one
 *    reports the line it started on.** Blank lines are kept because filtering
 *    them here would renumber everything below them; a blank row is dropped
 *    later, by validateSheetRow returning no outcomes for a contentless row (the
 *    same path the xlsx reader relies on). A record that consumed a quoted
 *    newline advances the line counter without emitting a record, so `lineNo`
 *    stays true to the file rather than counting records.
 *
 * Only **unquoted** fields are trimmed. A quoted field is returned exactly as
 * written, because `remarks` is documented as preserved verbatim (bilingual,
 * multiline, never trimmed) and quoting is the only way a CSV can express
 * padding or a leading newline at all. The single exception is a `\r` directly
 * before a `\n`: a CRLF file's quoted multi-line values would otherwise carry
 * `\r\n` while every other path yields `\n`.
 */
export function readCsvGrid(body: string): CsvRow[] {
  const rows: CsvRow[] = []
  let cells: string[] = []
  let field = ''
  let inQuotes = false    // currently inside a quoted field
  let fieldQuoted = false // this field opened with a quote (so: do not trim it)
  let line = 1            // physical line the reader is on
  let rowLine = 1         // physical line the record being read started on

  const endField = () => {
    cells.push(fieldQuoted ? field : field.trim())
    field = ''
    fieldQuoted = false
  }
  const endRow = () => {
    endField()
    rows.push({ lineNo: rowLine, cells })
    cells = []
  }

  for (let i = 0; i < body.length; i++) {
    const ch = body[i]

    if (inQuotes) {
      if (ch === '"') {
        // "" is an escaped literal quote; a lone " closes the field. Anything
        // after the close is appended literally.
        if (body[i + 1] === '"') { field += '"'; i++ } else { inQuotes = false }
        continue
      }
      // Normalise a CRLF line break inside a quoted value to a bare LF.
      if (ch === '\r' && body[i + 1] === '\n') continue
      // A newline inside a quoted value is content, but it is still a physical
      // line: count it so the next record's lineNo matches the file.
      if (ch === '\n') line++
      field += ch
      continue
    }

    // Property 1: a quote opens quoting only while the field is still empty —
    // whitespace-only counts as empty, and is discarded along with the quote.
    if (ch === '"' && !fieldQuoted && field.trim() === '') {
      field = ''
      inQuotes = true
      fieldQuoted = true
      continue
    }
    if (ch === ',') { endField(); continue }
    if (ch === '\r') continue
    if (ch === '\n') { endRow(); line++; rowLine = line; continue }
    field += ch
  }

  // Property 2: never return a silently truncated grid.
  if (inQuotes) {
    throw new ImportParseError(
      'The CSV has an unterminated quoted field — a " opened a field that is never closed, '
      + 'so the rest of the file cannot be read as rows. Check for a stray double quote '
      + '(an inch mark such as 10.1" only needs quoting if the cell also contains a comma).')
  }

  // A final line with no terminating newline still counts. fieldQuoted covers a
  // last field written as "" — empty, but present.
  if (field !== '' || fieldQuoted || cells.length > 0) endRow()
  return rows
}
