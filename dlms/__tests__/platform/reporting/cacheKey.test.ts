import { describe, it, expect } from 'vitest'
import {
  dashboardCacheKey, actorScopeDigest, DASHBOARD_REVALIDATE_SECONDS,
} from '@/modules/shared/reporting/domain/cacheKey'
import type { Actor, ModuleKey, Permission } from '@/modules/shared/authz/catalog'

const actor = (over: Partial<Actor> = {}): Actor => ({
  id: 'user-aaa', roleKey: 'operator',
  permissions: new Set<Permission>(['view_records']),
  moduleAccess: new Set<ModuleKey>(['manufacturing', 'tasks']),
  active: true,
  ...over,
})

describe('DASHBOARD_REVALIDATE_SECONDS', () => {
  it('is the spec §8.5 60-second server cache', () => {
    expect(DASHBOARD_REVALIDATE_SECONDS).toBe(60)
  })
})

describe('dashboardCacheKey — a cached dashboard must never leak another user rows', () => {
  it('includes the widget key, so two widgets never share a cache entry', () => {
    const a = dashboardCacheKey(actor(), 'myTasks')
    const b = dashboardCacheKey(actor(), 'devicesByStatus')
    expect(a).not.toEqual(b)
  })

  it('DIFFERS between two actors who differ only by id', () => {
    // "my tasks" / "recent activity on my records" are per-user by definition.
    const a = dashboardCacheKey(actor({ id: 'user-aaa' }), 'myTasks')
    const b = dashboardCacheKey(actor({ id: 'user-bbb' }), 'myTasks')
    expect(a).not.toEqual(b)
  })

  it('DIFFERS when a single permission is added', () => {
    const before = dashboardCacheKey(actor(), 'invoicesUnpaid')
    const after = dashboardCacheKey(
      actor({ permissions: new Set<Permission>(['view_records', 'view_finance']) }),
      'invoicesUnpaid',
    )
    expect(before).not.toEqual(after)
  })

  it('DIFFERS when a single permission is removed', () => {
    const before = dashboardCacheKey(
      actor({ permissions: new Set<Permission>(['view_records', 'view_finance']) }),
      'invoicesUnpaid',
    )
    const after = dashboardCacheKey(actor(), 'invoicesUnpaid')
    expect(before).not.toEqual(after)
  })

  it('DIFFERS when module access changes', () => {
    const before = dashboardCacheKey(actor(), 'devicesByStatus')
    const after = dashboardCacheKey(
      actor({ moduleAccess: new Set<ModuleKey>(['manufacturing', 'tasks', 'finance']) }),
      'devicesByStatus',
    )
    expect(before).not.toEqual(after)
  })

  it('DIFFERS when the role changes, even at identical permissions', () => {
    // super_admin bypasses the module gate in can(), so the role itself changes
    // what a query is allowed to return.
    const before = dashboardCacheKey(actor({ roleKey: 'operator' }), 'devicesByStatus')
    const after = dashboardCacheKey(actor({ roleKey: 'super_admin' }), 'devicesByStatus')
    expect(before).not.toEqual(after)
  })

  it('DIFFERS when the actor is deactivated', () => {
    const before = dashboardCacheKey(actor({ active: true }), 'myTasks')
    const after = dashboardCacheKey(actor({ active: false }), 'myTasks')
    expect(before).not.toEqual(after)
  })

  it('is STABLE for the same actor across calls, or the cache never hits', () => {
    expect(dashboardCacheKey(actor(), 'myTasks')).toEqual(dashboardCacheKey(actor(), 'myTasks'))
  })

  it('is insensitive to Set insertion order — the same grants are the same scope', () => {
    const forward = actor({
      permissions: new Set<Permission>(['view_records', 'view_finance', 'export_data']),
      moduleAccess: new Set<ModuleKey>(['finance', 'manufacturing']),
    })
    const backward = actor({
      permissions: new Set<Permission>(['export_data', 'view_finance', 'view_records']),
      moduleAccess: new Set<ModuleKey>(['manufacturing', 'finance']),
    })
    expect(dashboardCacheKey(forward, 'x')).toEqual(dashboardCacheKey(backward, 'x'))
  })

  it('carries the actor id verbatim so a cache entry is attributable in an audit', () => {
    expect(dashboardCacheKey(actor({ id: 'user-aaa' }), 'myTasks')).toContain('user-aaa')
  })

  it('never lets one actor id prefix-collide with another', () => {
    // Key parts are an ARRAY, not a concatenated string: 'ab'+'c' vs 'a'+'bc'.
    const a = dashboardCacheKey(actor({ id: 'ab' }), 'c')
    const b = dashboardCacheKey(actor({ id: 'a' }), 'bc')
    expect(a).not.toEqual(b)
  })
})

describe('actorScopeDigest', () => {
  it('is a hex digest, not the raw permission list', () => {
    // Cache keys land in filenames/Redis keys; an unbounded raw list would be
    // both huge and a disclosure in any log that prints the key.
    expect(actorScopeDigest(actor())).toMatch(/^[0-9a-f]{16,64}$/)
  })

  it('separates fields so a permission cannot masquerade as a module', () => {
    const asPermission = actor({
      permissions: new Set<Permission>(['view_records', 'view_finance']),
      moduleAccess: new Set<ModuleKey>([]),
    })
    const asModule = actor({
      permissions: new Set<Permission>(['view_records']),
      moduleAccess: new Set<ModuleKey>(['finance']),
    })
    expect(actorScopeDigest(asPermission)).not.toBe(actorScopeDigest(asModule))
  })
})
