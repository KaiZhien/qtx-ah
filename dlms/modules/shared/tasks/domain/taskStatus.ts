/**
 * Task lifecycle (spec §4 / D28).
 *
 * "Overdue" is deliberately NOT a status: it is a function of the due date and
 * the clock, so storing it would need a nightly job to keep the table honest and
 * would still be wrong between runs. isOverdue() computes it at read time.
 *
 * The graph is a hardcoded constant, unlike device statuses (which are an
 * admin-editable vocabulary), because task states are platform mechanics rather
 * than business vocabulary — no admin should be able to invent one.
 */
export const TASK_STATUSES = [
  'draft', 'open', 'in_progress', 'blocked', 'awaiting_approval', 'completed', 'cancelled',
] as const
export type TaskStatus = (typeof TASK_STATUSES)[number]

const TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  draft: ['open', 'cancelled'],
  open: ['in_progress', 'blocked', 'cancelled'],
  in_progress: ['blocked', 'awaiting_approval', 'completed', 'cancelled'],
  blocked: ['in_progress', 'open', 'cancelled'],
  awaiting_approval: ['completed', 'in_progress', 'cancelled'],
  completed: [],
  cancelled: [],
}

/** Fails closed: an unknown source or target is never permitted. */
export function isValidTaskTransition(from: TaskStatus, to: TaskStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false
}

export function allowedNextTaskStatuses(from: TaskStatus): TaskStatus[] {
  return [...(TRANSITIONS[from] ?? [])]
}

const LIVE_STATUSES: ReadonlySet<TaskStatus> = new Set<TaskStatus>([
  'open', 'in_progress', 'blocked', 'awaiting_approval',
])

/**
 * `today` is injected rather than read from the clock so the rule is testable and
 * so a server rendering in UTC agrees with a user reading in SGT — the caller
 * decides which day "today" is.
 */
export function isOverdue(
  task: { status: TaskStatus; dueDate: Date | null },
  today: Date,
): boolean {
  if (!task.dueDate) return false
  if (!LIVE_STATUSES.has(task.status)) return false
  return task.dueDate.getTime() < today.getTime()
}
