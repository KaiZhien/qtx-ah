/**
 * Pure warranty-status domain (spec §6.3 post-sales: `warranty` — device FK
 * unique, start/end dates, terms, "status derived from dates — never stored
 * stale").
 *
 * THE INVARIANT THIS FILE EXISTS TO PROTECT: a warranty's status is a FUNCTION
 * of (start_date, end_date, today). There is no `status` column on `warranty`
 * and there must never be one. A stored status is wrong the moment the clock
 * passes midnight and nothing wrote to the row — and nothing does write to the
 * row, because expiry is the passage of time, not an event. See the migration
 * 20260803120000_platform_finance_warranty.sql header for the same argument in
 * SQL terms.
 *
 * No I/O. `today` is injected as a 'YYYY-MM-DD' string, the house convention for
 * every date-sensitive domain module here.
 *
 * DATES ARE CALENDAR DAYS, NOT INSTANTS. Every function parses 'YYYY-MM-DD'
 * into a UTC epoch-day integer and does integer arithmetic. It never constructs
 * a local-time Date and never subtracts milliseconds: `(new Date(a) - new
 * Date(b)) / 86_400_000` is off by an hour across a DST boundary and floors to
 * the wrong day, which is exactly the bug LOGISTICS shipped and fixed (commit
 * 6b36485). Keep the arithmetic in epoch days.
 */

/** Days before end_date at which a live warranty starts reading as "expiring soon". */
export const EXPIRING_SOON_DAYS = 60

/**
 * The four states, in severity order. `none` is the honest answer for a device
 * with no warranty row — deliberately NOT the legacy DLMS behaviour, which
 * inferred `ship_date + 2 years` for every device via a generated column
 * (20250104000000_warranty.sql). Inventing a window is worse than admitting
 * there isn't one: it reads as a real commercial commitment nobody made.
 */
export const WARRANTY_STATUSES = ['active', 'expiring_soon', 'expired', 'none'] as const
export type WarrantyStatus = (typeof WARRANTY_STATUSES)[number]

/** Both bounds INCLUSIVE. 'YYYY-MM-DD' strings, never Date objects. */
export type WarrantyPeriod = { startDate: string; endDate: string }

export type WarrantyPeriodErrorCode = 'malformed_date' | 'end_before_start'
export type WarrantyPeriodDecision =
  | { ok: true }
  | { ok: false; error: WarrantyPeriodErrorCode }

export class InvalidWarrantyPeriodError extends Error {
  readonly code: WarrantyPeriodErrorCode
  constructor(code: WarrantyPeriodErrorCode, message: string) {
    super(message)
    this.name = 'InvalidWarrantyPeriodError'
    this.code = code
  }
}

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/
const MS_PER_DAY = 86_400_000

/**
 * 'YYYY-MM-DD' -> UTC epoch day (integer). Returns null on anything that isn't
 * a real calendar date, INCLUDING dates that parse but roll over (2026-02-30
 * becomes March 2 under a naive Date.UTC, so the round-trip check below is what
 * catches it).
 */
function toEpochDay(iso: string): number | null {
  const m = ISO_DATE.exec(iso)
  if (!m) return null
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])]
  const ms = Date.UTC(y, mo - 1, d)
  if (Number.isNaN(ms)) return null
  const back = new Date(ms)
  // Round-trip guard: rejects 2026-13-01 and 2026-02-30 rather than silently
  // accepting the rolled-over date Date.UTC produces.
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d) {
    return null
  }
  return ms / MS_PER_DAY
}

function requireEpochDay(iso: string, label: string): number {
  const day = toEpochDay(iso)
  if (day === null) {
    throw new InvalidWarrantyPeriodError(
      'malformed_date', `${label} must be a real calendar date in YYYY-MM-DD form (got "${iso}")`)
  }
  return day
}

/**
 * Whole calendar days from `today` until `endDate`, inclusive of the end date:
 * 0 means "expires today, still covered", -1 means "expired yesterday".
 * Throws on malformed input rather than returning NaN — a NaN here would
 * silently compare false against every threshold and report a live warranty as
 * plain `active` forever.
 */
export function daysUntilExpiry(endDate: string, today: string): number {
  return requireEpochDay(endDate, 'End date') - requireEpochDay(today, 'Today')
}

/**
 * Whether cover is actually running today — start <= today <= end.
 *
 * Distinct from `warrantyStatus` on purpose: a warranty registered ahead of
 * shipment (start_date in the future) is `active` as a commitment but NOT in
 * force, and a repair opened today is not covered by it. The UI uses this to
 * say "Starts 1 Jan 2027" instead of implying live cover.
 */
export function isInForce(period: WarrantyPeriod, today: string): boolean {
  const t = requireEpochDay(today, 'Today')
  return requireEpochDay(period.startDate, 'Start date') <= t
    && t <= requireEpochDay(period.endDate, 'End date')
}

/**
 * The derived status. `null`/`undefined` period => 'none' (no warranty record).
 *
 * A future-dated warranty is 'active', not 'expired' — pair it with `isInForce`
 * when the question is "is a claim covered today?" rather than "does this device
 * have live warranty cover on the books?".
 */
export function warrantyStatus(
  period: WarrantyPeriod | null | undefined, today: string,
): WarrantyStatus {
  if (!period) return 'none'
  const remaining = daysUntilExpiry(period.endDate, today)
  if (remaining < 0) return 'expired'
  return remaining <= EXPIRING_SOON_DAYS ? 'expiring_soon' : 'active'
}

export type WarrantyDescription = {
  status: WarrantyStatus
  /** null only when status is 'none'. Negative once expired. */
  daysRemaining: number | null
  inForce: boolean
}

/** Everything a warranty badge needs, from one parse of the dates. */
export function describeWarranty(
  period: WarrantyPeriod | null | undefined, today: string,
): WarrantyDescription {
  if (!period) return { status: 'none', daysRemaining: null, inForce: false }
  return {
    status: warrantyStatus(period, today),
    daysRemaining: daysUntilExpiry(period.endDate, today),
    inForce: isInForce(period, today),
  }
}

/**
 * Validate a proposed period before it reaches the database. The DB CHECK
 * (end_date >= start_date) is the real invariant; this exists so the user gets
 * a sentence instead of a constraint-violation string. start === end is legal:
 * a one-day warranty is odd but not incoherent, and refusing it would be a
 * policy decision this layer has no business making.
 */
export function validateWarrantyPeriod(startDate: string, endDate: string): WarrantyPeriodDecision {
  const start = toEpochDay(startDate)
  const end = toEpochDay(endDate)
  if (start === null || end === null) return { ok: false, error: 'malformed_date' }
  if (end < start) return { ok: false, error: 'end_before_start' }
  return { ok: true }
}

export function messageForWarrantyPeriodError(code: WarrantyPeriodErrorCode): string {
  return code === 'end_before_start'
    ? 'The warranty end date must be on or after the start date.'
    : 'Warranty dates must be real calendar dates in YYYY-MM-DD form.'
}

const STATUS_LABEL: Record<WarrantyStatus, string> = {
  active: 'Active',
  expiring_soon: 'Expiring soon',
  expired: 'Expired',
  none: 'No warranty',
}

export function warrantyStatusLabel(status: WarrantyStatus): string {
  return STATUS_LABEL[status]
}
