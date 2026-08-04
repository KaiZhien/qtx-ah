import { daysUntilExpiry } from '@/modules/finance/domain/warrantyStatus'

/**
 * WHICH warranties have crossed WHICH expiry milestone, and the key that makes each one
 * fire exactly once (spec §8.5 "warranties expiring 30/60/90 d").
 *
 * Pure and I/O-free per the house rule, with `today` injected as a 'YYYY-MM-DD' string —
 * the same convention warrantyStatus.ts states and for the same reason: the sweep's whole
 * correctness is about which day it thinks it is, and a test that cannot control that is a
 * test that passes at 23:59 and fails at 00:01.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * WHY THIS POLLS INSTEAD OF RIDING THE OUTBOX, which is the first thing anyone will ask
 * given that handoffs and approvals do not.
 *
 * A warranty expiring produces NO EVENT. There is no row change, no audit row and no
 * outbox row, because time passing is not a write — that is the same fact
 * warrantyStatus.ts's header states as "expiry is the passage of time, not an event", and
 * it is why `warranty` has no status column. An outbox row can only be written by somebody
 * writing something; nobody writes anything when a warranty crosses 30 days. So the only
 * mechanism available is a poll, and `sweepTaskReminders` is the existing precedent for
 * exactly this shape rather than an exception to the rule.
 *
 * WHY THE DEDUPE KEY HAS NO DAY COMPONENT, which is the one line most likely to be
 * "fixed" into a bug by someone copying reminders.ts. `reminderDedupeKey` deliberately
 * ends in the UTC day because an OVERDUE TASK SHOULD NAG DAILY — the day rolling over is
 * what makes tomorrow's sweep a new message. A warranty milestone is the opposite: it must
 * fire ONCE EVER, and omitting the day is precisely what makes that true. Add a day here
 * and a warranty at 25 days sends thirty notifications instead of one.
 *
 * WHY IT IS KEYED ON THE WARRANTY AND NEVER ON THE DEVICE. A renewal does not edit dates;
 * it soft-deletes the current row and inserts a successor (renewWarranty, and the partial
 * `warranty_device_live_unique` index that makes it possible). Keyed on the device, the
 * successor would inherit the predecessor's already-used keys and NEVER notify again —
 * silently, for the rest of that device's life.
 * ─────────────────────────────────────────────────────────────────────────────
 */

/**
 * The three buckets, ascending. They mirror `EXPIRY_WINDOWS` in warrantyService — the
 * radar page's own 30/60/90 tabs — so a notification and the page it links to agree about
 * what "within 30 days" means.
 *
 * CUMULATIVE, not disjoint: 30 ⊆ 60 ⊆ 90, exactly as getWarrantyExpiryCounts documents.
 * That is why `milestoneFor` answers with the TIGHTEST bucket a warranty has reached
 * rather than with a set — a warranty 16 days out is in all three, but only one of them is
 * news today, and the other two were news weeks ago.
 */
export const WARRANTY_EXPIRY_MILESTONES = [30, 60, 90] as const
export type WarrantyExpiryMilestone = (typeof WARRANTY_EXPIRY_MILESTONES)[number]

/**
 * The tightest milestone this warranty has reached, or null when it has reached none.
 *
 * `null` for ALREADY EXPIRED as well as for "not close enough yet". The radar is a call to
 * action — renew these — and a warranty whose window shut months ago is not one;
 * getExpiringWarranties excludes them in SQL for the same reason, but the domain must be
 * right on its own rather than by relying on its caller's WHERE clause.
 */
export function milestoneFor(daysRemaining: number): WarrantyExpiryMilestone | null {
  if (daysRemaining < 0) return null
  for (const milestone of WARRANTY_EXPIRY_MILESTONES) {
    if (daysRemaining <= milestone) return milestone
  }
  return null
}

/**
 * The stable identity of "this warranty, at this milestone" — stable FOREVER, not merely
 * within a day. `notification_dedupe_idx` turns every repeat into a no-op, which is what
 * makes re-running the sweep (twice today, five times today, every day for a month) free.
 *
 * The RECIPIENT is deliberately absent: `fanOutInTx` appends `:${userId}` itself, so
 * adding one here would produce `…:<user>:<user>` and quietly break nothing visible until
 * somebody read a key.
 */
export function warrantyExpiryDedupeKey(
  warrantyId: string, milestone: WarrantyExpiryMilestone,
): string {
  return `warranty_expiring:${warrantyId}:${milestone}`
}

/** The subset of an ExpiringWarrantyItem this domain needs — dates as TEXT, never Date. */
export type ExpiringWarranty = {
  warrantyId: string
  deviceId: string
  deviceSn: string | null
  /** 'YYYY-MM-DD'. Selected as ::text upstream to dodge the local-midnight shift. */
  endDate: string
}

export type WarrantyExpiryReminder = ExpiringWarranty & {
  milestone: WarrantyExpiryMilestone
  /** Whole calendar days until end_date, inclusive: 0 means "ends today, still covered". */
  daysRemaining: number
  dedupeKey: string
}

/**
 * The warranties worth telling somebody about today, each at one milestone.
 *
 * `daysRemaining` is recomputed here from `endDate` and the injected `today` rather than
 * taken from whatever the caller measured, so the milestone, the key and the sentence a
 * human reads can never be computed against three different days.
 *
 * Throws (via daysUntilExpiry) on a malformed date rather than returning NaN: a NaN
 * compares false against every threshold, so the warranty would silently drop out of the
 * sweep forever instead of failing the run that could have been noticed.
 */
export function buildWarrantyExpiryReminders(
  warranties: readonly ExpiringWarranty[], today: string,
): WarrantyExpiryReminder[] {
  const out: WarrantyExpiryReminder[] = []
  for (const warranty of warranties) {
    const daysRemaining = daysUntilExpiry(warranty.endDate, today)
    const milestone = milestoneFor(daysRemaining)
    if (milestone === null) continue
    out.push({
      ...warranty,
      milestone,
      daysRemaining,
      dedupeKey: warrantyExpiryDedupeKey(warranty.warrantyId, milestone),
    })
  }
  return out
}
