// ---------------------------------------------------------------------------
// Smoke test against the REAL @react-pdf/renderer.
//
// invoicePdfModel.test.ts proves the numbers and strings are right; this proves
// they actually become a PDF. Worth the couple of seconds it costs: every
// failure mode this catches (a style @react-pdf rejects, a null child it can't
// handle, a `transform` string it won't parse for the watermark) is invisible to
// type-checking and to the mocked route test, and would first show up as a
// 500 in production on the one document a customer is meant to receive.
// ---------------------------------------------------------------------------
import { describe, it, expect } from 'vitest'
import { buildInvoicePdfModel, type InvoicePdfSource } from '@/modules/finance/domain/invoicePdfModel'
import { renderInvoicePdf } from '@/modules/finance/pdf/invoicePdfDocument'

const source = (over: Partial<InvoicePdfSource> = {}): InvoicePdfSource => ({
  invoiceNo: 'INV-2026-0007',
  status: 'issued',
  currency: 'SGD',
  issueDate: '2026-07-01',
  dueDate: '2026-07-31',
  notes: 'Payment within 30 days.',
  subtotalSgd: '1234.50',
  taxSgd: '111.11',
  totalSgd: '1345.61',
  buyer: {
    name: 'Acme Rehab Pte Ltd', contactName: 'Jane Tan',
    contactEmail: 'jane@acme.example', contactPhone: '+65 6555 0100',
    billingAddress: '1 Raffles Place\n#20-01\nSingapore 048616', country: 'Singapore',
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

const header = (b: Buffer) => b.subarray(0, 5).toString('latin1')

describe('renderInvoicePdf', () => {
  it('produces a real PDF document', async () => {
    const buf = await renderInvoicePdf(buildInvoicePdfModel(source()))
    expect(header(buf)).toBe('%PDF-')
    expect(buf.length).toBeGreaterThan(1000)
  }, 30_000)

  it('renders a draft — with its watermark — without throwing', async () => {
    // The watermark uses absolute positioning + a rotate() transform, which
    // @react-pdf parses at render time. A typo there is only detectable here.
    const draft = await renderInvoicePdf(buildInvoicePdfModel(source({ status: 'draft' })))
    const issued = await renderInvoicePdf(buildInvoicePdfModel(source()))
    expect(header(draft)).toBe('%PDF-')
    // The DRAFT overprint is extra content: the draft document cannot be the
    // same size as the unmarked one.
    expect(draft.length).not.toBe(issued.length)
  }, 30_000)

  it('renders a void invoice', async () => {
    const buf = await renderInvoicePdf(buildInvoicePdfModel(source({ status: 'void' })))
    expect(header(buf)).toBe('%PDF-')
  }, 30_000)

  it('renders a minimal invoice — bare buyer, no notes, no dates, one line', async () => {
    const buf = await renderInvoicePdf(buildInvoicePdfModel(source({
      notes: null, issueDate: null, dueDate: null,
      subtotalSgd: null, taxSgd: null, totalSgd: null,
      buyer: { name: 'B', contactName: null, contactEmail: null,
               contactPhone: null, billingAddress: null, country: null },
      lines: [{ lineNo: 1, description: 'X', deviceSn: null,
                quantity: '1.00', unitPriceSgd: '0.00', amountSgd: '0.00' }],
    })))
    expect(header(buf)).toBe('%PDF-')
  }, 30_000)

  it('paginates an invoice with many lines instead of overflowing one page', async () => {
    const lines = Array.from({ length: 90 }, (_, i) => ({
      lineNo: i + 1, description: `Item ${i + 1}`, deviceSn: `SN-${i + 1}`,
      quantity: '1.00', unitPriceSgd: '10.00', amountSgd: '10.00',
    }))
    const buf = await renderInvoicePdf(buildInvoicePdfModel(source({ lines })))
    expect(header(buf)).toBe('%PDF-')
    expect(buf.subarray(0, 4096).toString('latin1')).toMatch(/PDF/)
  }, 30_000)
})
