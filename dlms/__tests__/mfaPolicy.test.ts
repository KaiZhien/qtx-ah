import { describe, it, expect } from 'vitest'
import { requiresMfa, mfaGateStatus, mfaStepFor } from '@/modules/shared/auth/mfaPolicy'

describe('requiresMfa (unchanged)', () => {
  it('requires MFA for super_admin/admin/finance and not others', () => {
    expect(requiresMfa('super_admin')).toBe(true)
    expect(requiresMfa('admin')).toBe(true)
    expect(requiresMfa('finance')).toBe(true)
    expect(requiresMfa('manager')).toBe(false)
    expect(requiresMfa('operator')).toBe(false)
    expect(requiresMfa('viewer')).toBe(false)
  })
})

describe('mfaGateStatus', () => {
  it('is satisfied for a non-MFA role at any level', () => {
    expect(mfaGateStatus({ roleKey: 'viewer', currentLevel: null })).toBe('satisfied')
    expect(mfaGateStatus({ roleKey: 'operator', currentLevel: 'aal1' })).toBe('satisfied')
  })
  it('requires elevation for an MFA role below aal2', () => {
    expect(mfaGateStatus({ roleKey: 'admin', currentLevel: 'aal1' })).toBe('required')
    expect(mfaGateStatus({ roleKey: 'super_admin', currentLevel: null })).toBe('required') // fail closed
  })
  it('is satisfied for an MFA role at aal2', () => {
    expect(mfaGateStatus({ roleKey: 'finance', currentLevel: 'aal2' })).toBe('satisfied')
  })
})

describe('mfaStepFor', () => {
  it('is done once at aal2, whatever the factor state', () => {
    expect(mfaStepFor({ hasVerifiedFactor: true, currentLevel: 'aal2' })).toBe('done')
    expect(mfaStepFor({ hasVerifiedFactor: false, currentLevel: 'aal2' })).toBe('done')
  })
  it('enrolls when below aal2 with no verified factor', () => {
    expect(mfaStepFor({ hasVerifiedFactor: false, currentLevel: 'aal1' })).toBe('enroll')
    expect(mfaStepFor({ hasVerifiedFactor: false, currentLevel: null })).toBe('enroll') // fail closed
  })
  it('challenges when below aal2 with a verified factor', () => {
    expect(mfaStepFor({ hasVerifiedFactor: true, currentLevel: 'aal1' })).toBe('challenge')
  })
})
