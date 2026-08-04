/**
 * A due date arriving as a bare calendar day (`new Date('2026-08-10')`) parses to
 * UTC midnight, which is the FIRST instant of that day. `isOverdue` compares
 * instants — `dueDate.getTime() < today.getTime()` — so stored as-is, a task
 * "due today" reads overdue from one millisecond past midnight. Detect that shape
 * (all-zero UTC time-of-day) and push it to the LAST instant of the same day, so
 * the whole calendar day counts as "not yet overdue".
 *
 * REVIEWED AND KEPT, not overlooked. The carried finding is accurate — a caller
 * who genuinely meant the instant 00:00:00.000Z would be moved almost a full day
 * — and it stays anyway, for three reasons:
 *
 *   1. No such caller exists. The only producer of a due date in this app is
 *      `<input type="date">`, whose 'YYYY-MM-DD' is a calendar day by definition;
 *      the outbox handoff templates set none at all. The zod schema types it as
 *      `Date` because that is the right boundary type, not because a precise
 *      moment is a real input.
 *   2. Any non-zero component opts out. "Due at 9am UTC" never reaches this
 *      branch, so the escape hatch for a precise moment is already there — the
 *      one unreachable value is midnight exactly.
 *   3. The alternative is worse. Teaching `isOverdue` to compare calendar days
 *      would decide the UTC-versus-local question inside the rule, and `isOverdue`
 *      takes an injected `today` precisely so the CALLER owns that decision.
 *
 * Consequence worth knowing: the last instant is UTC, so for a user at UTC+8 a
 * task stays un-overdue until 08:00 local on the following day. That errs toward
 * not nagging, which is the right direction for a shared task board.
 *
 * Lives in domain/ beside `isOverdue` rather than inside taskService, because
 * `isOverdue`'s instant comparison is the entire reason it exists — separated,
 * it reads like an arbitrary adjustment somebody could delete.
 */
export function normalizeDueDate(d: Date | undefined): Date | undefined {
  if (!d) return d
  const isBareDate = d.getUTCHours() === 0 && d.getUTCMinutes() === 0
    && d.getUTCSeconds() === 0 && d.getUTCMilliseconds() === 0
  if (!isBareDate) return d
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), 23, 59, 59, 999))
}
