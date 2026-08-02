import { withTransaction } from '@/lib/db/tx'
import { loadSystemActor } from '@/modules/shared/authz/actor'
import {
  buildReminders, type ReminderTask,
} from '@/modules/shared/notifications/domain/reminders'
import {
  deliverEmails, fanOutInTx, type EmailIntent, type Recipient,
} from '@/modules/shared/notifications/services/notificationService'

/**
 * The daily task-reminder sweep (spec §8.3: "reminders: due-tomorrow and overdue
 * notifications (worker daily sweep)").
 *
 * IDEMPOTENCY IS THE DESIGN CONSTRAINT, not a nicety, and it is discharged by the DEDUPE
 * KEY rather than by this function remembering anything. Each reminder's key is
 * `task_reminder:<kind>:<taskId>:<UTC day>` and `notification_dedupe_idx` makes a repeat
 * insert a no-op, so:
 *
 *   - running the sweep twice on the same day notifies nobody twice;
 *   - a sweep that CRASHED HALFWAY can simply be re-run — it finishes the remainder and
 *     re-notifies none of the people it already reached;
 *   - two sweeps racing each other cannot double-deliver, because the guarantee is a
 *     unique index rather than a read-then-write check.
 *
 * A "have I already run today?" flag on a jobs table would fail every one of those three:
 * it is wrong under partial failure (did the crashed run notify or not?) and racy under
 * concurrency. The database is the only place this can be settled.
 *
 * The re-notification cadence falls out of the same key: the day component changes at
 * midnight UTC, so an overdue task nags once a day rather than once forever.
 */

export type ReminderSweepResult = {
  /** Tasks examined. */
  scanned: number
  /** Reminders the domain said were due today. */
  due: number
  /** Notifications actually written — LOWER than `due` on a re-run, which is the point. */
  created: number
  /** Emails that actually went out. Zero when RESEND_API_KEY is unset. */
  emailed: number
}

/**
 * A bound on one sweep, so a pathological backlog cannot turn a scheduled job into an
 * unbounded transaction. Generous relative to any realistic task table; if it is ever hit,
 * the run is still correct (the remainder is picked up by the next day's sweep, or by
 * re-running this one — which is safe, precisely because of the dedupe key).
 */
const SCAN_LIMIT = 5000

/**
 * Runs the sweep.
 *
 * `today` is injectable per the house convention for anything date-dependent — the sweep's
 * entire correctness is about which day it thinks it is, and a test that cannot control
 * that is a test that passes at 23:59 and fails at 00:01.
 */
export async function sweepTaskReminders(
  opts: { today?: Date } = {},
): Promise<ReminderSweepResult> {
  const today = opts.today ?? new Date()

  // Resolved once, before any row is touched — same reasoning as the drain's: a job that
  // cannot resolve its principal must fail before it has half-notified a backlog.
  const system = await loadSystemActor()

  const result: ReminderSweepResult = { scanned: 0, due: 0, created: 0, emailed: 0 }
  const intents: EmailIntent[] = []

  await withTransaction(system.id, async (tx) => {
    // The candidate set is deliberately wider than the answer: everything with a due date
    // at or before the end of tomorrow, with the actual due/overdue decision left to the
    // pure domain. Splitting the calendar arithmetic between SQL and TypeScript is how the
    // two drift into disagreeing about what "tomorrow" means across a timezone boundary.
    const horizon = new Date(today.getTime() + 2 * 24 * 60 * 60 * 1000)
    const { rows } = await tx.query<{
      id: string; title: string; status: string; due_date: Date | null
      assignee_id: string | null; email: string; full_name: string
    }>(
      `SELECT t.id, t.title, t.status, t.due_date, t.assignee_id,
              u.email, u.full_name
         FROM task t
         JOIN app_user u ON u.id = t.assignee_id
        WHERE t.deleted_at IS NULL
          AND t.due_date IS NOT NULL
          AND t.due_date < $1
          AND t.status NOT IN ('completed', 'cancelled')
          AND u.active AND u.deleted_at IS NULL
        ORDER BY t.due_date
        LIMIT $2`, [horizon, SCAN_LIMIT])

    result.scanned = rows.length
    if (rows.length === 0) return

    const tasks: ReminderTask[] = rows.map((r) => ({
      id: r.id, title: r.title, status: r.status,
      dueDate: r.due_date, assigneeId: r.assignee_id,
    }))
    const people = new Map<string, Recipient>(rows.map((r) =>
      [r.assignee_id!, { id: r.assignee_id!, email: r.email, fullName: r.full_name }]))

    const reminders = buildReminders(tasks, today)
    result.due = reminders.length

    for (const reminder of reminders) {
      const recipient = people.get(reminder.userId)
      if (!recipient) continue

      const produced = await fanOutInTx(tx, system, [recipient], {
        category: 'task_reminder',
        title: reminder.title,
        body: reminder.body,
        entityType: 'task',
        entityId: reminder.taskId,
        module: 'tasks',
        url: `/tasks/${reminder.taskId}`,
      }, { dedupeKey: reminder.dedupeKey })

      // `created` counts rows actually INSERTED, so a re-run reports 0 rather than
      // re-reporting yesterday's work — and the email intents come back empty for the same
      // suppressed rows, so a duplicate produces no duplicate mail either. That is what
      // makes re-running the sweep genuinely free rather than merely visually quiet.
      intents.push(...produced.intents)
      result.created += produced.created
    }
  })

  // After the transaction, never inside it — a send cannot be rolled back.
  const { sent } = await deliverEmails(system.id, intents)
  result.emailed = sent
  return result
}
