import { can, ACTIONS } from '@/lib/auth/permissions'
import type { Role } from '@/lib/types'

const allActions = Object.values(ACTIONS)

describe('viewer permissions', () => {
  it('can view records', () => {
    expect(can('viewer', ACTIONS.VIEW_RECORDS)).toBe(true)
  })
  it('cannot create a device', () => {
    expect(can('viewer', ACTIONS.CREATE_DEVICE)).toBe(false)
  })
  it('cannot edit a device', () => {
    expect(can('viewer', ACTIONS.EDIT_DEVICE)).toBe(false)
  })
  it('cannot change status', () => {
    expect(can('viewer', ACTIONS.CHANGE_STATUS)).toBe(false)
  })
  it('cannot import data', () => {
    expect(can('viewer', ACTIONS.IMPORT_DATA)).toBe(false)
  })
  it('cannot export data', () => {
    expect(can('viewer', ACTIONS.EXPORT_DATA)).toBe(false)
  })
  it('cannot soft delete', () => {
    expect(can('viewer', ACTIONS.SOFT_DELETE)).toBe(false)
  })
  it('cannot manage vocabularies', () => {
    expect(can('viewer', ACTIONS.MANAGE_VOCABULARIES)).toBe(false)
  })
  it('cannot manage users', () => {
    expect(can('viewer', ACTIONS.MANAGE_USERS)).toBe(false)
  })
})

describe('engineer permissions', () => {
  it('can view records', () => {
    expect(can('engineer', ACTIONS.VIEW_RECORDS)).toBe(true)
  })
  it('can create a device', () => {
    expect(can('engineer', ACTIONS.CREATE_DEVICE)).toBe(true)
  })
  it('can edit a device', () => {
    expect(can('engineer', ACTIONS.EDIT_DEVICE)).toBe(true)
  })
  it('can change status', () => {
    expect(can('engineer', ACTIONS.CHANGE_STATUS)).toBe(true)
  })
  it('can import data', () => {
    expect(can('engineer', ACTIONS.IMPORT_DATA)).toBe(true)
  })
  it('can export data', () => {
    expect(can('engineer', ACTIONS.EXPORT_DATA)).toBe(true)
  })
  it('cannot soft delete', () => {
    expect(can('engineer', ACTIONS.SOFT_DELETE)).toBe(false)
  })
  it('cannot manage vocabularies', () => {
    expect(can('engineer', ACTIONS.MANAGE_VOCABULARIES)).toBe(false)
  })
  it('cannot manage users', () => {
    expect(can('engineer', ACTIONS.MANAGE_USERS)).toBe(false)
  })
  it('cannot view full audit log (cross-system)', () => {
    expect(can('engineer', ACTIONS.VIEW_FULL_AUDIT_LOG)).toBe(false)
  })
})

describe('admin permissions', () => {
  it('has all permissions', () => {
    for (const action of allActions) {
      expect(can('admin', action)).toBe(true)
    }
  })
})

describe('system permissions', () => {
  it('has no permissions', () => {
    for (const action of allActions) {
      expect(can('system', action)).toBe(false)
    }
  })
})

describe('VIEW_ANALYTICS permission', () => {
  it('viewer can view_analytics', () => {
    expect(can('viewer', ACTIONS.VIEW_ANALYTICS)).toBe(true)
  })
  it('engineer can view_analytics', () => {
    expect(can('engineer', ACTIONS.VIEW_ANALYTICS)).toBe(true)
  })
  it('admin can view_analytics', () => {
    expect(can('admin', ACTIONS.VIEW_ANALYTICS)).toBe(true)
  })
  it('system cannot view_analytics', () => {
    expect(can('system', ACTIONS.VIEW_ANALYTICS)).toBe(false)
  })
})
