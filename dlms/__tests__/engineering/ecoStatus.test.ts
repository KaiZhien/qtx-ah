// __tests__/engineering/ecoStatus.test.ts
import { describe, it, expect } from 'vitest'
import {
  ECO_STATUSES, ECO_INITIAL_STATUS, ECO_APPROVE_STATUS, isValidEcoTransition,
  nextEcoStatuses, isTerminalEcoStatus, ecoTransitionRequiresApproval,
} from '@/modules/engineering/domain/ecoStatus'

describe('ECO status vocabulary', () => {
  it('is the draft → submitted → approved → implemented (+ rejected) flow', () => {
    expect(ECO_STATUSES).toEqual(['draft', 'submitted', 'approved', 'implemented', 'rejected'])
  })
  it('starts at draft', () => {
    expect(ECO_INITIAL_STATUS).toBe('draft')
  })
  it('names approved as the approval-gated target', () => {
    expect(ECO_APPROVE_STATUS).toBe('approved')
  })
})

describe('isValidEcoTransition', () => {
  it('allows the happy path draft → submitted → approved → implemented', () => {
    expect(isValidEcoTransition('draft', 'submitted')).toBe(true)
    expect(isValidEcoTransition('submitted', 'approved')).toBe(true)
    expect(isValidEcoTransition('approved', 'implemented')).toBe(true)
  })
  it('allows submitted → rejected', () => {
    expect(isValidEcoTransition('submitted', 'rejected')).toBe(true)
  })
  it('forbids skipping approval (submitted → implemented)', () => {
    expect(isValidEcoTransition('submitted', 'implemented')).toBe(false)
  })
  it('forbids approving straight from draft', () => {
    expect(isValidEcoTransition('draft', 'approved')).toBe(false)
  })
  it('forbids moving out of terminal states', () => {
    expect(isValidEcoTransition('implemented', 'approved')).toBe(false)
    expect(isValidEcoTransition('rejected', 'submitted')).toBe(false)
  })
  it('fails closed on unknown statuses', () => {
    expect(isValidEcoTransition('bogus', 'submitted')).toBe(false)
    expect(isValidEcoTransition('approved', 'bogus')).toBe(false)
  })
})

describe('ecoTransitionRequiresApproval', () => {
  it('is true only for the → approved step', () => {
    expect(ecoTransitionRequiresApproval('approved')).toBe(true)
    expect(ecoTransitionRequiresApproval('submitted')).toBe(false)
    expect(ecoTransitionRequiresApproval('implemented')).toBe(false)
    expect(ecoTransitionRequiresApproval('rejected')).toBe(false)
  })
})

describe('nextEcoStatuses / isTerminalEcoStatus', () => {
  it('lists onward moves', () => {
    expect(nextEcoStatuses('submitted')).toEqual(['approved', 'rejected'])
    expect(nextEcoStatuses('approved')).toEqual(['implemented'])
  })
  it('marks implemented and rejected terminal', () => {
    expect(isTerminalEcoStatus('implemented')).toBe(true)
    expect(isTerminalEcoStatus('rejected')).toBe(true)
    expect(isTerminalEcoStatus('draft')).toBe(false)
  })
})
