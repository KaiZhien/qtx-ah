// ---------------------------------------------------------------------------
// Pure presentation model for the invoice PDF.
//
// The load-bearing property: the PDF's money must equal the invoice detail
// page's money TO THE CENT. It gets there by never doing arithmetic — the
// numeric(12,2) strings Postgres already produced are carried through verbatim
// and only grouped with thousands separators lexically. Any test below that
// starts failing because someone introduced `Number(...)`/`parseFloat(...)` is
// telling you a rounding bug just entered the finance module.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest'
import {
  formatSgd, watermarkForStatus, buildInvoicePdfModel,
  type InvoicePdfSource,
} from '@/modules/finance/domain/invoicePdfModel'

const source = (over: Partial<InvoicePdfSource> = {}): InvoicePdfSource => ({
  invoiceNo: 'INV-2026-0007',
  status: 'issued',
  currency: 'SGD',
  issueDate: '2026-07-01',
  dueDate: '2026-07-31',
  notes: 'Net 30.',
  subtotalSgd: '1234.50',
  taxSgd: '111.11',
  totalSgd: '1345.61',
  buyer: {
    name: 'Acme Rehab Pte Ltd',
    contactName: 'Jane Tan',
    contactEmail: 'jane@acme.example',
    contactPhone: '+65 6555 0100',
    billingAddress: '1 Raffles Place\n#20-01\nSingapore 048616',
    country: 'Singapore',
  },
  lines: [
    { lineNo: 1, description: 'QTX device', deviceSn: 'EE-02A-2603-0001',
      quantity: '2.00', unitPriceSgd: '500.00', amountSgd: '1000.00' },
    { lineNo: 2, description: 'Spare cuff', deviceSn: null,
      quantity: '1.00', unitPriceSgd: '234.50', amountSgd: '234.50' },
  ],
  generatedAt: new Date('2026-08-03T02:30:00.000Z'),
  ...over,
})

describe('formatSgd', () => {
  it('carries the cents through byte-for-byte', () => {
    expect(formatSgd('0.01')).toBe('S$0.01')
    expect(formatSgd('1234.50')).toBe('S$1,234.50')
    expect(formatSgd('999.99')).toBe('S$999.99')
  })

  it('groups thousands lexically, without float arithmetic', () => {
    expect(formatSgd('1234567.89')).toBe('S$1,234,567.89')
    expect(formatSgd('1000.00')).toBe('S$1,000.00')
    expect(formatSgd('999.00')).toBe('S$999.00')
  })

  it('survives a value that a float round-trip would corrupt', () => {
    // 8.1 * 3 in IEEE-754 is 24.299999999999997; 0.1 + 0.2 is 0.30000000000000004.
    // Postgres numeric(12,2) never produces those, and this path must never
    // reintroduce them by parsing.
    expect(formatSgd('24.30')).toBe('S$24.30')
    expect(formatSgd('0.30')).toBe('S$0.30')
    // A value beyond IEEE-754 integer-exact range, carried verbatim.
    expect(formatSgd('9007199254740993.99')).toBe('S$9,007,199,254,740,993.99')
  })

  it('renders a missing amount as zero rather than blank or NaN', () => {
    // Matches the invoice detail page exactly: `S${invoice.totalSgd ?? '0.00'}`.
    expect(formatSgd(null)).toBe('S$0.00')
    expect(formatSgd(undefined)).toBe('S$0.00')
  })

  it('keeps a negative amount signed and grouped', () => {
    expect(formatSgd('-1234.50')).toBe('-S$1,234.50')
  })
})

describe('watermarkForStatus', () => {
  it('watermarks an unissued invoice DRAFT', () => {
    // An un-issued invoice must never be mistakable for a real one.
    expect(watermarkForStatus('draft')).toBe('DRAFT')
  })

  it('watermarks a cancelled invoice VOID', () => {
    expect(watermarkForStatus('void')).toBe('VOID')
  })

  it('leaves a real, live invoice unmarked', () => {
    expect(watermarkForStatus('issued')).toBeNull()
    expect(watermarkForStatus('paid')).toBeNull()
  })
})

describe('buildInvoicePdfModel', () => {
  it('carries every money field straight from the source', () => {
    const m = buildInvoicePdfModel(source())
    expect(m.subtotal).toBe('S$1,234.50')
    expect(m.tax).toBe('S$111.11')
    expect(m.total).toBe('S$1,345.61')
    expect(m.lines.map((l) => l.amount)).toEqual(['S$1,000.00', 'S$234.50'])
    expect(m.lines.map((l) => l.unitPrice)).toEqual(['S$500.00', 'S$234.50'])
  })

  it('never recomputes the total from the lines', () => {
    // Given a deliberately inconsistent source, the PDF must show what the
    // record says — the same numbers the detail page shows — not a "corrected"
    // sum. If this ever fails, the PDF has started disagreeing with the app.
    const m = buildInvoicePdfModel(source({ totalSgd: '5.00', subtotalSgd: '4.00' }))
    expect(m.total).toBe('S$5.00')
    expect(m.subtotal).toBe('S$4.00')
  })

  it('shows quantity verbatim, matching the detail page', () => {
    expect(buildInvoicePdfModel(source()).lines[0].quantity).toBe('2.00')
  })

  it('carries the status through as a label plus the watermark decision', () => {
    expect(buildInvoicePdfModel(source({ status: 'draft' })).watermark).toBe('DRAFT')
    expect(buildInvoicePdfModel(source({ status: 'void' })).watermark).toBe('VOID')
    const issued = buildInvoicePdfModel(source())
    expect(issued.watermark).toBeNull()
    expect(issued.statusLabel).toBe('Issued')
  })

  it('renders the buyer block as non-empty address lines only', () => {
    const m = buildInvoicePdfModel(source())
    expect(m.buyerLines).toEqual([
      'Acme Rehab Pte Ltd', 'Jane Tan', '1 Raffles Place', '#20-01',
      'Singapore 048616', 'Singapore', 'jane@acme.example', '+65 6555 0100',
    ])
  })

  it('omits missing buyer fields instead of printing blank lines or "null"', () => {
    const m = buildInvoicePdfModel(source({
      buyer: {
        name: 'Bare Buyer', contactName: null, contactEmail: null,
        contactPhone: null, billingAddress: null, country: null,
      },
    }))
    expect(m.buyerLines).toEqual(['Bare Buyer'])
  })

  it('drops blank lines inside a multi-line billing address', () => {
    const m = buildInvoicePdfModel(source({
      buyer: {
        name: 'B', contactName: null, contactEmail: null, contactPhone: null,
        billingAddress: 'Line 1\n\n   \nLine 2', country: null,
      },
    }))
    expect(m.buyerLines).toEqual(['B', 'Line 1', 'Line 2'])
  })

  it('renders absent dates as an em dash, never as "null"', () => {
    const m = buildInvoicePdfModel(source({ issueDate: null, dueDate: null }))
    expect(m.issueDate).toBe('—')
    expect(m.dueDate).toBe('—')
  })

  it('formats dates without a timezone round-trip', () => {
    // Source dates are 'YYYY-MM-DD' strings straight from Postgres. Turning them
    // into a Date and back is how an invoice ends up dated one day early on a
    // UTC-negative host.
    const m = buildInvoicePdfModel(source({ issueDate: '2026-01-01', dueDate: '2026-12-31' }))
    expect(m.issueDate).toBe('01 Jan 2026')
    expect(m.dueDate).toBe('31 Dec 2026')
  })

  it('stamps the generation time in UTC so two readers agree on it', () => {
    expect(buildInvoicePdfModel(source()).generatedAt).toBe('2026-08-03 02:30 UTC')
  })

  it('handles an invoice with no notes', () => {
    expect(buildInvoicePdfModel(source({ notes: null })).notes).toBeNull()
  })

  it('names the download file after the invoice, safely', () => {
    expect(buildInvoicePdfModel(source()).fileName).toBe('INV-2026-0007.pdf')
    // Invoice numbers are free text (invoiceNo is `text NOT NULL`, user-entered),
    // so anything that could break out of a Content-Disposition filename or a
    // path is replaced rather than trusted.
    expect(buildInvoicePdfModel(source({ invoiceNo: 'A/B"C\\D 1' })).fileName)
      .toBe('A-B-C-D-1.pdf')
    expect(buildInvoicePdfModel(source({ invoiceNo: '../../etc/passwd' })).fileName)
      .toBe('etc-passwd.pdf')
    expect(buildInvoicePdfModel(source({ invoiceNo: '   ' })).fileName).toBe('invoice.pdf')
  })
})
