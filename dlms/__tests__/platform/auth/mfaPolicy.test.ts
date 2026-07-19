import { describe, it, expect } from 'vitest'
import { requiresMfa } from '@/modules/shared/auth/mfaPolicy'
import { ROLES } from '@/modules/shared/authz/catalog'

describe('requiresMfa (spec D35 — mandatory for privileged roles, optional otherwise)', () => {
  it('requires MFA for the three privileged roles', () => {
    expect(requiresMfa('super_admin')).toBe(true)
    expect(requiresMfa('admin')).toBe(true)
    expect(requiresMfa('finance')).toBe(true)
  })

  it('does not require MFA for floor roles', () => {
    expect(requiresMfa('manager')).toBe(false)
    expect(requiresMfa('operator')).toBe(false)
    expect(requiresMfa('viewer')).toBe(false)
  })

  it('covers every role — no role is unclassified', () => {
    for (const r of ROLES) expect(typeof requiresMfa(r)).toBe('boolean')
  })
})
