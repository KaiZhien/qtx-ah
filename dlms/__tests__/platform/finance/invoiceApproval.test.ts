import { describe, it, expect } from 'vitest'
import {
  INVOICE_APPROVAL_ENTITY_TYPE, INVOICE_APPROVAL_KIND,
  buildInvoiceApprovalSnapshot, evaluateInvoiceIssue,
  InvoiceApprovalError, messageForInvoiceApprovalError,
} from '@/modules/finance/domain/invoiceApproval'

const facts = (over: Record<string, unknown> = {}) => ({
  invoiceNo: 'INV-001',
  buyerId: '11111111-1111-1111-1111-111111111111',
  buyerName: 'ACME Pte Ltd',
  currency: 'SGD',
  totalSgd: '12000.00',
  ...over,
})

const gate = (over: Record<string, unknown> = {}) => ({
  requiresApproval: true,
  thresholdSgd: '5000',
  current: buildInvoiceApprovalSnapshot(facts()),
  approval: null as null | { status: string; snapshot: unknown; decisionNote: string | null },
  ...over,
}) as Parameters<typeof evaluateInvoiceIssue>[0]

const approved = (snapshot: unknown, note: string | null = null) =>
  ({ status: 'approved' as const, snapshot, decisionNote: note })

describe('the approval target', () => {
  it('names the entity type and kind the shared engine registered for invoices', () => {
    expect(INVOICE_APPROVAL_ENTITY_TYPE).toBe('sales_invoice')
    expect(INVOICE_APPROVAL_KIND).toBe('invoice')
  })
})

describe('buildInvoiceApprovalSnapshot', () => {
  it('captures what an approver signs off on — the amount, its currency, and the buyer', () => {
    expect(buildInvoiceApprovalSnapshot(facts())).toEqual({
      invoiceNo: 'INV-001',
      buyerId: '11111111-1111-1111-1111-111111111111',
      buyerName: 'ACME Pte Ltd',
      currency: 'SGD',
      totalSgd: '12000.00',
    })
  })

  it('is never a bare id — a snapshot of only the id authorises nothing', () => {
    const snapshot = buildInvoiceApprovalSnapshot(facts())
    expect(Object.keys(snapshot).sort()).toEqual(
      ['buyerId', 'buyerName', 'currency', 'invoiceNo', 'totalSgd'])
    // The invoice's own id is deliberately ABSENT: it is already the approval's
    // entity_id, and a value that cannot change is not evidence of anything.
    expect(snapshot).not.toHaveProperty('id')
    expect(snapshot).not.toHaveProperty('invoiceId')
  })

  it('keeps the total as the driver returned it, digit for digit', () => {
    // numeric(12,2) arrives from node-postgres as a STRING. Storing Number(...)
    // here would silently round a value numeric holds exactly.
    expect(buildInvoiceApprovalSnapshot(facts({ totalSgd: '12000.000000000000000001' })).totalSgd)
      .toBe('12000.000000000000000001')
  })
})

describe('evaluateInvoiceIssue', () => {
  it('lets a below-threshold invoice through with no approval at all', () => {
    expect(evaluateInvoiceIssue(gate({ requiresApproval: false, approval: null })))
      .toEqual({ ok: true })
  })

  it('refuses when the invoice needs approval and none was ever requested', () => {
    const res = evaluateInvoiceIssue(gate())
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.code).toBe('approval_missing')
    expect(res.message).toContain('5000')
  })

  it('refuses while a request is still pending, and says so', () => {
    const res = evaluateInvoiceIssue(gate({
      approval: { status: 'pending', snapshot: gate().current, decisionNote: null },
    }))
    expect(res).toMatchObject({ ok: false, code: 'approval_pending' })
  })

  it('refuses on a rejection and repeats the note the approver left', () => {
    const res = evaluateInvoiceIssue(gate({
      approval: { status: 'rejected', snapshot: gate().current, decisionNote: 'Discount not agreed' },
    }))
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.code).toBe('approval_rejected')
    expect(res.message).toContain('Discount not agreed')
  })

  it('lets an approved, unchanged invoice through', () => {
    const current = buildInvoiceApprovalSnapshot(facts())
    expect(evaluateInvoiceIssue(gate({ current, approval: approved({ ...current }) })))
      .toEqual({ ok: true })
  })

  it('agrees when jsonb hands the snapshot back with its keys re-ordered', () => {
    const current = buildInvoiceApprovalSnapshot(facts())
    const reordered = {
      totalSgd: current.totalSgd, currency: current.currency, buyerName: current.buyerName,
      buyerId: current.buyerId, invoiceNo: current.invoiceNo,
    }
    expect(evaluateInvoiceIssue(gate({ current, approval: approved(reordered) })))
      .toEqual({ ok: true })
  })

  it('refuses when the total moved after approval, and NAMES the total in the message', () => {
    const current = buildInvoiceApprovalSnapshot(facts({ totalSgd: '18500.00' }))
    const res = evaluateInvoiceIssue(gate({
      current,
      approval: approved(buildInvoiceApprovalSnapshot(facts({ totalSgd: '12000.00' }))),
    }))
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.code).toBe('approval_drifted')
    expect(res.message).toContain('totalSgd')
    expect(res.message).toContain('12000.00')
    expect(res.message).toContain('18500.00')
  })

  it('refuses when the buyer was swapped, naming the buyer rather than the total', () => {
    const current = buildInvoiceApprovalSnapshot(
      facts({ buyerId: '22222222-2222-2222-2222-222222222222', buyerName: 'Globex' }))
    const res = evaluateInvoiceIssue(gate({
      current, approval: approved(buildInvoiceApprovalSnapshot(facts())),
    }))
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.code).toBe('approval_drifted')
    expect(res.message).toContain('buyerId')
    expect(res.message).toContain('buyerName')
    expect(res.message).not.toContain('totalSgd')
  })

  it('treats a snapshot missing a field as drift — a vanished field is material too', () => {
    const current = buildInvoiceApprovalSnapshot(facts())
    const { totalSgd, ...withoutTotal } = current
    const res = evaluateInvoiceIssue(gate({ current, approval: approved(withoutTotal) }))
    expect(res).toMatchObject({ ok: false, code: 'approval_drifted' })
    expect(totalSgd).toBe('12000.00')
  })

  it('refuses a degenerate `{}` snapshot instead of waving it through', () => {
    // The CHECK makes this unreachable through the service; asserted here because
    // an empty object is exactly the value that would make the re-check vacuous.
    const res = evaluateInvoiceIssue(gate({ approval: approved({}) }))
    expect(res).toMatchObject({ ok: false, code: 'approval_drifted' })
  })

  it('does not check the snapshot at all below the threshold', () => {
    // Drifted beyond recognition, but the gate does not apply.
    expect(evaluateInvoiceIssue(gate({
      requiresApproval: false, approval: approved({ totalSgd: '1' }),
    }))).toEqual({ ok: true })
  })
})

describe('InvoiceApprovalError', () => {
  it('carries its code alongside the sentence', () => {
    const err = new InvoiceApprovalError('below_threshold', 'nope')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('InvoiceApprovalError')
    expect(err.code).toBe('below_threshold')
    expect(err.message).toBe('nope')
  })

  it('has a sentence for every code it can carry', () => {
    for (const code of ['below_threshold', 'not_draft'] as const) {
      expect(messageForInvoiceApprovalError(code, '5000')).toMatch(/\S/)
    }
    expect(messageForInvoiceApprovalError('below_threshold', '5000')).toContain('5000')
  })
})
