import { describe, it, expect } from 'vitest'
import { DASHBOARD_WIDGETS } from '@/modules/shared/reporting/domain/widgets'
import { SEARCH_GROUPS } from '@/modules/shared/search/domain/searchGroups'
import { searchHref } from '@/modules/shared/search/domain/searchHref'
import { EXPORT_ENTITIES } from '@/modules/shared/export/domain/entities'

/**
 * Pins the facts this branch was TOLD by other agents, so a later change that
 * quietly contradicts one fails here rather than in production.
 */

describe('ENGINEERING contract', () => {
  it('gates the root-cause widget on engineering, not maintenance', () => {
    // The data is failure_investigation ⋈ root_cause_option — both Engineering's
    // tables. Gating on maintenance would hand Engineering records to an actor
    // who cannot open a single one of them.
    const w = DASHBOARD_WIDGETS.find((x) => x.key === 'repairsByRootCause')!
    expect(w.module).toBe('engineering')
    expect(w.permission).toBe('view_records')
  })

  it('registers failure investigations as a search group in engineering', () => {
    const g = SEARCH_GROUPS.find((x) => x.key === 'failures')!
    expect(g).toBeDefined()
    expect(g.module).toBe('engineering')
    expect(g.permission).toBe('view_records')
    // FI-YYYY-NNNN is a reference, so it normalizes like every other ref.
    expect(g.family).toBe('ref')
  })

  it('routes failure investigations to /engineering/failures', () => {
    expect(searchHref('failures', 'F1')).toBe('/engineering/failures/F1')
  })

  it('does NOT claim a root_cause column on repair — there is none', () => {
    const repair = EXPORT_ENTITIES.find((e) => e.table === 'repair')!
    expect(repair.columns).not.toContain('root_cause')
    expect(repair.columns).not.toContain('root_cause_id')
  })
})

describe('FINANCE contract', () => {
  it('gates the warranty widget on view_records, not view_finance', () => {
    // A warranty date is a service entitlement, not money — matching FINANCE's
    // own warrantyService. This looks like a slip beside the invoice widgets and
    // is not one.
    const w = DASHBOARD_WIDGETS.find((x) => x.key === 'warrantiesExpiring')!
    expect(w.permission).toBe('view_records')
    expect(w.module).toBe('finance')
  })

  it('labels the warranty windows as RANGES, because the cut is disjoint', () => {
    // FINANCE returns cumulative windows; this dashboard renders disjoint ones.
    // Labelling them "30 / 60 / 90" would read as three separate piles either way,
    // which is exactly the ambiguity the ranges remove.
    const w = DASHBOARD_WIDGETS.find((x) => x.key === 'warrantiesExpiring')!
    expect(w.label).toMatch(/0-30/)
    expect(w.label).toMatch(/31-60/)
    expect(w.label).toMatch(/61-90/)
  })

  it('keeps the invoice widgets on view_finance', () => {
    for (const k of ['invoicesUnpaid', 'invoicesPendingApproval']) {
      expect(DASHBOARD_WIDGETS.find((x) => x.key === k)!.permission).toBe('view_finance')
    }
  })
})

describe('NOTIFICATIONS contract', () => {
  it('leaves queue health pending on their getQueueHealth, with no duplicate here', () => {
    const w = DASHBOARD_WIDGETS.find((x) => x.key === 'jobQueueHealth')!
    expect(w.status).toBe('pending')
    expect(w.pendingOn).toMatch(/getQueueHealth/)
  })
})

describe('Cross-branch schema changes must not be merged unnoticed', () => {
  it('flags variant_bom_line, whose effectivity columns change what this exports', () => {
    // ENGINEERING drops UNIQUE(variant_id, component_type_id) for a partial index
    // over the open line, so the table starts carrying superseded history. This
    // CSV would silently grow and manifest.json would report the inflated count as
    // if it were intended.
    const bom = EXPORT_ENTITIES.find((e) => e.table === 'variant_bom_line')!
    expect(bom.pendingSchemaChange).toBeTruthy()
    expect(bom.pendingSchemaChange).toMatch(/effective_to_date/)
  })

  it('makes every flagged entity say what to do about it', () => {
    for (const e of EXPORT_ENTITIES.filter((x) => x.pendingSchemaChange)) {
      expect(e.pendingSchemaChange, `${e.table}`).toMatch(/ACTION AT INTEGRATION/)
    }
  })

  it('flags exactly the entities known to be changing, and no others', () => {
    // A stale flag is as bad as a missing one — it trains the reader to ignore them.
    expect(EXPORT_ENTITIES.filter((e) => e.pendingSchemaChange).map((e) => e.table))
      .toEqual(['variant_bom_line'])
  })
})
