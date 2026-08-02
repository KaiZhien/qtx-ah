import { describe, it, expect } from 'vitest'
import { relativeAge } from '@/modules/shared/notifications/domain/age'

const NOW = new Date('2026-08-03T12:00:00.000Z')
const ago = (ms: number) => new Date(NOW.getTime() - ms)

const SECOND = 1000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR

describe('relativeAge', () => {
  it.each([
    [0, 'just now'],
    [30 * SECOND, 'just now'],
    [59 * SECOND, 'just now'],
    [MINUTE, '1 minute ago'],
    [2 * MINUTE, '2 minutes ago'],
    [59 * MINUTE, '59 minutes ago'],
    [HOUR, '1 hour ago'],
    [3 * HOUR, '3 hours ago'],
    [23 * HOUR, '23 hours ago'],
    [DAY, '1 day ago'],
    [5 * DAY, '5 days ago'],
    [29 * DAY, '29 days ago'],
    [30 * DAY, '1 month ago'],
    [90 * DAY, '3 months ago'],
  ])('renders %i ms ago as "%s"', (delta, expected) => {
    expect(relativeAge(ago(delta), NOW)).toBe(expected)
  })

  it('singularises exactly one unit and pluralises the rest', () => {
    expect(relativeAge(ago(MINUTE), NOW)).toBe('1 minute ago')
    expect(relativeAge(ago(2 * MINUTE), NOW)).toBe('2 minutes ago')
  })

  it('says "just now" for a FUTURE timestamp rather than something alarming', () => {
    // Clock skew between the app server and Postgres, not an error worth surfacing to a
    // user reading their notification list.
    expect(relativeAge(new Date(NOW.getTime() + 5 * MINUTE), NOW)).toBe('just now')
  })
})
