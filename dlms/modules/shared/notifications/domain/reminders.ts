/**
 * Task reminders (spec §8.3): "due-tomorrow and overdue notifications (worker daily sweep)".
 *
 * Pure, and taking `today` as a parameter per the house convention for domain modules — the
 * sweep's correctness is entirely about which day it thinks it is, so that must be
 * injectable rather than read from the wall clock in here.
 *
 * THE IDEMPOTENCY LIVES IN reminderDedupeKey. Running the sweep twice on the same day must
 * not notify twice, and the mechanism is deliberately NOT "did this job already run today?"
 * bookkeeping: that answer is wrong under partial failure (the job died halfway — did it
 * notify or not?) and under concurrency (two runs both read "no" and both proceed). Instead
 * every reminder derives a key from what makes it unique — WHAT kind, about WHICH task, on
 * WHICH day — and `notification_dedupe_idx` collapses the repeat via ON CONFLICT DO NOTHING.
 * A crashed sweep re-run five minutes later finishes its work and re-notifies nobody, and no
 * caller has to remember anything for that to be true.
 *
 * The day component is also what makes an overdue task nag DAILY rather than once forever:
 * the key changes at midnight UTC, so tomorrow's sweep is a new message.
 */

export type ReminderKind = 'due_tomorrow' | 'overdue'

export type ReminderTask = {
  id: string
  title: string
  status: string
  dueDate: Date | null
  assigneeId: string | null
}

export type Reminder = {
  kind: ReminderKind
  taskId: string
  userId: string
  title: string
  body: string
  dedupeKey: string
}

/** An instant reduced to its UTC calendar day, `YYYY-MM-DD`. */
export function utcDay(at: Date): string {
  return at.toISOString().slice(0, 10)
}

/**
 * The stable identity of "this reminder, about this task, on this day".
 *
 * Stable across every run within the same UTC day — that stability IS the idempotency
 * guarantee — and different across kinds, tasks and days so nothing legitimate is collapsed.
 */
export function reminderDedupeKey(kind: ReminderKind, taskId: string, today: Date): string {
  return `task_reminder:${kind}:${taskId}:${utcDay(today)}`
}

/**
 * Statuses that are DONE, and therefore have nothing to be late for.
 *
 * `blocked` is deliberately absent: blocked is not finished, and a blocked task sailing past
 * its due date is precisely the thing somebody needs to hear about.
 */
const CLOSED_STATUSES = new Set(['completed', 'cancelled'])

/**
 * Which of these tasks deserve a reminder today, and what each one should say.
 *
 * Two exclusions are worth stating because they look like omissions:
 *
 *   NO DUE DATE → nothing. There is nothing to be late for.
 *
 *   NO ASSIGNEE → nothing, and this is the COMMON case rather than an edge one. Handoff
 *   tasks are created unassigned on purpose (RB-09: they belong to the receiving
 *   department's queue, and the automation principal deliberately does not hold
 *   assign_tasks). A reminder needs somebody to remind; "someone should do this" addressed
 *   to nobody is not a notification, and fanning it out to a whole department would turn
 *   every unclaimed handoff into a daily all-hands nag.
 */
export function buildReminders(tasks: readonly ReminderTask[], today: Date): Reminder[] {
  const out: Reminder[] = []
  const todayDay = utcDay(today)
  const tomorrowDay = utcDay(new Date(today.getTime() + 24 * 60 * 60 * 1000))

  for (const task of tasks) {
    if (!task.dueDate || !task.assigneeId) continue
    if (CLOSED_STATUSES.has(task.status)) continue

    const dueDay = utcDay(task.dueDate)

    // Compared as calendar days, not as instants. taskService.normalizeDueDate pushes a
    // bare date to 23:59:59.999 so the whole day counts as "not yet overdue"; comparing
    // timestamps here would re-introduce exactly the off-by-one that fixed.
    let kind: ReminderKind
    if (dueDay < todayDay) kind = 'overdue'
    else if (dueDay === tomorrowDay) kind = 'due_tomorrow'
    else continue                                   // due today, or later than tomorrow

    out.push({
      kind,
      taskId: task.id,
      userId: task.assigneeId,
      title: kind === 'overdue'
        ? `Overdue: ${task.title}`
        : `Due tomorrow: ${task.title}`,
      body: kind === 'overdue'
        ? `This task was due on ${dueDay} and is still open.`
        : `This task is due on ${dueDay}.`,
      dedupeKey: reminderDedupeKey(kind, task.id, today),
    })
  }
  return out
}
