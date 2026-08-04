import { withTransaction } from '@/lib/db/tx'
import { loadSystemActor } from '@/modules/shared/authz/actor'
import {
  buildWarrantyExpiryReminders, WARRANTY_EXPIRY_MILESTONES,
} from '@/modules/finance/domain/warrantyExpiry'
import { getExpiringWarranties } from '@/modules/finance/services/warrantyService'
import { buildWarrantyExpiringNotification } from '@/modules/shared/notifications/domain/templates'
import {
  deliverEmails, fanOutInTx, resolvePermissionRecipients,
  type EmailIntent, type Recipient,
} from '@/modules/shared/notifications/services/notificationService'

/**
 * The warranty-expiry sweep (spec §8.5: "warranties expiring 30/60/90 d").
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THIS IS A POLL, AND IT HAS TO BE — the one thing to understand before changing it.
 *
 * Every other notification on this platform rides the transactional outbox, because every
 * other notification is caused by somebody WRITING something. A warranty expiring is not:
 * there is no row change, no audit row and no outbox row, because time passing is not a
 * write. (That is the same fact `warranty` has no status column for — see
 * modules/finance/domain/warrantyStatus.ts.) Nothing can emit an event nobody caused, so
 * the only mechanism available is to look.
 *
 * `sweepTaskReminders` is the existing precedent for exactly this shape and exists for
 * exactly this reason — an overdue task is also a fact about the clock rather than an
 * event — so this file deliberately copies its structure: resolve the principal once,
 * read the candidates, let a pure domain decide, fan out inside ONE transaction, deliver
 * email after it commits.
 *
 * IDEMPOTENCY IS THE DEDUPE KEY, NOT THIS FUNCTION'S MEMORY, and the key differs from the
 * reminder sweep's in the one way that matters: it carries NO DAY. A task reminder should
 * nag daily, so its key ends in the UTC day; a warranty milestone must fire ONCE EVER, so
 * it does not. Running this sweep twice today, five times today, or every day for three
 * months produces exactly three notifications per warranty — one as it crosses 90 days,
 * one at 60, one at 30. See modules/finance/domain/warrantyExpiry.ts.
 *
 * NO NEW AUTHORITY WAS ADDED FOR IT, and this was checked rather than assumed. The job
 * runs as the outbox drain's automation principal, whose resolved authority is exactly
 * `view_records` + `create_records` across every module
 * (fn_seed_system_actor's keep-list, 20260731000000_platform_outbox.sql). It spends
 * `view_records` in finance (getExpiringWarranties' gate — deliberately not the
 * `view_finance` money gate) and `create_records` in finance (fanOutInTx's). Both were
 * already held. Widening that principal is the one change its four enforcement points
 * cannot defend against, so a future field on this notification that needs a third
 * permission is a security decision and a migration, not a wiring change.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export type WarrantyExpirySweepResult = {
  /** Live, unexpired warranties inside the widest bucket that this run looked at. */
  scanned: number
  /** Of those, the ones the pure domain placed at a milestone today. */
  due: number
  /** Notifications actually WRITTEN — lower than `due × recipients` on a re-run, which
   *  is the point, and zero on the second run of the same day. */
  created: number
  /** People the sweep would tell. Zero is a legitimate configuration, not a fault. */
  recipients: number
  /** Emails that actually went out. Zero when RESEND_API_KEY is unset — the state today. */
  emailed: number
  /**
   * TRUE when the scan hit its ceiling, so this run cannot claim to have seen the whole
   * 90-day horizon. Reported rather than swallowed: unlike the reminder sweep's cap, a
   * missed milestone here is missed FOREVER (the key has no day, so tomorrow's run does
   * not retry it) unless the warranty later moves into a tighter bucket that does fit.
   */
  truncated: boolean
}

/**
 * The widest bucket — everything at 90 days or nearer. One read covers all three
 * milestones because the buckets are CUMULATIVE (30 ⊆ 60 ⊆ 90) and the pure domain picks
 * the tightest one each warranty has reached.
 */
const WIDEST_WINDOW = WARRANTY_EXPIRY_MILESTONES[WARRANTY_EXPIRY_MILESTONES.length - 1]

/**
 * getExpiringWarranties' own maximum. Not a number chosen here: its Zod schema caps
 * `limit` at 200, so this is the most one call can see. Rows are ordered by `end_date`
 * ascending, so a saturated scan keeps the NEAREST expiries — the 30-day milestone, the
 * one that actually drives action — and loses the far end of the 90-day horizon. See
 * `truncated` above.
 */
const SCAN_LIMIT = 200

/**
 * Who hears about it: everyone who can actually renew a warranty.
 *
 * `manage_finance`, not `view_records`. The reads are deliberately open to anyone with
 * Finance module access (a technician needs to know whether a repair is covered), but this
 * message is a call to action — "renew these" — and addressing it to people who cannot act
 * turns the bell into noise for every Viewer in the company. `manage_finance` is exactly
 * the gate createWarranty/renewWarranty enforce.
 */
const AUDIENCE_PERMISSION = 'manage_finance' as const

/**
 * Runs the sweep.
 *
 * `today` is injectable per the house convention, but its DEFAULT comes from the DATABASE
 * rather than from `new Date()`: the candidate window is compared against Postgres'
 * `current_date` inside getExpiringWarranties, so measuring the milestone against the web
 * server's clock would let the two disagree about which day it is on a non-UTC host — the
 * same local-midnight class of bug the warranty module already carries dates as TEXT to
 * avoid.
 */
export async function sweepWarrantyExpiry(
  opts: { today?: string } = {},
): Promise<WarrantyExpirySweepResult> {
  // Resolved once, before any row is touched — same reasoning as the drain's and the
  // reminder sweep's: a job that cannot resolve its principal must fail before it has
  // half-notified a backlog.
  const system = await loadSystemActor()

  // authorize() runs inside this call, ahead of its own connection. The read is a separate
  // transaction from the write below on purpose: it is a pure read of a shared service, and
  // holding its rows under lock while fanning out to N people would buy nothing — a
  // warranty that is renewed between the two simply produces one last notification about
  // the row that was live when we looked, which is true rather than stale.
  const warranties = await getExpiringWarranties(
    system, { withinDays: WIDEST_WINDOW, limit: SCAN_LIMIT })

  const result: WarrantyExpirySweepResult = {
    scanned: warranties.length,
    due: 0,
    created: 0,
    recipients: 0,
    emailed: 0,
    truncated: warranties.length >= SCAN_LIMIT,
  }
  if (result.truncated) {
    console.warn(JSON.stringify({
      level: 'warn', msg: 'the warranty expiry sweep hit its scan ceiling',
      limit: SCAN_LIMIT,
      detail: 'Milestones beyond the nearest 200 expiries were not evaluated this run, and '
        + 'the dedupe key carries no day so they are not retried tomorrow. Raise the limit '
        + 'ceiling in getExpiringWarranties if this persists.',
    }))
  }

  const intents: EmailIntent[] = []

  await withTransaction(system.id, async (tx) => {
    // The database's day, not the web server's — see this function's header.
    const today = opts.today ?? (await tx.query<{ today: string }>(
      `SELECT current_date::text AS today`)).rows[0].today

    const due = buildWarrantyExpiryReminders(warranties, today)
    result.due = due.length
    if (due.length === 0) return

    // Resolved ONCE for the whole run rather than per warranty: the audience is a property
    // of the module and the permission, not of any one warranty, and re-running the same
    // query 200 times would be the only expensive thing this job does.
    //
    // `excludeUserId` is null because there IS no causer. Every other fan-out excludes the
    // person who triggered the event; nobody triggers a calendar.
    const recipients: Recipient[] = await resolvePermissionRecipients(
      tx, AUDIENCE_PERMISSION, 'finance', null)
    result.recipients = recipients.length
    if (recipients.length === 0) return

    for (const reminder of due) {
      const produced = await fanOutInTx(
        tx, system, recipients,
        buildWarrantyExpiringNotification({
          warrantyId: reminder.warrantyId,
          deviceId: reminder.deviceId,
          deviceSn: reminder.deviceSn,
          endDate: reminder.endDate,
          milestone: reminder.milestone,
          daysRemaining: reminder.daysRemaining,
        }),
        { dedupeKey: reminder.dedupeKey },
      )
      // `created` counts rows actually INSERTED, so a second run today reports 0 rather
      // than re-reporting the first run's work — and the intents come back empty for the
      // same suppressed rows, so no duplicate mail either.
      intents.push(...produced.intents)
      result.created += produced.created
    }
  })

  // After the transaction, never inside it — a send cannot be rolled back.
  const { sent } = await deliverEmails(system.id, intents)
  result.emailed = sent
  return result
}
