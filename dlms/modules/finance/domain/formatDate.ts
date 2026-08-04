/**
 * Display formatting for 'YYYY-MM-DD' calendar dates. Pure, no I/O.
 *
 * Extracted after the third copy appeared (DeviceWarrantyPanel, the warranties
 * page, invoicePdfModel). The IMPLEMENTATION is the point, not the deduplication:
 * it slices the string and never constructs a Date.
 *
 * `new Date('2026-01-01').toLocaleDateString()` parses the string as UTC midnight
 * and formats it in the HOST's timezone, so anywhere west of Greenwich it renders
 * 31 Dec 2025. On a warranty end date that silently moves the last day of cover;
 * on an invoice issue date it moves a legal fact. If this ever gets "simplified"
 * to use Date, both regress at once.
 */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/

/**
 * '2026-01-01' -> '01 Jan 2026'.
 *
 * Anything that is not a well-formed ISO date is returned verbatim rather than
 * coerced — showing the raw stored value beats inventing a plausible-looking
 * wrong date. `null`/`undefined` render as `fallback` (an em dash by default).
 */
export function formatIsoDate(iso: string | null | undefined, fallback = '—'): string {
  if (!iso) return fallback
  const m = ISO_DATE.exec(iso)
  if (!m) return iso
  const month = MONTHS[Number(m[2]) - 1]
  return month ? `${m[3]} ${month} ${m[1]}` : iso
}
