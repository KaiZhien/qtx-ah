import { ImportParseError } from '@/modules/manufacturing/domain/importErrors'

/**
 * Minimal RFC-4180 CSV reader: a body → a grid of physical lines. Pure, no I/O.
 *
 * Three properties are load-bearing for the importer that consumes this, and all
 * three are the reason it is a hand-rolled reader with tests rather than a
 * one-line split:
 *
 * 1. **A quote only quotes when it opens the field.** Traceability sheets are
 *    full of inch marks — `10.1" HMI` is a real Screen Model value. Treating a
 *    mid-field quote as the start of a quoted field swallows the delimiter, the
 *    newline, and every remaining row of the file into one field, and the import
 *    then reports success having silently dropped them. A `"` is only special as
 *    the first character of a field; anywhere else it is literal text.
 *
 * 2. **An unterminated quoted field throws.** Truncating a traceability file in
 *    silence is the worst possible failure: the batch looks complete. Loud is
 *    the only safe option.
 *
 * 3. **Every physical line becomes a row, blank ones included.** The importer
 *    stores `source_row_no` so a reviewer can open the file and look at "row 42".
 *    Filtering blank lines out here would renumber every row below them. A blank
 *    row is dropped later, by validateSheetRow returning no outcomes for a
 *    contentless row — the same path the xlsx reader relies on.
 *
 * Only **unquoted** fields are trimmed. A quoted field is returned exactly as
 * written, because `remarks` is documented as preserved verbatim (bilingual,
 * multiline, never trimmed) and quoting is the only way a CSV can express
 * padding or a leading newline at all. The single exception is a `\r` directly
 * before a `\n`: a CRLF file's quoted multi-line values would otherwise carry
 * `\r\n` while every other path yields `\n`.
 */
export function readCsvGrid(body: string): string[][] {
  const grid: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false    // currently inside a quoted field
  let fieldQuoted = false // this field opened with a quote (so: do not trim it)

  const endField = () => {
    row.push(fieldQuoted ? field : field.trim())
    field = ''
    fieldQuoted = false
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
      field += ch
      continue
    }

    // Property 1: only a quote at the very start of a field opens quoting.
    if (ch === '"' && field === '' && !fieldQuoted) {
      inQuotes = true
      fieldQuoted = true
      continue
    }
    if (ch === ',') { endField(); continue }
    if (ch === '\r') continue
    if (ch === '\n') { endField(); grid.push(row); row = []; continue }
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
  if (field !== '' || fieldQuoted || row.length > 0) { endField(); grid.push(row) }
  return grid
}
