import { groupServiceEventsByDate, formatOccurredOn } from '@/lib/domain/serviceEvents'
import type { ServiceEventWithActor } from '@/lib/domain/serviceEvents'

// Fixed today for deterministic tests
const TODAY = new Date('2026-07-01')
const TODAY_STR = '2026-07-01'
const YESTERDAY_STR = '2026-06-30'
const OLDER_STR = '2026-06-28'

let _seq = 0

function makeEvent(overrides: Partial<ServiceEventWithActor> = {}): ServiceEventWithActor {
  const n = ++_seq
  return {
    id: `se-${n}`,
    device_id: 'dev-1',
    description: `Service event ${n}`,
    occurred_on: TODAY_STR,
    created_by: 'u-1',
    created_at: `2026-07-01T10:00:00Z`,
    actor_email: 'eng@quantumtx.com',
    ...overrides,
  }
}

// ── groupServiceEventsByDate ──────────────────────────────────────────────────

describe('groupServiceEventsByDate', () => {
  it('returns empty array for empty input', () => {
    expect(groupServiceEventsByDate([], TODAY)).toEqual([])
  })

  it('single event on today → one group with label "Today"', () => {
    const event = makeEvent({ occurred_on: TODAY_STR, created_at: '2026-07-01T10:00:00Z' })
    const result = groupServiceEventsByDate([event], TODAY)
    expect(result).toHaveLength(1)
    expect(result[0].date).toBe(TODAY_STR)
    expect(result[0].label).toBe('Today')
    expect(result[0].events).toHaveLength(1)
    expect(result[0].events[0].id).toBe(event.id)
  })

  it('single event on yesterday → one group with label "Yesterday"', () => {
    const event = makeEvent({ occurred_on: YESTERDAY_STR, created_at: '2026-06-30T09:00:00Z' })
    const result = groupServiceEventsByDate([event], TODAY)
    expect(result).toHaveLength(1)
    expect(result[0].date).toBe(YESTERDAY_STR)
    expect(result[0].label).toBe('Yesterday')
    expect(result[0].events).toHaveLength(1)
  })

  it('event older than yesterday → label is a formatted date, not "Today"/"Yesterday"', () => {
    const event = makeEvent({ occurred_on: OLDER_STR, created_at: '2026-06-28T08:00:00Z' })
    const result = groupServiceEventsByDate([event], TODAY)
    expect(result).toHaveLength(1)
    expect(result[0].label).toBe('Jun 28, 2026')
    expect(result[0].label).not.toBe('Today')
    expect(result[0].label).not.toBe('Yesterday')
  })

  it('multiple events on same date → one group with all events, sorted by created_at DESC', () => {
    const earlier = makeEvent({ occurred_on: TODAY_STR, created_at: '2026-07-01T08:00:00Z' })
    const later = makeEvent({ occurred_on: TODAY_STR, created_at: '2026-07-01T15:00:00Z' })
    const result = groupServiceEventsByDate([earlier, later], TODAY)
    expect(result).toHaveLength(1)
    expect(result[0].events).toHaveLength(2)
    // Most recently logged first
    expect(result[0].events[0].id).toBe(later.id)
    expect(result[0].events[1].id).toBe(earlier.id)
  })

  it('events on multiple dates → multiple groups, most-recent date first', () => {
    const older = makeEvent({ occurred_on: OLDER_STR, created_at: '2026-06-28T08:00:00Z' })
    const todayEvt = makeEvent({ occurred_on: TODAY_STR, created_at: '2026-07-01T10:00:00Z' })
    const result = groupServiceEventsByDate([older, todayEvt], TODAY)
    expect(result).toHaveLength(2)
    expect(result[0].date).toBe(TODAY_STR)
    expect(result[1].date).toBe(OLDER_STR)
  })

  it('events on today + yesterday + older date → three groups in correct order', () => {
    const todayEvt = makeEvent({ occurred_on: TODAY_STR, created_at: '2026-07-01T10:00:00Z' })
    const yesterdayEvt = makeEvent({ occurred_on: YESTERDAY_STR, created_at: '2026-06-30T09:00:00Z' })
    const olderEvt = makeEvent({ occurred_on: OLDER_STR, created_at: '2026-06-28T08:00:00Z' })
    const result = groupServiceEventsByDate([olderEvt, todayEvt, yesterdayEvt], TODAY)
    expect(result).toHaveLength(3)
    expect(result[0].date).toBe(TODAY_STR)
    expect(result[0].label).toBe('Today')
    expect(result[1].date).toBe(YESTERDAY_STR)
    expect(result[1].label).toBe('Yesterday')
    expect(result[2].date).toBe(OLDER_STR)
    expect(result[2].label).toBe('Jun 28, 2026')
  })
})

// ── formatOccurredOn ──────────────────────────────────────────────────────────

describe('formatOccurredOn', () => {
  it("today's date → 'Today'", () => {
    expect(formatOccurredOn(TODAY_STR, TODAY)).toBe('Today')
  })

  it("yesterday's date → 'Yesterday'", () => {
    expect(formatOccurredOn(YESTERDAY_STR, TODAY)).toBe('Yesterday')
  })

  it('older date → formatted string', () => {
    expect(formatOccurredOn(OLDER_STR, TODAY)).toBe('Jun 28, 2026')
  })
})
