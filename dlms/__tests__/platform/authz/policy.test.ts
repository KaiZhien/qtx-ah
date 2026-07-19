import { describe, it, expect } from 'vitest'
import { can } from '@/modules/shared/authz/policy'
import type { Actor } from '@/modules/shared/authz/catalog'

const actor = (over: Partial<Actor> = {}): Actor => ({
  id: 'u1',
  roleKey: 'operator',
  permissions: new Set(['view_records', 'edit_records']),
  moduleAccess: new Set(['manufacturing', 'tasks']),
  active: true,
  ...over,
})

describe('can — the pure authorization rule (spec §3.2)', () => {
  it('allows a held permission inside an accessible module', () => {
    expect(can(actor(), 'edit_records', 'manufacturing')).toBe(true)
  })

  it('denies a permission the role does not hold', () => {
    expect(can(actor(), 'approve_requests', 'manufacturing')).toBe(false)
  })

  it('denies an inaccessible module even when the permission is held', () => {
    expect(can(actor(), 'view_records', 'finance')).toBe(false)
  })

  it('denies EVERYTHING to an inactive user, including a super admin', () => {
    const dead = actor({ roleKey: 'super_admin', active: false })
    expect(can(dead, 'view_records', 'manufacturing')).toBe(false)
    expect(can(dead, 'manage_users', 'admin')).toBe(false)
  })

  it('lets super_admin bypass the module gate (implicit access to all modules)', () => {
    const sa = actor({
      roleKey: 'super_admin',
      permissions: new Set(['manage_users']),
      moduleAccess: new Set(),   // deliberately empty
    })
    expect(can(sa, 'manage_users', 'admin')).toBe(true)
  })

  it('does NOT let a non-super_admin bypass the module gate', () => {
    const ad = actor({ roleKey: 'admin', permissions: new Set(['view_records']), moduleAccess: new Set() })
    expect(can(ad, 'view_records', 'finance')).toBe(false)
  })

  it('checks the permission with no module gate when module is omitted', () => {
    expect(can(actor(), 'view_records')).toBe(true)
    expect(can(actor(), 'manage_users')).toBe(false)
  })
})
