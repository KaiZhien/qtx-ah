import { describe, it, expect } from 'vitest'
import { searchHref, UNROUTED_GROUPS } from '@/modules/shared/search/domain/searchHref'
import { SEARCH_GROUPS } from '@/modules/shared/search/domain/searchGroups'

describe('searchHref — a dead link is worse than no link', () => {
  it('routes each group to the detail route that actually exists', () => {
    expect(searchHref('devices', 'D1')).toBe('/manufacturing/devices/D1')
    expect(searchHref('repairs', 'R1')).toBe('/maintenance/repairs/R1')
    expect(searchHref('invoices', 'I1')).toBe('/finance/invoices/I1')
    expect(searchHref('buyers', 'B1')).toBe('/finance/buyers/B1')
    expect(searchHref('deliveryOrders', 'DO1')).toBe('/logistics/delivery-orders/DO1')
    expect(searchHref('ecrs', 'E1')).toBe('/engineering/ecr/E1')
    expect(searchHref('ecos', 'E2')).toBe('/engineering/eco/E2')
    expect(searchHref('tasks', 'T1')).toBe('/tasks/T1')
  })

  it('uses the HYPHENATED logistics route, not the pluralise-the-entity guess', () => {
    // components/tasks/entityHref.ts's `${module}/${type}s/{id}` convention would
    // produce /logistics/delivery_orders/DO1 — a 404. Same trap approvalRecordHref
    // documents for sales_invoice.
    expect(searchHref('deliveryOrders', 'DO1')).not.toContain('delivery_orders')
  })

  it('uses the SINGULAR engineering routes, which is what ships today', () => {
    expect(searchHref('ecrs', 'E1')).not.toContain('/ecrs/')
    expect(searchHref('ecos', 'E2')).not.toContain('/ecos/')
  })

  it('returns null for a group with no detail page yet, rather than guessing', () => {
    // modification has a service and a domain but no route (PROGRESS MA2:
    // "there is no modification UI page yet"). Guessing would ship a dead link.
    expect(searchHref('modifications', 'M1')).toBeNull()
    // component_unit has no per-unit route either; units are shown on the device
    // profile's Components tab.
    expect(searchHref('components', 'C1')).toBeNull()
    // People are administered through the users console, not a per-user page.
    expect(searchHref('users', 'U1')).toBeNull()
  })

  it('lists exactly the unrouted groups, so the gap is inspectable', () => {
    expect([...UNROUTED_GROUPS].sort())
      .toEqual(['components', 'modifications', 'users'])
  })

  it('gives every declared search group a decision — a route or an explicit null', () => {
    for (const g of SEARCH_GROUPS) {
      const href = searchHref(g.key, 'X')
      const decided = href !== null || UNROUTED_GROUPS.has(g.key)
      expect(decided, `${g.key} has neither a route nor an explicit opt-out`).toBe(true)
    }
  })

  it('never returns a path that is not absolute', () => {
    for (const g of SEARCH_GROUPS) {
      const href = searchHref(g.key, 'X')
      if (href !== null) expect(href.startsWith('/')).toBe(true)
    }
  })
})
