import { describe, it, expect } from 'vitest'
import {
  approvalRecordHref, approvalAgeLabel,
} from '@/modules/shared/approvals/domain/approvalQueue'
import { APPROVAL_KINDS } from '@/modules/shared/approvals/domain/approvalDecision'

const ID = '3f2a1b4c-0000-4000-8000-000000000001'

describe('approvalRecordHref', () => {
  it('routes every entity type the three registered kinds can attach to', () => {
    expect(approvalRecordHref('sales_invoice', ID)).toBe(`/finance/invoices/${ID}`)
    expect(approvalRecordHref('eco', ID)).toBe(`/engineering/eco/${ID}`)
    expect(approvalRecordHref('repair', ID)).toBe(`/maintenance/repairs/${ID}`)
  })

  it('covers one entity type per approval kind, so no queue row is ever unlinkable', () => {
    // A guard against adding a kind without a route: three kinds, three routes.
    expect(APPROVAL_KINDS).toHaveLength(3)
    for (const entityType of ['sales_invoice', 'eco', 'repair']) {
      expect(approvalRecordHref(entityType, ID)).not.toBeNull()
    }
  })

  it('returns null for an unknown entity type rather than inventing a 404 link', () => {
    expect(approvalRecordHref('widget', ID)).toBeNull()
  })

  it('does not resolve an inherited Object.prototype member', () => {
    // entity_type is stored free text (no CHECK, by design), so "constructor" is a
    // plausible value; a prototype walk would hand back a function as a route.
    expect(approvalRecordHref('constructor', ID)).toBeNull()
    expect(approvalRecordHref('toString', ID)).toBeNull()
  })
})

describe('approvalAgeLabel', () => {
  const at = (iso: string) => new Date(iso)

  it('says "just now" under a minute', () => {
    expect(approvalAgeLabel(at('2026-08-01T10:00:00Z'), at('2026-08-01T10:00:30Z')))
      .toBe('just now')
  })

  it('counts whole minutes, singular and plural', () => {
    expect(approvalAgeLabel(at('2026-08-01T10:00:00Z'), at('2026-08-01T10:01:00Z')))
      .toBe('1 minute')
    expect(approvalAgeLabel(at('2026-08-01T10:00:00Z'), at('2026-08-01T10:45:00Z')))
      .toBe('45 minutes')
  })

  it('counts whole hours, then whole days', () => {
    expect(approvalAgeLabel(at('2026-08-01T10:00:00Z'), at('2026-08-01T11:00:00Z')))
      .toBe('1 hour')
    expect(approvalAgeLabel(at('2026-08-01T10:00:00Z'), at('2026-08-01T23:59:00Z')))
      .toBe('13 hours')
    expect(approvalAgeLabel(at('2026-07-29T10:00:00Z'), at('2026-08-01T10:00:00Z')))
      .toBe('3 days')
    expect(approvalAgeLabel(at('2026-07-31T10:00:00Z'), at('2026-08-01T10:00:00Z')))
      .toBe('1 day')
  })

  it('does not go negative when the clocks disagree', () => {
    // A row stamped by the database a moment ahead of the rendering host must not
    // read "-1 minutes" in an approver's queue.
    expect(approvalAgeLabel(at('2026-08-01T10:05:00Z'), at('2026-08-01T10:00:00Z')))
      .toBe('just now')
  })

  it('is injectable-clock pure — the same pair always gives the same answer', () => {
    const a = approvalAgeLabel(at('2026-08-01T10:00:00Z'), at('2026-08-01T14:00:00Z'))
    const b = approvalAgeLabel(at('2026-08-01T10:00:00Z'), at('2026-08-01T14:00:00Z'))
    expect(a).toBe(b)
    expect(a).toBe('4 hours')
  })
})
