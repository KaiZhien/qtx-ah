/**
 * "3 hours ago" for a notification list. Pure and clock-injected, per the house convention:
 * a relative time computed from an ambient `new Date()` cannot be tested at a boundary.
 *
 * Deliberately coarse. A notification list is scanned, not audited — the exact minute is on
 * the record it points at — and coarse buckets keep two rows written seconds apart from
 * rendering as visibly different ages for no reason.
 */
export function relativeAge(at: Date, now: Date): string {
  const seconds = Math.floor((now.getTime() - at.getTime()) / 1000)

  // A future timestamp is clock skew between the app server and Postgres, not an error
  // worth surfacing — "just now" is the least confusing thing to say about it.
  if (seconds < 60) return 'just now'

  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`

  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`

  const days = Math.floor(hours / 24)
  if (days < 30) return `${days} day${days === 1 ? '' : 's'} ago`

  const months = Math.floor(days / 30)
  return `${months} month${months === 1 ? '' : 's'} ago`
}
