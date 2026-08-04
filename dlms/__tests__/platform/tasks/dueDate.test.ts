import { describe, it, expect } from 'vitest'
import { normalizeDueDate } from '@/modules/shared/tasks/domain/dueDate'
import { isOverdue } from '@/modules/shared/tasks/domain/taskStatus'

// ---------------------------------------------------------------------------
// The bare-date bump, and why it stays.
//
// Carried finding: "normalizeDueDate bumps a literal UTC-midnight instant to
// end-of-day". True, and DELIBERATE — the rule is kept, moved next to the thing
// that makes it necessary, and pinned here so that the reasoning survives.
//
// The only producer of a due date in this app is <input type="date">, which
// yields 'YYYY-MM-DD' and parses to UTC midnight — the FIRST instant of the day.
// isOverdue compares instants (`dueDate.getTime() < today.getTime()`), so without
// the bump every task would read overdue for the entire day it is due. There is
// no caller that means a literal midnight instant: the schema accepts a Date, but
// the form and the outbox handoff templates are the only two entry points and
// neither produces one.
//
// The alternative — teaching isOverdue to compare calendar days — was considered
// and is worse: it would move a UTC/local decision out of the caller's hands,
// and isOverdue takes an injected `today` precisely so the caller owns it.
// ---------------------------------------------------------------------------

const bare = (iso: string) => new Date(iso)                 // 'YYYY-MM-DD' -> UTC midnight

describe('normalizeDueDate', () => {
  it('passes undefined through', () => {
    expect(normalizeDueDate(undefined)).toBeUndefined()
  })

  it('pushes a bare calendar day to the last instant of that same UTC day', () => {
    const out = normalizeDueDate(bare('2026-08-10'))!
    expect(out.toISOString()).toBe('2026-08-10T23:59:59.999Z')
  })

  it('leaves a precise moment alone — any non-zero component opts out', () => {
    for (const iso of [
      '2026-08-10T09:00:00.000Z',
      '2026-08-10T00:30:00.000Z',
      '2026-08-10T00:00:30.000Z',
      '2026-08-10T00:00:00.001Z',
    ]) {
      expect(normalizeDueDate(new Date(iso))!.toISOString()).toBe(iso)
    }
  })

  it('never moves the date to another day', () => {
    // The bump is within-day by construction. A naive "+1 day - 1ms" would land on
    // the next day for the 23rd hour of a DST-shifted local date; this is pure UTC
    // field arithmetic, so it cannot.
    for (const day of ['2026-01-01', '2026-02-28', '2026-12-31', '2027-03-01']) {
      const out = normalizeDueDate(bare(day))!
      expect(out.toISOString().slice(0, 10)).toBe(day)
    }
  })

  it('is idempotent — normalizing an already-normalized value changes nothing', () => {
    const once = normalizeDueDate(bare('2026-08-10'))!
    expect(normalizeDueDate(once)!.toISOString()).toBe(once.toISOString())
  })
})

describe('the bump is what makes "due today" not overdue', () => {
  const due = normalizeDueDate(bare('2026-08-10'))!
  const open = (dueDate: Date) => ({ status: 'open' as const, dueDate })

  it('is not overdue at any point during the day it is due', () => {
    for (const now of [
      '2026-08-10T00:00:00.000Z', '2026-08-10T12:00:00.000Z', '2026-08-10T23:59:59.998Z',
    ]) {
      expect(isOverdue(open(due), new Date(now))).toBe(false)
    }
  })

  it('is overdue once the day has passed', () => {
    expect(isOverdue(open(due), new Date('2026-08-11T00:00:00.000Z'))).toBe(true)
  })

  it('WITHOUT the bump the same task is overdue all day — this is the regression', () => {
    const unbumped = bare('2026-08-10')
    expect(isOverdue(open(unbumped), new Date('2026-08-10T00:00:00.001Z'))).toBe(true)
  })
})
