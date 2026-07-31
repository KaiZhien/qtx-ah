import { describe, it, expect } from 'vitest'
import {
  REPAIR_STATUSES, REPAIR_STATUS_LABELS, repairStatusLabel,
  isValidRepairTransition, allowedNextRepairStatuses,
  evaluateRepairTransition, messageForRepairTransitionError,
  evaluateSignOff, messageForSignOffError, SIGN_OFF_ERROR_CODES,
  type RepairStatus, type SignOffDecision,
} from '@/modules/maintenance/domain/repairStatus'

describe('repair status vocabulary (spec §5.3 — six-state workflow)', () => {
  it('defines exactly the seven states (6 workflow states + cancelled)', () => {
    expect(REPAIR_STATUSES).toEqual([
      'reported', 'in_diagnosis', 'in_repair', 'testing', 'awaiting_sign_off', 'closed', 'cancelled',
    ])
  })

  it('labels every state', () => {
    for (const s of REPAIR_STATUSES) {
      expect(REPAIR_STATUS_LABELS[s]).toBeTruthy()
    }
  })

  it('repairStatusLabel falls back to the raw code for an unknown status', () => {
    expect(repairStatusLabel('reported')).toBe('Reported')
    expect(repairStatusLabel('nonsense')).toBe('nonsense')
  })
})

describe('isValidRepairTransition', () => {
  it('allows the normal happy path through the workflow', () => {
    expect(isValidRepairTransition('reported', 'in_diagnosis')).toBe(true)
    expect(isValidRepairTransition('in_diagnosis', 'in_repair')).toBe(true)
    expect(isValidRepairTransition('in_repair', 'testing')).toBe(true)
    expect(isValidRepairTransition('testing', 'awaiting_sign_off')).toBe(true)
  })

  it('allows testing → in_repair on a failed test', () => {
    expect(isValidRepairTransition('testing', 'in_repair')).toBe(true)
  })

  it('allows in_diagnosis → closed (no fault found)', () => {
    expect(isValidRepairTransition('in_diagnosis', 'closed')).toBe(true)
  })

  it('allows cancelling only from reported and in_diagnosis (spec §5.3)', () => {
    expect(isValidRepairTransition('reported', 'cancelled')).toBe(true)
    expect(isValidRepairTransition('in_diagnosis', 'cancelled')).toBe(true)
    expect(isValidRepairTransition('in_repair', 'cancelled')).toBe(false)
    expect(isValidRepairTransition('testing', 'cancelled')).toBe(false)
    expect(isValidRepairTransition('awaiting_sign_off', 'cancelled')).toBe(false)
  })

  it('does NOT permit awaiting_sign_off → closed through the ordinary path (that is sign-off)', () => {
    expect(isValidRepairTransition('awaiting_sign_off', 'closed')).toBe(false)
    expect(allowedNextRepairStatuses('awaiting_sign_off')).toEqual([])
  })

  it('rejects skipping straight from reported to testing', () => {
    expect(isValidRepairTransition('reported', 'testing')).toBe(false)
  })

  it('rejects a no-op transition', () => {
    expect(isValidRepairTransition('in_repair', 'in_repair')).toBe(false)
  })

  it('fails closed out of terminal states', () => {
    for (const to of REPAIR_STATUSES) {
      expect(isValidRepairTransition('closed', to)).toBe(false)
      expect(isValidRepairTransition('cancelled', to)).toBe(false)
    }
  })

  it('fails closed on unknown source or target rather than permitting it', () => {
    expect(isValidRepairTransition('nonsense' as RepairStatus, 'in_diagnosis')).toBe(false)
    expect(isValidRepairTransition('reported', 'nonsense' as RepairStatus)).toBe(false)
  })
})

describe('allowedNextRepairStatuses', () => {
  it('offers exactly what isValidRepairTransition would accept — the UI cannot present a doomed choice', () => {
    for (const from of REPAIR_STATUSES) {
      for (const to of allowedNextRepairStatuses(from)) {
        expect(isValidRepairTransition(from, to)).toBe(true)
      }
    }
  })

  it('is exhaustive: any accepted edge is offered', () => {
    for (const from of REPAIR_STATUSES) {
      const offered = new Set(allowedNextRepairStatuses(from))
      for (const to of REPAIR_STATUSES) {
        if (isValidRepairTransition(from, to)) expect(offered.has(to)).toBe(true)
      }
    }
  })

  it('offers nothing from a terminal state or from awaiting_sign_off', () => {
    expect(allowedNextRepairStatuses('closed')).toEqual([])
    expect(allowedNextRepairStatuses('cancelled')).toEqual([])
    expect(allowedNextRepairStatuses('awaiting_sign_off')).toEqual([])
  })

  it('returns a fresh array (mutating it cannot corrupt the graph)', () => {
    const a = allowedNextRepairStatuses('reported')
    a.push('closed')
    expect(allowedNextRepairStatuses('reported')).toEqual(['in_diagnosis', 'cancelled'])
  })
})

describe('evaluateRepairTransition (ordinary changeRepairStatus)', () => {
  it('accepts a legal move with no note', () => {
    expect(evaluateRepairTransition('reported', 'in_diagnosis', { note: null })).toEqual({ ok: true })
  })

  it('rejects a forbidden edge as transition_forbidden', () => {
    expect(evaluateRepairTransition('reported', 'testing', { note: null }))
      .toEqual({ ok: false, error: 'transition_forbidden' })
  })

  it('requires a note when cancelling (requires_reason style)', () => {
    expect(evaluateRepairTransition('reported', 'cancelled', { note: null }))
      .toEqual({ ok: false, error: 'note_required' })
    expect(evaluateRepairTransition('reported', 'cancelled', { note: '   ' }))
      .toEqual({ ok: false, error: 'note_required' })
    expect(evaluateRepairTransition('reported', 'cancelled', { note: 'customer withdrew' }))
      .toEqual({ ok: true })
  })

  it('checks forbiddenness before the note rule (a forbidden cancel is transition_forbidden, not note_required)', () => {
    expect(evaluateRepairTransition('in_repair', 'cancelled', { note: null }))
      .toEqual({ ok: false, error: 'transition_forbidden' })
  })

  it('does not require a note for non-cancel legal moves', () => {
    expect(evaluateRepairTransition('in_diagnosis', 'closed', { note: null })).toEqual({ ok: true })
    expect(evaluateRepairTransition('testing', 'in_repair', { note: null })).toEqual({ ok: true })
  })

  it('produces distinct human messages per error code', () => {
    expect(messageForRepairTransitionError('transition_forbidden', 'Reported', 'Testing'))
      .toContain('Reported')
    expect(messageForRepairTransitionError('note_required', 'Reported', 'Cancelled'))
      .toMatch(/reason/i)
  })
})

describe('evaluateSignOff (the sign-off precondition, spec §5.3/§5.4)', () => {
  // The facts a repair that has done everything right presents. Individual
  // tests override exactly the fact under examination.
  const ready = {
    status: 'awaiting_sign_off' as RepairStatus,
    testingNotes: 'all tests pass',
    partsReplaced: false,
    recordedReplacementCount: 0,
  }

  it('accepts only from awaiting_sign_off with testing notes present', () => {
    expect(evaluateSignOff(ready)).toEqual({ ok: true })
  })

  it('refuses from any non-awaiting_sign_off state', () => {
    for (const s of REPAIR_STATUSES) {
      if (s === 'awaiting_sign_off') continue
      expect(evaluateSignOff({ ...ready, status: s }))
        .toEqual({ ok: false, error: 'not_awaiting_sign_off' })
    }
  })

  it('refuses when testing notes are missing or blank', () => {
    expect(evaluateSignOff({ ...ready, testingNotes: null }))
      .toEqual({ ok: false, error: 'testing_notes_required' })
    expect(evaluateSignOff({ ...ready, testingNotes: '   ' }))
      .toEqual({ ok: false, error: 'testing_notes_required' })
  })

  it('checks the state before the testing-notes rule', () => {
    expect(evaluateSignOff({ ...ready, status: 'reported', testingNotes: null }))
      .toEqual({ ok: false, error: 'not_awaiting_sign_off' })
  })

  // ── The parts-replaced claim must be BACKED (spec §5.4) ───────────────────
  // The whole point: a technician asserts a board was swapped, signs off, and
  // the component record never changed. Refused.
  it('refuses sign-off when parts_replaced is claimed but nothing references the repair', () => {
    expect(evaluateSignOff({ ...ready, partsReplaced: true, recordedReplacementCount: 0 }))
      .toEqual({ ok: false, error: 'replacement_not_recorded' })
  })

  it('accepts once at least one installation references the repair', () => {
    expect(evaluateSignOff({ ...ready, partsReplaced: true, recordedReplacementCount: 1 }))
      .toEqual({ ok: true })
    // A §14 replacement stamps BOTH the closed row and the new one, so two is
    // the ordinary count for a single swap — the rule is "at least one".
    expect(evaluateSignOff({ ...ready, partsReplaced: true, recordedReplacementCount: 2 }))
      .toEqual({ ok: true })
  })

  it('has nothing to verify when no claim was made (the default for every repair)', () => {
    expect(evaluateSignOff({ ...ready, partsReplaced: false, recordedReplacementCount: 0 }))
      .toEqual({ ok: true })
    // A replacement recorded WITHOUT the claim is not an error either — the
    // rule backs a claim, it does not forbid unclaimed work.
    expect(evaluateSignOff({ ...ready, partsReplaced: false, recordedReplacementCount: 3 }))
      .toEqual({ ok: true })
  })

  it('checks state and testing notes before the replacement rule', () => {
    expect(evaluateSignOff({
      ...ready, status: 'in_repair', partsReplaced: true, recordedReplacementCount: 0,
    })).toEqual({ ok: false, error: 'not_awaiting_sign_off' })
    expect(evaluateSignOff({
      ...ready, testingNotes: null, partsReplaced: true, recordedReplacementCount: 0,
    })).toEqual({ ok: false, error: 'testing_notes_required' })
  })

  it('the full matrix of (partsReplaced × recordedReplacementCount) on an otherwise-ready repair', () => {
    const matrix: [boolean, number, SignOffDecision][] = [
      [false, 0, { ok: true }],
      [false, 1, { ok: true }],
      [true, 0, { ok: false, error: 'replacement_not_recorded' }],
      [true, 1, { ok: true }],
    ]
    for (const [partsReplaced, recordedReplacementCount, expected] of matrix) {
      expect(evaluateSignOff({ ...ready, partsReplaced, recordedReplacementCount }))
        .toEqual(expected)
    }
  })

  it('produces distinct human messages per error code', () => {
    expect(messageForSignOffError('not_awaiting_sign_off')).toMatch(/awaiting sign-off/i)
    expect(messageForSignOffError('testing_notes_required')).toMatch(/testing notes/i)
    expect(messageForSignOffError('replacement_not_recorded')).toMatch(/replace/i)
    const messages = new Set(SIGN_OFF_ERROR_CODES.map(messageForSignOffError))
    expect(messages.size).toBe(SIGN_OFF_ERROR_CODES.length)
  })
})
