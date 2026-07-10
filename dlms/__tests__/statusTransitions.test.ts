import { describe, it, expect } from 'vitest'
import { isValidTransition, allowedNextStatuses, TRANSITIONS } from '@/lib/domain/statusTransitions'

// The real seeded status vocabulary (supabase/seed.sql status_option).
// Every TRANSITIONS key and every transition target must be one of these codes.
const VOCAB_STATUS_CODES = ['Stock', 'In Use', 'Repair', 'Retired', 'Lost'] as const
const TERMINAL_STATUSES = ['Retired', 'Lost'] as const

describe('isValidTransition', () => {
  it('allows a permitted transition', () => {
    expect(isValidTransition('Stock', 'In Use')).toBe(true)
    expect(isValidTransition('Repair', 'In Use')).toBe(true)
  })

  it('rejects a disallowed transition between known statuses', () => {
    expect(isValidTransition('Stock', 'In Production')).toBe(false)
    expect(isValidTransition('Repair', 'Shipped')).toBe(false)
  })

  it('treats terminal statuses as having no valid transitions', () => {
    expect(isValidTransition('Retired', 'In Use')).toBe(false)
    expect(isValidTransition('Lost', 'Stock')).toBe(false)
  })

  it('fails closed for an unknown source status', () => {
    expect(isValidTransition('Bogus', 'In Use')).toBe(false)
    expect(isValidTransition('', 'Stock')).toBe(false)
  })
})

describe('allowedNextStatuses', () => {
  it('returns the configured targets for a known status', () => {
    expect(allowedNextStatuses('Repair')).toEqual(['In Use', 'Retired', 'Lost'])
  })

  it('fails closed for an unknown source status (returns [])', () => {
    expect(allowedNextStatuses('Bogus')).toEqual([])
    expect(allowedNextStatuses('')).toEqual([])
    // A newly admin-added vocabulary code not yet in TRANSITIONS must offer nothing.
    expect(allowedNextStatuses('SomeNewAdminStatus')).toEqual([])
  })

  it('returns [] for terminal statuses', () => {
    for (const terminal of TERMINAL_STATUSES) {
      expect(allowedNextStatuses(terminal)).toEqual([])
    }
  })
})

describe('TRANSITIONS graph is aligned with the real vocabulary', () => {
  it('uses only real vocabulary codes as keys', () => {
    for (const key of Object.keys(TRANSITIONS)) {
      expect(VOCAB_STATUS_CODES).toContain(key)
    }
  })

  it('uses only real vocabulary codes as transition targets', () => {
    for (const [from, targets] of Object.entries(TRANSITIONS)) {
      for (const target of targets) {
        expect(VOCAB_STATUS_CODES, `target "${target}" from "${from}"`).toContain(target)
      }
    }
  })

  it('defines a transition entry for every non-terminal vocabulary code', () => {
    for (const code of VOCAB_STATUS_CODES) {
      expect(Object.keys(TRANSITIONS)).toContain(code)
    }
  })

  it('maps terminal statuses to an empty target list', () => {
    for (const terminal of TERMINAL_STATUSES) {
      expect(TRANSITIONS[terminal]).toEqual([])
    }
  })
})
