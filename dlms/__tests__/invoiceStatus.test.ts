// __tests__/invoiceStatus.test.ts
import { describe, it, expect } from 'vitest'
import {
  evaluateInvoiceStatusChange, allowedInvoiceTransitions,
  InvalidInvoiceStatusChangeError, messageForInvoiceStatusChangeError,
  INVOICE_STATUSES, type InvoiceStatus,
} from '@/modules/finance/domain/invoiceStatus'

describe('evaluateInvoiceStatusChange', () => {
  it('allows draft -> issued', () => {
    expect(evaluateInvoiceStatusChange('draft', 'issued')).toEqual({ ok: true })
  })
  it('allows issued -> paid', () => {
    expect(evaluateInvoiceStatusChange('issued', 'paid')).toEqual({ ok: true })
  })
  it('allows draft -> void', () => {
    expect(evaluateInvoiceStatusChange('draft', 'void')).toEqual({ ok: true })
  })
  it('allows issued -> void', () => {
    expect(evaluateInvoiceStatusChange('issued', 'void')).toEqual({ ok: true })
  })

  it('rejects draft -> paid (must be issued first)', () => {
    expect(evaluateInvoiceStatusChange('draft', 'paid')).toEqual({ ok: false, error: 'transition_forbidden' })
  })
  it('rejects paid -> anything (terminal)', () => {
    for (const to of INVOICE_STATUSES) {
      if (to === 'paid') continue
      expect(evaluateInvoiceStatusChange('paid', to)).toEqual({ ok: false, error: 'transition_forbidden' })
    }
  })
  it('rejects void -> anything (terminal)', () => {
    for (const to of INVOICE_STATUSES) {
      if (to === 'void') continue
      expect(evaluateInvoiceStatusChange('void', to)).toEqual({ ok: false, error: 'transition_forbidden' })
    }
  })
  it('rejects a same-status no-op move', () => {
    expect(evaluateInvoiceStatusChange('draft', 'draft')).toEqual({ ok: false, error: 'transition_forbidden' })
    expect(evaluateInvoiceStatusChange('issued', 'issued')).toEqual({ ok: false, error: 'transition_forbidden' })
  })
  it('rejects issued -> draft (no backward moves)', () => {
    expect(evaluateInvoiceStatusChange('issued', 'draft')).toEqual({ ok: false, error: 'transition_forbidden' })
  })
})

describe('allowedInvoiceTransitions', () => {
  it('lists the two edges out of draft', () => {
    expect(allowedInvoiceTransitions('draft')).toEqual(['issued', 'void'])
  })
  it('lists the two edges out of issued', () => {
    expect(allowedInvoiceTransitions('issued')).toEqual(['paid', 'void'])
  })
  it('is empty for the terminal statuses', () => {
    expect(allowedInvoiceTransitions('paid')).toEqual([])
    expect(allowedInvoiceTransitions('void')).toEqual([])
  })
})

describe('messageForInvoiceStatusChangeError', () => {
  it('names both statuses', () => {
    expect(messageForInvoiceStatusChangeError('transition_forbidden', 'paid', 'draft'))
      .toBe('Cannot move an invoice from "paid" to "draft".')
  })
})

describe('InvalidInvoiceStatusChangeError', () => {
  it('carries the code', () => {
    const e = new InvalidInvoiceStatusChangeError('transition_forbidden', 'nope')
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('transition_forbidden')
    expect(e.name).toBe('InvalidInvoiceStatusChangeError')
  })
})

describe('INVOICE_STATUSES', () => {
  it('is the exhaustive 4-state set matching the DB CHECK constraint', () => {
    expect(INVOICE_STATUSES).toEqual(['draft', 'issued', 'paid', 'void'])
  })
  it('type-checks as InvoiceStatus', () => {
    const s: InvoiceStatus = INVOICE_STATUSES[0]
    expect(s).toBe('draft')
  })
})
