import { describe, it, expect } from 'vitest'
import {
  buildReminders, reminderDedupeKey, utcDay, type ReminderTask,
} from '@/modules/shared/notifications/domain/reminders'

/**
 * The reminder sweep's pure half (spec §8.3). The idempotency the brief calls a real
 * design constraint is enforced by the DEDUPE KEY these functions compute — the database's
 * partial unique index does the rest — so the key's stability across runs is the single
 * most important property in this file.
 */

const task = (over: Partial<ReminderTask> = {}): ReminderTask => ({
  id: '11111111-1111-1111-1111-111111111111',
  title: 'Prepare delivery',
  status: 'open',
  dueDate: new Date('2026-08-04T23:59:59.999Z'),
  assigneeId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  ...over,
})

// A fixed "now" so nothing here depends on the wall clock — the domain takes `today`
// injected, per the house convention.
const NOW = new Date('2026-08-03T09:00:00.000Z')

describe('utcDay', () => {
  it('reduces an instant to a calendar day in UTC', () => {
    expect(utcDay(new Date('2026-08-03T09:00:00.000Z'))).toBe('2026-08-03')
    expect(utcDay(new Date('2026-08-03T23:59:59.999Z'))).toBe('2026-08-03')
  })
})

describe('reminderDedupeKey', () => {
  it('is STABLE for the same task, kind and day — this is what makes a re-run a no-op', () => {
    const a = reminderDedupeKey('due_tomorrow', 'task-1', new Date('2026-08-03T00:00:00Z'))
    const b = reminderDedupeKey('due_tomorrow', 'task-1', new Date('2026-08-03T18:30:00Z'))
    expect(a).toBe(b)
  })

  it('differs by kind, by task and by day', () => {
    const base = reminderDedupeKey('due_tomorrow', 'task-1', NOW)
    expect(reminderDedupeKey('overdue', 'task-1', NOW)).not.toBe(base)
    expect(reminderDedupeKey('due_tomorrow', 'task-2', NOW)).not.toBe(base)
    expect(reminderDedupeKey('due_tomorrow', 'task-1', new Date('2026-08-04T09:00:00Z')))
      .not.toBe(base)
  })

  it('re-notifies an overdue task on each NEW day rather than once forever', () => {
    // A task overdue for a week should nag daily; the day component is what makes that
    // true without the sweep having to remember anything.
    const day1 = reminderDedupeKey('overdue', 'task-1', new Date('2026-08-03T09:00:00Z'))
    const day2 = reminderDedupeKey('overdue', 'task-1', new Date('2026-08-04T09:00:00Z'))
    expect(day1).not.toBe(day2)
  })
})

describe('buildReminders', () => {
  it('flags a task due TOMORROW', () => {
    const out = buildReminders([task({ dueDate: new Date('2026-08-04T23:59:59.999Z') })], NOW)
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('due_tomorrow')
    expect(out[0].userId).toBe('aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa')
    expect(out[0].dedupeKey).toBe(reminderDedupeKey('due_tomorrow', task().id, NOW))
  })

  it('flags a task whose due date has PASSED', () => {
    const out = buildReminders([task({ dueDate: new Date('2026-08-01T23:59:59.999Z') })], NOW)
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('overdue')
  })

  it('says nothing about a task due TODAY — it is neither overdue nor due tomorrow', () => {
    // The whole calendar day is still available to do it in (taskService.normalizeDueDate
    // pushes a bare date to 23:59:59.999 for exactly this reason), so nagging at 09:00
    // would be wrong.
    expect(buildReminders([task({ dueDate: new Date('2026-08-03T23:59:59.999Z') })], NOW))
      .toHaveLength(0)
  })

  it('says nothing about a task due later than tomorrow', () => {
    expect(buildReminders([task({ dueDate: new Date('2026-08-09T23:59:59.999Z') })], NOW))
      .toHaveLength(0)
  })

  it('ignores tasks with no due date — there is nothing to be late for', () => {
    expect(buildReminders([task({ dueDate: null })], NOW)).toHaveLength(0)
  })

  it('ignores UNASSIGNED tasks — a reminder needs somebody to remind', () => {
    // Handoff tasks are created unassigned on purpose (RB-09), so this is the common case
    // rather than an edge one. Mailing "someone should do this" to nobody is a no-op; the
    // department queue is where an unclaimed handoff is meant to be seen.
    expect(buildReminders([task({ assigneeId: null, dueDate: new Date('2026-08-01T00:00:00Z') })], NOW))
      .toHaveLength(0)
  })

  it.each(['completed', 'cancelled'])('ignores a %s task', (status) => {
    expect(buildReminders([task({ status, dueDate: new Date('2026-08-01T00:00:00Z') })], NOW))
      .toHaveLength(0)
  })

  it('still reminds about a BLOCKED task that is overdue', () => {
    // Blocked is not done. A blocked task sailing past its due date is precisely the thing
    // somebody needs to be told about.
    const out = buildReminders(
      [task({ status: 'blocked', dueDate: new Date('2026-08-01T00:00:00Z') })], NOW)
    expect(out).toHaveLength(1)
    expect(out[0].kind).toBe('overdue')
  })

  it('produces one reminder per task, each carrying its own stable key', () => {
    const out = buildReminders([
      task({ id: 'aaaaaaa1-1111-1111-1111-111111111111', dueDate: new Date('2026-08-01T00:00:00Z') }),
      task({ id: 'aaaaaaa2-2222-2222-2222-222222222222', dueDate: new Date('2026-08-04T23:59:59Z') }),
    ], NOW)
    expect(out).toHaveLength(2)
    expect(new Set(out.map((r) => r.dedupeKey)).size).toBe(2)
  })

  it('titles and bodies read as something a human would act on', () => {
    const [due] = buildReminders([task({ dueDate: new Date('2026-08-04T23:59:59.999Z') })], NOW)
    expect(due.title).toContain('Prepare delivery')
    expect(due.title.toLowerCase()).toContain('tomorrow')
    const [late] = buildReminders([task({ dueDate: new Date('2026-08-01T00:00:00Z') })], NOW)
    expect(late.title.toLowerCase()).toContain('overdue')
  })
})
