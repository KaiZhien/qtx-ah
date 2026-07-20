// __tests__/engineering/ecrStatus.test.ts
import { describe, it, expect } from 'vitest'
import {
  ECR_STATUSES, ECR_INITIAL_STATUS, isValidEcrTransition,
  nextEcrStatuses, isTerminalEcrStatus,
} from '@/modules/engineering/domain/ecrStatus'

describe('ECR status vocabulary', () => {
  it('is the simple draft → submitted → accepted/rejected flow', () => {
    expect(ECR_STATUSES).toEqual(['draft', 'submitted', 'accepted', 'rejected'])
  })
  it('starts at draft', () => {
    expect(ECR_INITIAL_STATUS).toBe('draft')
  })
})

describe('isValidEcrTransition', () => {
  it('allows draft → submitted', () => {
    expect(isValidEcrTransition('draft', 'submitted')).toBe(true)
  })
  it('allows submitted → accepted and submitted → rejected', () => {
    expect(isValidEcrTransition('submitted', 'accepted')).toBe(true)
    expect(isValidEcrTransition('submitted', 'rejected')).toBe(true)
  })
  it('forbids skipping submitted (draft → accepted)', () => {
    expect(isValidEcrTransition('draft', 'accepted')).toBe(false)
  })
  it('forbids moving out of a terminal state', () => {
    expect(isValidEcrTransition('accepted', 'draft')).toBe(false)
    expect(isValidEcrTransition('rejected', 'submitted')).toBe(false)
  })
  it('fails closed on an unknown status', () => {
    expect(isValidEcrTransition('bogus', 'submitted')).toBe(false)
    expect(isValidEcrTransition('draft', 'bogus')).toBe(false)
  })
})

describe('nextEcrStatuses', () => {
  it('lists the legal onward moves', () => {
    expect(nextEcrStatuses('submitted')).toEqual(['accepted', 'rejected'])
  })
  it('is empty for terminal or unknown', () => {
    expect(nextEcrStatuses('accepted')).toEqual([])
    expect(nextEcrStatuses('nope')).toEqual([])
  })
})

describe('isTerminalEcrStatus', () => {
  it('flags accepted and rejected as terminal', () => {
    expect(isTerminalEcrStatus('accepted')).toBe(true)
    expect(isTerminalEcrStatus('rejected')).toBe(true)
  })
  it('is false for draft/submitted', () => {
    expect(isTerminalEcrStatus('draft')).toBe(false)
    expect(isTerminalEcrStatus('submitted')).toBe(false)
  })
})
