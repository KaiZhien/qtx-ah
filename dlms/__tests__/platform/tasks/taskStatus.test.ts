import { describe, it, expect } from 'vitest'
import {
  TASK_STATUSES, isValidTaskTransition, allowedNextTaskStatuses, isOverdue,
} from '@/modules/shared/tasks/domain/taskStatus'

describe('task status vocabulary (spec §4 / D28)', () => {
  it('defines the seven statuses — overdue is computed, never stored', () => {
    expect(TASK_STATUSES).toEqual([
      'draft', 'open', 'in_progress', 'blocked', 'awaiting_approval', 'completed', 'cancelled',
    ])
    expect(TASK_STATUSES).not.toContain('overdue')
  })
})

describe('isValidTaskTransition', () => {
  it('allows the normal path', () => {
    expect(isValidTaskTransition('draft', 'open')).toBe(true)
    expect(isValidTaskTransition('open', 'in_progress')).toBe(true)
    expect(isValidTaskTransition('in_progress', 'completed')).toBe(true)
  })

  it('allows blocking and unblocking mid-flight', () => {
    expect(isValidTaskTransition('in_progress', 'blocked')).toBe(true)
    expect(isValidTaskTransition('blocked', 'in_progress')).toBe(true)
  })

  it('fails closed out of terminal states', () => {
    expect(isValidTaskTransition('completed', 'in_progress')).toBe(false)
    expect(isValidTaskTransition('cancelled', 'open')).toBe(false)
  })

  it('rejects skipping straight from draft to completed', () => {
    expect(isValidTaskTransition('draft', 'completed')).toBe(false)
  })

  it('rejects a no-op transition', () => {
    expect(isValidTaskTransition('open', 'open')).toBe(false)
  })

  it('fails closed on an unknown status rather than permitting it', () => {
    expect(isValidTaskTransition('nonsense' as never, 'open')).toBe(false)
    expect(isValidTaskTransition('open', 'nonsense' as never)).toBe(false)
  })

  it('allows cancelling from any live state', () => {
    for (const s of ['draft', 'open', 'in_progress', 'blocked', 'awaiting_approval'] as const) {
      expect(isValidTaskTransition(s, 'cancelled')).toBe(true)
    }
  })
})

describe('allowedNextTaskStatuses', () => {
  it('offers exactly what the server would accept — the UI cannot present a doomed choice', () => {
    for (const from of TASK_STATUSES) {
      for (const to of allowedNextTaskStatuses(from)) {
        expect(isValidTaskTransition(from, to)).toBe(true)
      }
    }
  })

  it('offers nothing from a terminal state', () => {
    expect(allowedNextTaskStatuses('completed')).toEqual([])
    expect(allowedNextTaskStatuses('cancelled')).toEqual([])
  })
})

describe('isOverdue (injectable today — no hidden clock)', () => {
  const today = new Date('2026-07-20T09:00:00+08:00')

  it('is overdue when the due date has passed and work is live', () => {
    expect(isOverdue({ status: 'in_progress', dueDate: new Date('2026-07-19') }, today)).toBe(true)
  })

  it('is not overdue when due today', () => {
    expect(isOverdue({ status: 'open', dueDate: new Date('2026-07-20T23:59:59+08:00') }, today))
      .toBe(false)
  })

  it('is never overdue once completed or cancelled — history does not rot', () => {
    expect(isOverdue({ status: 'completed', dueDate: new Date('2026-07-01') }, today)).toBe(false)
    expect(isOverdue({ status: 'cancelled', dueDate: new Date('2026-07-01') }, today)).toBe(false)
  })

  it('is never overdue without a due date', () => {
    expect(isOverdue({ status: 'open', dueDate: null }, today)).toBe(false)
  })

  it('is not overdue while still a draft — an unsent task is nobody’s problem', () => {
    expect(isOverdue({ status: 'draft', dueDate: new Date('2026-07-01') }, today)).toBe(false)
  })
})
