/**
 * Pure cell coercion for the bulk-import path. No I/O.
 *
 * Ported from the legacy lib/domain/normalize.ts, which serves the legacy
 * device table. Deliberately a copy, not an import: the legacy module is part
 * of the frozen /legacy app and the module boundary rule forbids reaching into
 * it. Behaviour is identical so a sheet parses the same on both paths.
 */

/** Uppercase + trim. '' for nullish/blank input. */
export function normalizeSerial(value: string | null | undefined): string {
  if (value == null) return ''
  return value.trim().toUpperCase()
}

/**
 * Parse a sheet date to 'YYYY-MM-DD'. Accepts DD/MM/YYYY (the spreadsheet
 * convention in this data) and ISO passthrough. Blank → null. Anything else,
 * including calendar-impossible dates like 31/02, throws.
 */
export function parseSheetDate(value: string | null | undefined): string | null {
  if (value == null || value.trim() === '') return null
  const v = value.trim()

  const iso = v.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (iso) {
    validateDateParts(parseInt(iso[3], 10), parseInt(iso[2], 10), parseInt(iso[1], 10), v)
    return v
  }

  const dmy = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (dmy) {
    const day = parseInt(dmy[1], 10)
    const month = parseInt(dmy[2], 10)
    const year = parseInt(dmy[3], 10)
    validateDateParts(day, month, year, v)
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }

  throw new Error(`Invalid date format: "${v}" (expected DD/MM/YYYY)`)
}

function validateDateParts(day: number, month: number, year: number, raw: string): void {
  if (month < 1 || month > 12) {
    throw new Error(`Invalid date: "${raw}" (month ${month} out of range 1–12)`)
  }
  const maxDay = new Date(year, month, 0).getDate()
  if (day < 1 || day > maxDay) {
    throw new Error(
      `Invalid date: "${raw}" (day ${day} out of range 1–${maxDay} for month ${month}/${year})`)
  }
}
