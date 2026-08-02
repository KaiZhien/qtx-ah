/**
 * The 30/60/90-day expiry windows for the Logistics/Finance dashboard
 * (spec §8.5: "warranties expiring 30/60/90 d").
 *
 * DATE-ONLY VALUES STAY STRINGS, END TO END. A warranty expiry is a `date`
 * column, not an instant: it has no time and no zone. Turning it into a JS `Date`
 * to do arithmetic is what shipped a one-day shift in a previous slice on a UTC+
 * host, and CLAUDE.md records the fix as reading date columns as `::text`. So the
 * whole module speaks 'YYYY-MM-DD' and does its arithmetic in UTC internally,
 * where no local offset exists to shift anything.
 */

const MS_PER_DAY = 86_400_000

/** Parses 'YYYY-MM-DD' to a UTC midnight epoch — never a local-time Date. */
function utcDay(iso: string): number {
  const [y, m, d] = iso.slice(0, 10).split('-').map(Number)
  return Date.UTC(y, m - 1, d)
}

/**
 * Calendar days from `today` to `date`. Negative when `date` is in the past.
 *
 * Both endpoints are anchored to UTC midnight, so the result is a pure calendar
 * difference — correct across DST boundaries and leap days alike.
 */
export function daysUntil(date: string, today: string): number {
  return Math.round((utcDay(date) - utcDay(today)) / MS_PER_DAY)
}

export const EXPIRY_WINDOWS = [30, 60, 90] as const
export type ExpiryWindow = (typeof EXPIRY_WINDOWS)[number]

/** 'expired' | 30 | 60 | 90 | null (beyond the widest window). */
export type ExpiryBucket = ExpiryWindow | 'expired' | null

/**
 * Which window an expiry date falls in, relative to `today`.
 *
 * THE BUCKETS ARE DISJOINT, though the spec's phrasing ("30/60/90 d") reads
 * cumulatively. A warranty expiring in 20 days belongs to the 30-day bucket and
 * ONLY that one — count it in all three and the widget's own total is triple the
 * number of warranties, which is worse than useless on a page whose job is to say
 * how much work is coming.
 *
 * An already-lapsed warranty is 'expired', never 30. Folding the past into the
 * nearest future window would report a warranty you can no longer honour as an
 * upcoming renewal — the opposite of the action the widget exists to prompt.
 */
export function expiryBucket(date: string, today: string): ExpiryBucket {
  const days = daysUntil(date, today)
  if (days < 0) return 'expired'
  for (const w of EXPIRY_WINDOWS) {
    if (days <= w) return w
  }
  return null
}

/** Counts as agent FINANCE's `getWarrantyExpiryCounts` returns them: NESTED. */
export type CumulativeExpiryCounts = {
  within30: number
  within60: number
  within90: number
  expired: number
  active: number
}

/** The same information, re-cut so each warranty is counted exactly once. */
export type DisjointExpiryCounts = {
  /** 0–30 days. */
  days0to30: number
  /** 31–60 days. */
  days31to60: number
  /** 61–90 days. */
  days61to90: number
  expired: number
  /** Live warranties expiring beyond 90 days. */
  beyond90: number
}

/**
 * Converts FINANCE's CUMULATIVE windows into DISJOINT ones.
 *
 * ── THE OFF-BY-A-BUCKET THIS EXISTS TO PREVENT ─────────────────────────────
 * `getWarrantyExpiryCounts` returns nested windows: 30 ⊆ 60 ⊆ 90, so a warranty
 * expiring in 20 days is counted in ALL THREE. Rendering those three numbers
 * under the labels "30 / 60 / 90" reads as three separate piles of work and
 * triples the apparent backlog — and it is invisible, because every individual
 * number is correct. The labels on DisjointExpiryCounts are ranges for the same
 * reason: "61–90" cannot be misread the way "90" can.
 *
 * This platform's dashboards render the DISJOINT cut, deliberately, because the
 * widget answers "how much is coming and when", and a warranty belongs to exactly
 * one week of someone's attention.
 *
 * `expired` is passed through untouched — FINANCE's windows all exclude
 * already-expired rows, which is the same rule expiryBucket() applies.
 *
 * CLAMPED AT ZERO. If the three cumulative counts ever arrive non-monotonic
 * (a mid-flight renewal soft-deleting one row and minting another between two
 * counts), a raw subtraction would render a negative pile. Zero is wrong by at
 * most one row; a negative count is visibly broken and destroys trust in the
 * whole widget.
 */
export function disjointFromCumulative(c: CumulativeExpiryCounts): DisjointExpiryCounts {
  const clamp = (n: number) => (n > 0 ? n : 0)
  return {
    days0to30: clamp(c.within30),
    days31to60: clamp(c.within60 - c.within30),
    days61to90: clamp(c.within90 - c.within60),
    expired: clamp(c.expired),
    beyond90: clamp(c.active - c.within90),
  }
}
