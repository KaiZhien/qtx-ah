import { describe, it, expect } from 'vitest'
import {
  assertNotLastSuperAdmin, assertNotSelfEscalation,
  LastSuperAdminError, SelfEscalationError,
} from '@/modules/admin/domain/userGuards'
import type { Actor } from '@/modules/shared/authz/catalog'

const sa: Actor = {
  id: 'sa-1', roleKey: 'super_admin',
  permissions: new Set(['manage_users']), moduleAccess: new Set(['admin']), active: true,
}

describe('assertNotLastSuperAdmin', () => {
  it('blocks deactivating or demoting the only Super Admin', () => {
    expect(() => assertNotLastSuperAdmin({
      targetUserId: 'sa-1', targetRoleKey: 'super_admin', activeSuperAdminIds: ['sa-1'],
    })).toThrow(LastSuperAdminError)
  })

  it('allows it when another Super Admin remains', () => {
    expect(() => assertNotLastSuperAdmin({
      targetUserId: 'sa-1', targetRoleKey: 'super_admin', activeSuperAdminIds: ['sa-1', 'sa-2'],
    })).not.toThrow()
  })

  it('ignores non-Super-Admin targets entirely', () => {
    expect(() => assertNotLastSuperAdmin({
      targetUserId: 'op-1', targetRoleKey: 'operator', activeSuperAdminIds: ['sa-1'],
    })).not.toThrow()
  })
})

describe('assertNotSelfEscalation', () => {
  it('blocks a user changing their own role or access', () => {
    expect(() => assertNotSelfEscalation(sa, 'sa-1')).toThrow(SelfEscalationError)
  })

  it('allows acting on other users', () => {
    expect(() => assertNotSelfEscalation(sa, 'op-1')).not.toThrow()
  })
})
