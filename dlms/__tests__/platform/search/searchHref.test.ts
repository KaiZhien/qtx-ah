import { describe, it, expect } from 'vitest'
import {
  searchHref, searchResultsPageHref, UNROUTED_GROUPS,
} from '@/modules/shared/search/domain/searchHref'
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

  it('routes modifications to the maintenance route agent MAINTENANCE confirmed', () => {
    expect(searchHref('modifications', 'M1')).toBe('/maintenance/modifications/M1')
  })

  it('returns null for a group with no detail page, rather than guessing', () => {
    // component_unit has no per-unit route; units are shown on the device
    // profile's Components tab.
    expect(searchHref('components', 'C1')).toBeNull()
    // People are administered through the users console, not a per-user page.
    expect(searchHref('users', 'U1')).toBeNull()
  })

  it('lists exactly the unrouted groups, so the gap is inspectable', () => {
    expect([...UNROUTED_GROUPS].sort()).toEqual(['components', 'users'])
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

describe('searchResultsPageHref — the link that stopped /search being an orphan', () => {
  /**
   * `/search` shipped with nothing linking to it: no nav entry, and the palette
   * only ever did `router.push(hit.href)`. It was reachable exclusively by typing
   * the URL, which is close to not having shipped it — while its tests, its
   * permission story and its empty-state copy all went on being maintained.
   */
  it('builds the results URL for a query', () => {
    expect(searchResultsPageHref('QTX-P-00412')).toBe('/search?q=QTX-P-00412')
  })

  it('percent-encodes, so a query can never forge a second parameter', () => {
    // `&` and `=` are the ones that matter: unencoded, "a&q=b" would arrive as
    // two `q` values and the page would take whichever Next handed it.
    expect(searchResultsPageHref('a&q=b')).toBe('/search?q=a%26q%3Db')
    expect(searchResultsPageHref('50% off')).toBe('/search?q=50%25%20off')
    expect(searchResultsPageHref('a/b#c')).toBe('/search?q=a%2Fb%23c')
  })

  it('trims, so a trailing space from the palette input is not carried into the URL', () => {
    expect(searchResultsPageHref('  QTX  ')).toBe('/search?q=QTX')
  })

  it('returns null for a query the page would refuse to run anyway', () => {
    // MIN_QUERY_LENGTH is enforced on both surfaces. Offering a link to a page
    // that can only answer "enter at least 2 characters" is offering a control
    // the destination refuses — the same house rule the approval panels follow.
    expect(searchResultsPageHref('')).toBeNull()
    expect(searchResultsPageHref(' ')).toBeNull()
    expect(searchResultsPageHref('a')).toBeNull()
  })

  it('is absolute, like every other href this module returns', () => {
    expect(searchResultsPageHref('QTX')!.startsWith('/')).toBe(true)
  })
})
