import { describe, it, expect } from 'vitest'
import { MODULE_REGISTRY, visibleModules } from '@/modules/shared/navigation/moduleRegistry'
import { MODULES } from '@/modules/shared/authz/catalog'
import type { Actor } from '@/modules/shared/authz/catalog'

const actor = (over: Partial<Actor> = {}): Actor => ({
  id: 'u1', roleKey: 'operator',
  permissions: new Set(['view_records']),
  moduleAccess: new Set(['manufacturing', 'maintenance', 'tasks']),
  active: true,
  ...over,
})

describe('MODULE_REGISTRY', () => {
  it('defines every module key exactly once', () => {
    expect(MODULE_REGISTRY.map((m) => m.key).sort()).toEqual([...MODULES].sort())
  })

  it('labels Maintenance in the singular (spec BR-1)', () => {
    expect(MODULE_REGISTRY.find((m) => m.key === 'maintenance')!.label).toBe('Maintenance')
    expect(MODULE_REGISTRY.some((m) => m.label === 'Maintenances')).toBe(false)
  })

  it('orders the five business modules alphabetically ahead of Tasks and Admin', () => {
    expect(MODULE_REGISTRY.map((m) => m.key)).toEqual([
      'engineering', 'finance', 'logistics', 'manufacturing', 'maintenance', 'tasks', 'admin',
    ])
  })
})

describe('visibleModules', () => {
  it('shows only the modules the actor may enter', () => {
    expect(visibleModules(actor()).map((m) => m.key)).toEqual(['manufacturing', 'maintenance', 'tasks'])
  })

  it('hides Admin from a user without manage_users, even with admin module access', () => {
    const a = actor({ moduleAccess: new Set(['admin', 'tasks']) })
    expect(visibleModules(a).map((m) => m.key)).toEqual(['tasks'])
  })

  it('shows Admin to a Super Admin', () => {
    const sa = actor({
      roleKey: 'super_admin',
      permissions: new Set(['view_records', 'manage_users']),
      moduleAccess: new Set(),
    })
    expect(visibleModules(sa).map((m) => m.key)).toContain('admin')
  })

  it('shows every module to a Super Admin despite empty module_access', () => {
    const sa = actor({
      roleKey: 'super_admin',
      permissions: new Set(['view_records', 'manage_users']),
      moduleAccess: new Set(),
    })
    expect(visibleModules(sa)).toHaveLength(MODULES.length)
  })

  it('shows nothing to a deactivated user', () => {
    expect(visibleModules(actor({ active: false }))).toEqual([])
  })
})
