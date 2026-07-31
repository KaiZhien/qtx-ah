import { describe, it, expect } from 'vitest'
import {
  MODULE_REGISTRY, CROSS_MODULE_LINKS, visibleModules, visibleCrossModuleLinks,
} from '@/modules/shared/navigation/moduleRegistry'
import { MODULES } from '@/modules/shared/authz/catalog'
import { MODULE_ICONS } from '@/components/platform/moduleIcons'
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

describe('CROSS_MODULE_LINKS', () => {
  it('offers Approvals, gated on the bare approve_requests permission', () => {
    expect(CROSS_MODULE_LINKS.map((l) => l.key)).toEqual(['approvals'])
    const approvals = CROSS_MODULE_LINKS[0]
    expect(approvals).toMatchObject({ href: '/approvals', gate: 'approve_requests' })
  })

  it('does not collide with a module key', () => {
    for (const link of CROSS_MODULE_LINKS) {
      expect(MODULE_REGISTRY.some((m) => m.key === link.key)).toBe(false)
    }
  })

  it('names an icon the sidebar can actually resolve', () => {
    // iconFor() falls back to LayoutGrid rather than crashing, so a typo here is
    // silent in the browser and only visible as the wrong glyph.
    for (const link of CROSS_MODULE_LINKS) {
      expect(Object.keys(MODULE_ICONS)).toContain(link.icon)
    }
    for (const m of MODULE_REGISTRY) {
      expect(Object.keys(MODULE_ICONS)).toContain(m.icon)
    }
  })
})

describe('visibleCrossModuleLinks', () => {
  it('hides Approvals from someone who cannot decide requests', () => {
    expect(visibleCrossModuleLinks(actor())).toEqual([])
  })

  it('shows it to a manager who holds approve_requests in ANY module', () => {
    // The gate is module-less on purpose: this manager may approve, and the queue
    // itself scopes the ROWS to the modules they can enter.
    const mgr = actor({
      roleKey: 'manager',
      permissions: new Set(['view_records', 'approve_requests']),
      moduleAccess: new Set(['finance']),
    })
    expect(visibleCrossModuleLinks(mgr).map((l) => l.key)).toEqual(['approvals'])
  })

  it('shows nothing to a deactivated user, even one who holds the permission', () => {
    const off = actor({
      permissions: new Set(['view_records', 'approve_requests']), active: false,
    })
    expect(visibleCrossModuleLinks(off)).toEqual([])
  })
})
