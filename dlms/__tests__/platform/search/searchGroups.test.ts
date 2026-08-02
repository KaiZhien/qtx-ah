import { describe, it, expect } from 'vitest'
import {
  SEARCH_GROUPS, visibleSearchGroups, searchGroupKeys, type SearchGroupKey,
} from '@/modules/shared/search/domain/searchGroups'
import { MODULES } from '@/modules/shared/authz/catalog'
import type { Actor, ModuleKey, Permission } from '@/modules/shared/authz/catalog'

const actor = (over: Partial<Actor> = {}): Actor => ({
  id: 'u1', roleKey: 'operator',
  permissions: new Set<Permission>(['view_records']),
  moduleAccess: new Set<ModuleKey>(['manufacturing', 'tasks']),
  active: true,
  ...over,
})

const keysFor = (a: Actor) => visibleSearchGroups(a).map((g) => g.key)

describe('SEARCH_GROUPS registry', () => {
  it('declares every group key exactly once', () => {
    const keys = SEARCH_GROUPS.map((g) => g.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('covers every group spec §8.4 names', () => {
    // device SNs, component SNs, buyer names, invoice/DO numbers,
    // repair/mod/ECR refs, task titles, user names (admin).
    const keys = searchGroupKeys()
    for (const expected of [
      'devices', 'components', 'buyers', 'invoices', 'deliveryOrders',
      'repairs', 'modifications', 'ecrs', 'ecos', 'tasks', 'users',
    ] satisfies SearchGroupKey[]) {
      expect(keys).toContain(expected)
    }
  })

  it('gives every group a module that authorize() recognises', () => {
    for (const g of SEARCH_GROUPS) {
      expect(MODULES).toContain(g.module)
    }
  })

  it('gives every group a stable sort position', () => {
    const sorts = SEARCH_GROUPS.map((g) => g.sort)
    expect(new Set(sorts).size).toBe(sorts.length)
  })
})

describe('visibleSearchGroups — permission filtering is the security property', () => {
  it('gives an operator the modules they hold, and nothing else', () => {
    const keys = keysFor(actor())
    expect(keys).toContain('devices')
    expect(keys).toContain('components')
    expect(keys).toContain('tasks')
    expect(keys).not.toContain('invoices')
    expect(keys).not.toContain('repairs')
  })

  it('OMITS the finance groups entirely for an actor without Finance access', () => {
    // Not "returns them empty" — a user who cannot see Finance must not learn
    // that an invoice number exists, and an empty-but-present group discloses
    // that the group is a thing they are being denied.
    const keys = keysFor(actor())
    expect(keys).not.toContain('invoices')
    expect(keys).not.toContain('buyers')
  })

  it('requires view_finance, not merely finance module access, for invoices', () => {
    // Mirrors invoiceService/buyerService: authorize(actor, 'view_finance', 'finance').
    const moduleOnly = actor({ moduleAccess: new Set<ModuleKey>(['finance']) })
    expect(keysFor(moduleOnly)).not.toContain('invoices')

    const proper = actor({
      permissions: new Set<Permission>(['view_records', 'view_finance']),
      moduleAccess: new Set<ModuleKey>(['finance']),
    })
    expect(keysFor(proper)).toContain('invoices')
  })

  it('gates the users group on manage_users in admin, per spec §8.4 "(admin)"', () => {
    const admin = actor({
      roleKey: 'admin',
      permissions: new Set<Permission>(['view_records', 'manage_users']),
      moduleAccess: new Set<ModuleKey>(['admin']),
    })
    expect(keysFor(admin)).toContain('users')
    expect(keysFor(actor())).not.toContain('users')
  })

  it('gives a deactivated actor NO groups at all, whatever their role', () => {
    const dead = actor({ roleKey: 'super_admin', active: false })
    expect(keysFor(dead)).toEqual([])
  })

  it('gives a super_admin every group (module gate bypassed, permissions held)', () => {
    const su = actor({
      roleKey: 'super_admin',
      permissions: new Set<Permission>([
        'view_records', 'view_finance', 'manage_users',
      ]),
      moduleAccess: new Set<ModuleKey>([]),
    })
    expect(keysFor(su).sort()).toEqual(searchGroupKeys().slice().sort())
  })

  it('does NOT give a super_admin whose grants were edited away the finance groups', () => {
    // policy.can(): super_admin bypasses the MODULE gate only, never the permission set.
    const su = actor({
      roleKey: 'super_admin',
      permissions: new Set<Permission>(['view_records']),
      moduleAccess: new Set<ModuleKey>([]),
    })
    expect(keysFor(su)).not.toContain('invoices')
    expect(keysFor(su)).not.toContain('buyers')
  })

  it('returns groups in registry sort order', () => {
    const su = actor({
      roleKey: 'super_admin',
      permissions: new Set<Permission>(['view_records', 'view_finance', 'manage_users']),
      moduleAccess: new Set<ModuleKey>([]),
    })
    const sorts = visibleSearchGroups(su).map((g) => g.sort)
    expect(sorts).toEqual([...sorts].sort((a, b) => a - b))
  })
})
