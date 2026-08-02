/**
 * Days-in-state aging for the Maintenance dashboard (spec §8.5: "active repairs
 * by state with days-in-state aging").
 *
 * Pure, with `today` injected — the house convention for every DLMS domain module,
 * so a test never depends on the wall clock and a whole page can be rendered
 * against ONE clock (two widgets computed a second apart must not disagree about
 * which repair is older).
 */

const MS_PER_DAY = 86_400_000

/**
 * Whole days elapsed between two INSTANTS.
 *
 * Both arguments are timestamptz values (`repair_status_history.changed_at`,
 * `repair.opened_at`), so this is instant arithmetic and no host timezone can
 * shift it — unlike date-only columns, which stay ISO strings (see ./expiry).
 *
 * Floors rather than rounds: 3 days and 23 hours in a state is "3 days", because
 * an operator reading "4 days" would go looking for a day that has not happened.
 * Clamped at 0 so clock skew or a backdated row can never render a negative age.
 */
export function daysInState(since: Date, today: Date): number {
  const elapsed = today.getTime() - since.getTime()
  if (elapsed <= 0) return 0
  return Math.floor(elapsed / MS_PER_DAY)
}

export const AGING_BUCKETS = ['0-3', '4-7', '8-14', '15+'] as const
export type AgingBucket = (typeof AGING_BUCKETS)[number]

/**
 * Buckets a day count for the aging histogram. Disjoint and exhaustive over every
 * non-negative integer, so a repair appears in exactly one column.
 */
export function agingBucket(days: number): AgingBucket {
  if (days <= 3) return '0-3'
  if (days <= 7) return '4-7'
  if (days <= 14) return '8-14'
  return '15+'
}
