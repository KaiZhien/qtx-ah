/**
 * The queue's presentation rules (spec §6.3), kept pure so they can be unit-tested
 * without a database, a browser or a clock — the same split repairStatus and
 * approvalDecision already use.
 *
 * Two questions the queue page asks of every row: WHERE does this request point,
 * and HOW LONG has it been waiting.
 */

/**
 * entity_type → the route its detail page actually lives at.
 *
 * NOT components/tasks/entityHref.ts's `${moduleHref}/${entityType}s/${id}`
 * convention, and the difference is not cosmetic: that convention would send a
 * `sales_invoice` approval to `/finance/sales_invoices/{id}`, which is a 404. The
 * routes are enumerated here because there are three of them and they are exact —
 * a queue whose "open the record" link dead-ends is worse than one with no link,
 * since a dead link looks like the record was deleted.
 *
 * hasOwnProperty-guarded for the reason buildApprovalTask is: `approval.entity_type`
 * is deliberately unconstrained free text (the migration's comment refuses a CHECK
 * that would make every new consumer a schema migration), so "constructor" is a
 * plausible stored value and a prototype walk would return a function here.
 */
const APPROVAL_RECORD_ROUTES: Record<string, string> = {
  sales_invoice: '/finance/invoices',
  eco: '/engineering/eco',
  repair: '/maintenance/repairs',
}

/** null when nothing links this entity type — the caller renders plain text. */
export function approvalRecordHref(entityType: string, entityId: string): string | null {
  if (!Object.prototype.hasOwnProperty.call(APPROVAL_RECORD_ROUTES, entityType)) return null
  return `${APPROVAL_RECORD_ROUTES[entityType]}/${entityId}`
}

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`

/**
 * How long a request has been waiting, in the coarsest unit that is still true.
 *
 * `now` is a PARAMETER, not `Date.now()`, so this is deterministic under test — the
 * house convention for anything time-dependent (DLMS domain modules take an
 * injectable `today` for the same reason).
 *
 * A NEGATIVE age reads as "just now" rather than "-1 minutes": `created_at` is
 * stamped by Postgres and `now` by the rendering host, so a request created a
 * moment ago can legitimately be a few milliseconds in the host's future. An age
 * that renders as a negative number in an approver's queue looks like corruption.
 */
export function approvalAgeLabel(requestedAt: Date, now: Date): string {
  const elapsed = now.getTime() - requestedAt.getTime()
  if (!Number.isFinite(elapsed) || elapsed < MINUTE) return 'just now'
  if (elapsed < HOUR) return plural(Math.floor(elapsed / MINUTE), 'minute')
  if (elapsed < DAY) return plural(Math.floor(elapsed / HOUR), 'hour')
  return plural(Math.floor(elapsed / DAY), 'day')
}
