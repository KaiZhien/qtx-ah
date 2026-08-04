import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { buildRelationshipsMd } from '@/modules/shared/export/domain/docs'
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

  it('serves warranty expiry live, from their single query', () => {
    const w = DASHBOARD_WIDGETS.find((x) => x.key === 'warrantiesExpiring')!
    expect(w.status).toBe('live')
    expect(w.pendingOn).toBeUndefined()
  })

  it('keeps NO second warranty query in the reporting module', () => {
    // Same rule as the outbox below: the tile and Finance's own landing page read
    // one function, so they cannot disagree. Re-deriving the windows here would
    // also mean re-deriving the cumulative→disjoint conversion, which is the
    // arithmetic most likely to be got wrong twice.
    const src = readFileSync(
      join(__dirname, '../../../modules/shared/reporting/services/dashboardService.ts'),
      'utf8')
    expect(src).toMatch(/getWarrantyExpiryCounts/)
    expect(src).not.toMatch(/FROM warranty/i)
    // The conversion still runs — wiring the source must not quietly render
    // FINANCE's nested counts as though they were three separate piles.
    expect(src).toMatch(/disjointFromCumulative/)
  })
})

describe('NOTIFICATIONS contract', () => {
  it('serves queue health live, from their single definition', () => {
    const w = DASHBOARD_WIDGETS.find((x) => x.key === 'jobQueueHealth')!
    expect(w.status).toBe('live')
    expect(w.pendingOn).toBeUndefined()
  })

  it('keeps NO second outbox query in the reporting module', () => {
    // /api/health and this widget must not be able to disagree, so exactly one
    // place may count the queue — and it is not here. A literal attempt cap would
    // be the same defect in miniature: MAX_ATTEMPTS belongs to the drain.
    const src = readFileSync(
      join(__dirname, '../../../modules/shared/reporting/services/dashboardService.ts'),
      'utf8')
    expect(src).toMatch(/getQueueHealth/)
    expect(src).not.toMatch(/FROM outbox/i)
    expect(src).not.toMatch(/attempts\s*>=/)
  })
})

describe('ENGINEERING BOM effectivity — the change that silently doubles an export', () => {
  const bom = EXPORT_ENTITIES.find((e) => e.table === 'variant_bom_line')!

  it('exports the effectivity columns, so history is READABLE not merely present', () => {
    // UNIQUE(variant_id, component_type_id) is gone, replaced by a partial unique
    // index over the still-open line, so this table now holds superseded revisions
    // too. Exporting those rows WITHOUT the columns that mark them as history is
    // the worst of both worlds: the CSV grows and nothing in it says why.
    for (const c of ['effective_from_date', 'effective_to_date',
      'effective_from_serial', 'effective_to_serial',
      'created_by_eco_id', 'superseded_by_eco_id']) {
      expect(bom.columns, `missing ${c}`).toContain(c)
    }
  })

  it('orders by effectivity so a variant reads as a chronology', () => {
    expect(bom.orderBy).toMatch(/effective_from_date/)
  })

  it('warns in its description that a row count here counts REVISIONS', () => {
    // manifest.json blesses whatever row count it is given, which is exactly what
    // makes an inflated one look deliberate.
    expect(bom.description).toMatch(/effective_to_date IS NULL/)
    expect(bom.description).toMatch(/REVISIONS/i)
  })

  it('documents the filter in relationships.md, where an analyst will look', () => {
    const md = buildRelationshipsMd()
    expect(md).toMatch(/variant_bom_line/)
    expect(md).toMatch(/effective_to_serial IS NULL/)
  })

  it('carries no stale pending-schema flags', () => {
    // A flag left standing after the change landed trains the reader to ignore them.
    expect(EXPORT_ENTITIES.filter((e) => e.pendingSchemaChange).map((e) => e.table))
      .toEqual([])
  })
})
