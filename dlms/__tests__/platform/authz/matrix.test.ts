import { describe, it, expect } from 'vitest'
import { can } from '@/modules/shared/authz/policy'
import { PERMISSIONS, ROLES, PERMISSION_MATRIX, MODULES } from '@/modules/shared/authz/catalog'
import type { Actor, Permission, RoleKey } from '@/modules/shared/authz/catalog'

/** An actor holding exactly what the §3.2 matrix says its role holds, with every module open. */
const actorFor = (roleKey: RoleKey): Actor => ({
  id: `u-${roleKey}`,
  roleKey,
  permissions: new Set<Permission>(PERMISSION_MATRIX[roleKey]),
  moduleAccess: new Set(MODULES),
  active: true,
})

describe('permission matrix — generated across all 6 roles × 24 permissions', () => {
  for (const roleKey of ROLES) {
    for (const permission of PERMISSIONS) {
      const expected = PERMISSION_MATRIX[roleKey].includes(permission)
      it(`${roleKey} ${expected ? 'CAN' : 'CANNOT'} ${permission}`, () => {
        expect(can(actorFor(roleKey), permission)).toBe(expected)
      })
    }
  }

  it('gives exactly one role the power to manage the permission fabric', () => {
    const holders = ROLES.filter((r) => PERMISSION_MATRIX[r].includes('manage_roles_permissions'))
    expect(holders).toEqual(['super_admin'])
  })

  it('gives exactly one role the power to request a full system export', () => {
    const holders = ROLES.filter((r) => PERMISSION_MATRIX[r].includes('request_full_export'))
    expect(holders).toEqual(['super_admin'])
  })

  it('never grants a Viewer any mutating permission', () => {
    const mutating: Permission[] = [
      'create_records', 'edit_records', 'delete_records', 'restore_records',
      'change_device_status', 'approve_requests', 'sign_off_repairs', 'upload_files',
      'import_data', 'manage_finance', 'manage_users', 'manage_roles_permissions',
      'manage_vocabularies', 'manage_settings',
    ]
    for (const p of mutating) expect(can(actorFor('viewer'), p)).toBe(false)
  })

  it('withholds manage_finance from Manager (view only — spec §3.2 row 15)', () => {
    expect(can(actorFor('manager'), 'view_finance')).toBe(true)
    expect(can(actorFor('manager'), 'manage_finance')).toBe(false)
  })
})
