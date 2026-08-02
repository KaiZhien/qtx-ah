// __tests__/engineering/failureStatus.test.ts
//
// The failure-investigation (FI/RCA) lifecycle, as pure decision logic. Written
// first (TDD, house convention) — the graph and its preconditions are decided
// here, before any DB write can consult them.
import { describe, it, expect } from 'vitest'
import {
  FAILURE_STATUSES, FAILURE_INITIAL_STATUS, FAILURE_STATUS_LABELS, failureStatusLabel,
  isValidFailureTransition, nextFailureStatuses, isTerminalFailureStatus,
  evaluateFailureTransition, messageForFailureTransitionError,
} from '@/modules/engineering/domain/failureStatus'

describe('failure-investigation status vocabulary', () => {
  it('is the six-state RCA loop', () => {
    expect(FAILURE_STATUSES).toEqual([
      'open', 'investigating', 'root_cause_identified', 'corrective_action', 'closed', 'cancelled',
    ])
  })

  it('starts at open', () => {
    expect(FAILURE_INITIAL_STATUS).toBe('open')
  })

  it('labels every status, spelling out the underscored codes', () => {
    for (const s of FAILURE_STATUSES) expect(FAILURE_STATUS_LABELS[s]).toBeTruthy()
    expect(failureStatusLabel('root_cause_identified')).toBe('Root Cause Identified')
    expect(failureStatusLabel('corrective_action')).toBe('Corrective Action')
  })

  it('falls back to the raw code for an unknown status rather than throwing', () => {
    expect(failureStatusLabel('bogus')).toBe('bogus')
  })
})

describe('isValidFailureTransition', () => {
  it('walks the happy path open → investigating → root_cause_identified → corrective_action → closed', () => {
    expect(isValidFailureTransition('open', 'investigating')).toBe(true)
    expect(isValidFailureTransition('investigating', 'root_cause_identified')).toBe(true)
    expect(isValidFailureTransition('root_cause_identified', 'corrective_action')).toBe(true)
    expect(isValidFailureTransition('corrective_action', 'closed')).toBe(true)
  })

  it('allows cancelling only before a root cause is on record', () => {
    expect(isValidFailureTransition('open', 'cancelled')).toBe(true)
    expect(isValidFailureTransition('investigating', 'cancelled')).toBe(true)
    expect(isValidFailureTransition('root_cause_identified', 'cancelled')).toBe(false)
    expect(isValidFailureTransition('corrective_action', 'cancelled')).toBe(false)
  })

  it('allows the two analysis back-edges (8D verification failed)', () => {
    expect(isValidFailureTransition('root_cause_identified', 'investigating')).toBe(true)
    expect(isValidFailureTransition('corrective_action', 'investigating')).toBe(true)
  })

  it('forbids skipping straight to closed', () => {
    expect(isValidFailureTransition('open', 'closed')).toBe(false)
    expect(isValidFailureTransition('investigating', 'closed')).toBe(false)
    expect(isValidFailureTransition('root_cause_identified', 'closed')).toBe(false)
  })

  it('forbids moving out of a terminal state', () => {
    expect(isValidFailureTransition('closed', 'investigating')).toBe(false)
    expect(isValidFailureTransition('cancelled', 'open')).toBe(false)
  })

  it('fails closed on unknown statuses in either position', () => {
    expect(isValidFailureTransition('bogus', 'investigating')).toBe(false)
    expect(isValidFailureTransition('open', 'bogus')).toBe(false)
    expect(isValidFailureTransition('', '')).toBe(false)
  })
})

describe('nextFailureStatuses / isTerminalFailureStatus', () => {
  it('lists onward moves', () => {
    expect(nextFailureStatuses('open')).toEqual(['investigating', 'cancelled'])
    expect(nextFailureStatuses('corrective_action')).toEqual(['closed', 'investigating'])
  })

  it('returns [] for terminal and for unknown states', () => {
    expect(nextFailureStatuses('closed')).toEqual([])
    expect(nextFailureStatuses('bogus')).toEqual([])
  })

  it('marks closed and cancelled terminal; unknown is NOT terminal', () => {
    expect(isTerminalFailureStatus('closed')).toBe(true)
    expect(isTerminalFailureStatus('cancelled')).toBe(true)
    expect(isTerminalFailureStatus('open')).toBe(false)
    expect(isTerminalFailureStatus('bogus')).toBe(false)
  })
})

describe('evaluateFailureTransition preconditions', () => {
  const facts = { rootCause: null as string | null, correctiveAction: null as string | null }

  it('refuses an illegal edge before checking any precondition', () => {
    expect(evaluateFailureTransition('open', 'closed', { ...facts, note: 'x' }))
      .toEqual({ ok: false, error: 'transition_forbidden' })
  })

  it('requires a recorded root cause to reach root_cause_identified', () => {
    expect(evaluateFailureTransition('investigating', 'root_cause_identified', { ...facts, note: null }))
      .toEqual({ ok: false, error: 'root_cause_required' })
    expect(evaluateFailureTransition('investigating', 'root_cause_identified', { ...facts, rootCause: '   ', note: null }))
      .toEqual({ ok: false, error: 'root_cause_required' })
    expect(evaluateFailureTransition('investigating', 'root_cause_identified', { ...facts, rootCause: 'cold solder joint', note: null }))
      .toEqual({ ok: true })
  })

  it('requires a recorded corrective action to reach corrective_action', () => {
    const withCause = { ...facts, rootCause: 'cold solder joint' }
    expect(evaluateFailureTransition('root_cause_identified', 'corrective_action', { ...withCause, note: null }))
      .toEqual({ ok: false, error: 'corrective_action_required' })
    expect(evaluateFailureTransition('root_cause_identified', 'corrective_action', { ...withCause, correctiveAction: 'reflow profile revised', note: null }))
      .toEqual({ ok: true })
  })

  it('requires both facts to still be on record when closing', () => {
    expect(evaluateFailureTransition('corrective_action', 'closed', { rootCause: null, correctiveAction: 'x', note: null }))
      .toEqual({ ok: false, error: 'root_cause_required' })
    expect(evaluateFailureTransition('corrective_action', 'closed', { rootCause: 'x', correctiveAction: null, note: null }))
      .toEqual({ ok: false, error: 'corrective_action_required' })
    expect(evaluateFailureTransition('corrective_action', 'closed', { rootCause: 'x', correctiveAction: 'y', note: null }))
      .toEqual({ ok: true })
  })

  it('requires a note to cancel', () => {
    expect(evaluateFailureTransition('open', 'cancelled', { ...facts, note: null }))
      .toEqual({ ok: false, error: 'note_required' })
    expect(evaluateFailureTransition('open', 'cancelled', { ...facts, note: '  ' }))
      .toEqual({ ok: false, error: 'note_required' })
    expect(evaluateFailureTransition('open', 'cancelled', { ...facts, note: 'duplicate of FI-2026-0001' }))
      .toEqual({ ok: true })
  })

  it('needs nothing extra for the back-edges', () => {
    expect(evaluateFailureTransition('corrective_action', 'investigating', { ...facts, note: null }))
      .toEqual({ ok: true })
  })
})

describe('messageForFailureTransitionError', () => {
  it('names the two states for a forbidden edge and explains each precondition', () => {
    expect(messageForFailureTransitionError('transition_forbidden', 'Open', 'Closed'))
      .toBe('Cannot move a failure investigation from "Open" to "Closed".')
    expect(messageForFailureTransitionError('root_cause_required', 'A', 'B')).toMatch(/root cause/i)
    expect(messageForFailureTransitionError('corrective_action_required', 'A', 'B')).toMatch(/corrective action/i)
    expect(messageForFailureTransitionError('note_required', 'A', 'B')).toMatch(/reason/i)
  })
})
