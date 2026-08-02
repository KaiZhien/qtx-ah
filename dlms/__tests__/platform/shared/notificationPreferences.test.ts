import { describe, it, expect } from 'vitest'
import {
  NOTIFICATION_CATEGORIES, isNotificationCategory, DEFAULT_PREF,
  resolveDelivery, type StoredPref,
} from '@/modules/shared/notifications/domain/preferences'

/**
 * The preference resolver decides, for one person and one category, what actually gets
 * delivered. Every test here is about a case where "just read the row" is wrong.
 */
describe('notification categories', () => {
  it('recognises every shipped category and rejects anything else', () => {
    for (const c of NOTIFICATION_CATEGORIES) expect(isNotificationCategory(c)).toBe(true)
    expect(isNotificationCategory('not_a_category')).toBe(false)
    expect(isNotificationCategory('')).toBe(false)
  })
})

describe('resolveDelivery', () => {
  it('delivers in-app and not by email when the user has NO stored row', () => {
    // The load-bearing default: a missing row means defaults, not silence. A newly
    // invited user is notified from their first minute, and a category added in code
    // needs no backfill.
    expect(resolveDelivery(null)).toEqual({ inApp: true, email: false })
    expect(DEFAULT_PREF).toEqual({ inApp: true, email: false, digest: false })
  })

  it('honours an explicit opt-in to email', () => {
    const pref: StoredPref = { inApp: true, email: true, digest: false }
    expect(resolveDelivery(pref)).toEqual({ inApp: true, email: true })
  })

  it('treats in-app and email as INDEPENDENT — muting the bell does not silence email', () => {
    // They answer different questions ("do I want to see this here" vs "do I want to be
    // interrupted"), so neither implies the other.
    expect(resolveDelivery({ inApp: false, email: true, digest: false }))
      .toEqual({ inApp: false, email: true })
  })

  it('suppresses the immediate email when the category is set to digest', () => {
    // digest means "roll this up later", so sending it immediately as well would be the
    // one outcome the setting exists to prevent. No digest job consumes it yet — the
    // resolver honours the intent from day one regardless.
    expect(resolveDelivery({ inApp: true, email: true, digest: true }))
      .toEqual({ inApp: true, email: false })
  })

  it('keeps the in-app copy even when digesting, so nothing is lost while no digest job exists', () => {
    const resolved = resolveDelivery({ inApp: true, email: true, digest: true })
    expect(resolved.inApp).toBe(true)
  })

  it('delivers nothing when the user has opted out of both channels', () => {
    expect(resolveDelivery({ inApp: false, email: false, digest: false }))
      .toEqual({ inApp: false, email: false })
  })
})
