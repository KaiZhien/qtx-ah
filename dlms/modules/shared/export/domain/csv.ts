/**
 * RFC 4180 CSV with a UTF-8 BOM (spec §12 full-system export).
 *
 * Pure and Buffer-returning: the caller hashes the exact bytes it will ship, so
 * the manifest's sha256 certifies the file rather than a re-encoding of it.
 *
 * THE BOM IS NOT DECORATION. This fleet's data is bilingual — device remarks,
 * serials like "EE-0001至0015", Chinese product names. Excel on Windows opens a
 * BOM-less UTF-8 CSV in the system ANSI codepage and mojibakes every one of them,
 * and the analyst reading the export is the person least able to diagnose that.
 */

export const CSV_BOM = '﻿'
export const CSV_EOL = '\r\n'

/** Fields needing quotes per RFC 4180 §2.6. */
const NEEDS_QUOTING = /[",\r\n]/

/**
 * One field, rendered and quoted.
 *
 * VALUES ARE VERBATIM — including ones that look like spreadsheet formulas
 * (`=`, `+`, `-`, `@`). The usual mitigation is to prefix a quote, and it is
 * deliberately NOT applied here: an export is a fidelity artifact whose manifest
 * sha256 is meant to certify what the database actually held, and silently
 * altering a `remarks` field would make the certificate a lie. The control the
 * spec chose for this export is the requester ceremony (Super Admin + fresh MFA),
 * not field mangling. The generated README.md warns the recipient to open the
 * CSVs as text/data rather than by double-clicking into Excel.
 *
 * null and undefined both render as an EMPTY field. CSV has no null, so the
 * distinction is genuinely lost here — which is one of the reasons spec §12 pairs
 * the CSVs with JSON for the nested/history sets.
 */
export function csvField(value: unknown): string {
  if (value === null || value === undefined) return ''

  const raw =
    value instanceof Date ? value.toISOString()
    : typeof value === 'object' ? JSON.stringify(value)
    : String(value)

  return NEEDS_QUOTING.test(raw) ? `"${raw.replace(/"/g, '""')}"` : raw
}

/**
 * A full CSV file: BOM, header row, one line per row, every line CRLF-terminated
 * (including the last — so concatenating or appending is well-defined).
 *
 * Rows are read BY COLUMN NAME, so `columns` is the file's contract: reordering
 * it reorders the output, and a column absent from a row renders empty rather
 * than throwing. Zero rows still produces a header — an entity with no rows must
 * appear in the export as an empty table, not as a missing file, or the recipient
 * cannot tell "none" from "not exported".
 */
export function toCsv(
  columns: readonly string[],
  rows: readonly Record<string, unknown>[],
): Buffer {
  const lines = [columns.map(csvField).join(',')]
  for (const row of rows) {
    lines.push(columns.map((c) => csvField(row[c])).join(','))
  }
  return Buffer.from(CSV_BOM + lines.join(CSV_EOL) + CSV_EOL, 'utf8')
}
