import { describe, it, expect } from 'vitest'
import {
  MODIFICATION_STATUSES, MODIFICATION_STATUS_LABELS, modificationStatusLabel,
  isValidModificationTransition, allowedNextModificationStatuses,
  evaluateModificationTransition, messageForModificationTransitionError,
  evaluateModificationSignOff, messageForModificationSignOffError,
  type ModificationStatus,
} from '@/modules/maintenance/domain/modificationStatus'

describe('modification status vocabulary (spec §6.3)', () => {
  it('defines exactly the five states the CHECK constraint fences', () => {
    expect(MODIFICATION_STATUSES).toEqual([
      'requested', 'approved', 'completed', 'closed', 'cancelled',
    ])
  })

  it('labels every state', () => {
    for (const s of MODIFICATION_STATUSES) {
      expect(MODIFICATION_STATUS_LABELS[s]).toBeTruthy()
    }
  })

  it('modificationStatusLabel falls back to the raw code for an unknown status', () => {
    expect(modificationStatusLabel('requested')).toBe('Requested')
    expect(modificationStatusLabel('nonsense')).toBe('nonsense')
  })
})

describe('isValidModificationTransition', () => {
  it('allows the happy path requested → approved → completed', () => {
    expect(isValidModificationTransition('requested', 'approved')).toBe(true)
    expect(isValidModificationTransition('approved', 'completed')).toBe(true)
  })

  it('allows cancelling from requested and approved only', () => {
    expect(isValidModificationTransition('requested', 'cancelled')).toBe(true)
    expect(isValidModificationTransition('approved', 'cancelled')).toBe(true)
    expect(isValidModificationTransition('completed', 'cancelled')).toBe(false)
  })

  it('does NOT permit completed → closed through the ordinary path (that is sign-off)', () => {
    expect(isValidModificationTransition('completed', 'closed')).toBe(false)
    expect(allowedNextModificationStatuses('completed')).toEqual([])
  })

  it('rejects skipping straight from requested to completed', () => {
    expect(isValidModificationTransition('requested', 'completed')).toBe(false)
  })

  it('rejects going backwards', () => {
    expect(isValidModificationTransition('approved', 'requested')).toBe(false)
    expect(isValidModificationTransition('completed', 'approved')).toBe(false)
  })

  it('rejects a no-op transition', () => {
    expect(isValidModificationTransition('approved', 'approved')).toBe(false)
  })

  it('fails closed out of terminal states', () => {
    for (const to of MODIFICATION_STATUSES) {
      expect(isValidModificationTransition('closed', to)).toBe(false)
      expect(isValidModificationTransition('cancelled', to)).toBe(false)
    }
  })

  it('fails closed on unknown source or target rather than permitting it', () => {
    expect(isValidModificationTransition('nonsense' as ModificationStatus, 'approved')).toBe(false)
    expect(isValidModificationTransition('requested', 'nonsense' as ModificationStatus)).toBe(false)
  })
})

describe('allowedNextModificationStatuses', () => {
  it('offers exactly what isValidModificationTransition would accept — the UI cannot present a doomed choice', () => {
    for (const from of MODIFICATION_STATUSES) {
      for (const to of allowedNextModificationStatuses(from)) {
        expect(isValidModificationTransition(from, to)).toBe(true)
      }
    }
  })

  it('is exhaustive: any accepted edge is offered', () => {
    for (const from of MODIFICATION_STATUSES) {
      const offered = new Set(allowedNextModificationStatuses(from))
      for (const to of MODIFICATION_STATUSES) {
        if (isValidModificationTransition(from, to)) expect(offered.has(to)).toBe(true)
      }
    }
  })

  it('offers nothing from a terminal state or from completed', () => {
    expect(allowedNextModificationStatuses('closed')).toEqual([])
    expect(allowedNextModificationStatuses('cancelled')).toEqual([])
    expect(allowedNextModificationStatuses('completed')).toEqual([])
  })

  it('returns a fresh array (mutating it cannot corrupt the graph)', () => {
    const a = allowedNextModificationStatuses('requested')
    a.push('closed')
    expect(allowedNextModificationStatuses('requested')).toEqual(['approved', 'cancelled'])
  })
})

describe('evaluateModificationTransition (ordinary changeModificationStatus)', () => {
  it('accepts a legal move with no note', () => {
    expect(evaluateModificationTransition('requested', 'approved', { note: null }))
      .toEqual({ ok: true })
  })

  it('rejects a forbidden edge as transition_forbidden', () => {
    expect(evaluateModificationTransition('requested', 'completed', { note: null }))
      .toEqual({ ok: false, error: 'transition_forbidden' })
  })

  it('requires a note when cancelling (repair\'s requires_reason convention)', () => {
    expect(evaluateModificationTransition('requested', 'cancelled', { note: null }))
      .toEqual({ ok: false, error: 'note_required' })
    expect(evaluateModificationTransition('approved', 'cancelled', { note: '   ' }))
      .toEqual({ ok: false, error: 'note_required' })
    expect(evaluateModificationTransition('approved', 'cancelled', { note: 'ECO withdrawn' }))
      .toEqual({ ok: true })
  })

  it('checks forbiddenness before the note rule (a forbidden cancel is transition_forbidden)', () => {
    expect(evaluateModificationTransition('completed', 'cancelled', { note: null }))
      .toEqual({ ok: false, error: 'transition_forbidden' })
  })

  it('does not require a note for non-cancel legal moves', () => {
    expect(evaluateModificationTransition('approved', 'completed', { note: null }))
      .toEqual({ ok: true })
  })

  it('never accepts a move into closed, with or without a note', () => {
    for (const from of MODIFICATION_STATUSES) {
      expect(evaluateModificationTransition(from, 'closed', { note: 'accepted' }))
        .toEqual({ ok: false, error: 'transition_forbidden' })
    }
  })

  it('produces distinct human messages per error code', () => {
    expect(messageForModificationTransitionError('transition_forbidden', 'Requested', 'Completed'))
      .toContain('Requested')
    expect(messageForModificationTransitionError('note_required', 'Requested', 'Cancelled'))
      .toMatch(/reason/i)
  })
})

describe('evaluateModificationSignOff (the only route to closed)', () => {
  it('accepts from completed', () => {
    expect(evaluateModificationSignOff({ status: 'completed' })).toEqual({ ok: true })
  })

  it('refuses from every other state', () => {
    for (const s of MODIFICATION_STATUSES) {
      if (s === 'completed') continue
      expect(evaluateModificationSignOff({ status: s }))
        .toEqual({ ok: false, error: 'not_completed' })
    }
  })

  it('produces a human message for its error code', () => {
    expect(messageForModificationSignOffError('not_completed')).toMatch(/completed/i)
  })
})
