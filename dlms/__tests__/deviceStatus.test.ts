// __tests__/deviceStatus.test.ts
import { describe, it, expect } from 'vitest'
import {
  evaluateStatusChange, InvalidStatusChangeError, messageForStatusChangeError,
} from '@/modules/manufacturing/domain/deviceStatus'

describe('evaluateStatusChange', () => {
  it('rejects a move with no status_transition row (fail-closed)', () => {
    const d = evaluateStatusChange(
      { transitionExists: false, requiresReason: false, toIsTerminal: false },
      { reason: null })
    expect(d).toEqual({ ok: false, error: 'transition_forbidden' })
  })

  it('rejects when the transition requires a reason and none is given', () => {
    expect(evaluateStatusChange(
      { transitionExists: true, requiresReason: true, toIsTerminal: false },
      { reason: '   ' })).toEqual({ ok: false, error: 'reason_required' })
  })

  it('allows a normal transition, no delete permission needed', () => {
    expect(evaluateStatusChange(
      { transitionExists: true, requiresReason: false, toIsTerminal: false },
      { reason: null })).toEqual({ ok: true, requiresDeletePermission: false })
  })

  it('allows a reason-carrying transition when a reason is present', () => {
    expect(evaluateStatusChange(
      { transitionExists: true, requiresReason: true, toIsTerminal: false },
      { reason: 'customer returned unit' })).toEqual({ ok: true, requiresDeletePermission: false })
  })

  it('flags a terminal target as needing delete permission', () => {
    expect(evaluateStatusChange(
      { transitionExists: true, requiresReason: true, toIsTerminal: true },
      { reason: 'beyond economic repair' })).toEqual({ ok: true, requiresDeletePermission: true })
  })

  it('checks transitionExists before requiresReason (forbidden wins over reason)', () => {
    expect(evaluateStatusChange(
      { transitionExists: false, requiresReason: true, toIsTerminal: false },
      { reason: null })).toEqual({ ok: false, error: 'transition_forbidden' })
  })
})

describe('messageForStatusChangeError', () => {
  it('names both statuses for a forbidden move', () => {
    expect(messageForStatusChangeError('transition_forbidden', 'Retired', 'Active'))
      .toBe('Cannot move a device from "Retired" to "Active".')
  })
  it('asks for a reason', () => {
    expect(messageForStatusChangeError('reason_required', 'Active', 'Returned'))
      .toBe('Moving from "Active" to "Returned" requires a reason.')
  })
})

describe('InvalidStatusChangeError', () => {
  it('carries the code', () => {
    const e = new InvalidStatusChangeError('reason_required', 'nope')
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('reason_required')
    expect(e.name).toBe('InvalidStatusChangeError')
  })
})
