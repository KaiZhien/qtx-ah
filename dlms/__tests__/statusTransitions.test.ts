import { describe, it, expect } from 'vitest'
import { isValidTransition, allowedNextStatuses } from '@/lib/domain/statusTransitions'

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
})
