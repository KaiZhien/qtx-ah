/**
 * Single source of truth for serial normalization and date parsing (§5.1.5).
 * Used by BOTH the form/edit path and the CSV import path.
 * Any change here applies everywhere automatically.
 */

/**
 * Normalize a serial number: uppercase and trim whitespace.
 * Returns empty string for null/undefined/empty input.
 */
export function normalizeSerial(value: string | null | undefined): string {
  if (value == null || value === '') return ''
  return value.trim().toUpperCase()
}

/**
 * Parse a date string to ISO format 'YYYY-MM-DD'.
 * Accepts:
 *   - DD/MM/YYYY  (spreadsheet format — the primary import format)
 *   - YYYY-MM-DD  (ISO passthrough)
 *   - null/undefined/'' → returns null
 * Throws a descriptive Error for invalid or ambiguous dates.
 */
export function parseSheetDate(value: string | null | undefined): string | null {
  if (value == null || value.trim() === '') return null

  const v = value.trim()

  // ISO passthrough
  const isoMatch = v.match(/^(\d{4})-(\d{2})-(\d{2})$/)
  if (isoMatch) {
    const [, y, m, d] = isoMatch
    validateDateParts(parseInt(d), parseInt(m), parseInt(y), v)
    return v
  }

  // DD/MM/YYYY
  const dmyMatch = v.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/)
  if (dmyMatch) {
    const day   = parseInt(dmyMatch[1])
    const month = parseInt(dmyMatch[2])
    const year  = parseInt(dmyMatch[3])
    validateDateParts(day, month, year, v)
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`
  }

  throw new Error(
    `Invalid date format: "${v}" (expected DD/MM/YYYY)`
  )
}

function validateDateParts(day: number, month: number, year: number, raw: string): void {
  if (month < 1 || month > 12) {
    throw new Error(`Invalid date: "${raw}" (month ${month} out of range 1–12)`)
  }
  const maxDay = daysInMonth(month, year)
  if (day < 1 || day > maxDay) {
    throw new Error(
      `Invalid date: "${raw}" (day ${day} out of range 1–${maxDay} for month ${month}/${year})`
    )
  }
}

function daysInMonth(month: number, year: number): number {
  return new Date(year, month, 0).getDate()
}

/**
 * Coerce a qty value to an integer.
 * Returns null for null/undefined/empty string.
 * Throws for negative numbers or clearly non-numeric text.
 */
export function coerceQty(value: string | number | null | undefined): number | null {
  if (value == null || value === '') return null

  const str = String(value).trim()
  if (str === '') return null

  const n = Number(str)
  if (isNaN(n)) {
    throw new Error(`Invalid qty: "${str}" is not a number`)
  }
  if (n < 0) {
    throw new Error(`Invalid qty: "${str}" must be non-negative`)
  }

  return Math.round(n)
}
