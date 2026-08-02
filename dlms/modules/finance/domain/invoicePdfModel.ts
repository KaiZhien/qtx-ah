/**
 * Pure presentation model for the invoice PDF (spec BR-7 / §6.3: invoices are
 * structured records with an official printable document).
 *
 * No I/O, no React, no @react-pdf/renderer import — this file is what the unit
 * tests exercise, and modules/finance/pdf/invoicePdfDocument.ts is a thin
 * renderer over its output.
 *
 * ── THE RULE THIS FILE ENFORCES ────────────────────────────────────────────
 * The PDF's money must equal the invoice detail page's money to the cent. It
 * achieves that by DOING NO ARITHMETIC AT ALL. Every amount arrives as the
 * string a numeric(12,2) column produced (subtotal_sgd/tax_sgd/total_sgd and
 * sales_invoice_line.amount_sgd are all computed in SQL by invoiceService —
 * that is the finance module's standing convention) and is passed through with
 * only lexical grouping applied.
 *
 * Do not introduce Number(), parseFloat(), toFixed(), or Intl.NumberFormat here.
 * Every one of them round-trips through IEEE-754 doubles and can move the last
 * cent — on a document a customer pays against. formatSgd's tests pin this.
 * ───────────────────────────────────────────────────────────────────────────
 */
import type { InvoiceStatus } from '@/modules/finance/domain/invoiceStatus'

const STATUS_LABEL: Record<InvoiceStatus, string> = {
  draft: 'Draft', issued: 'Issued', paid: 'Paid', void: 'Void',
}

/** DRAFT / VOID overprint, or null for a document that stands on its own. */
export type InvoicePdfWatermark = 'DRAFT' | 'VOID' | null

/**
 * A draft invoice is a working document that has not been issued to anyone, and
 * a void one has been withdrawn. Both must be unmistakable on paper — someone
 * WILL forward a PDF without the surrounding UI, and an unmarked draft is
 * indistinguishable from a real demand for payment.
 */
export function watermarkForStatus(status: InvoiceStatus): InvoicePdfWatermark {
  if (status === 'draft') return 'DRAFT'
  if (status === 'void') return 'VOID'
  return null
}

/**
 * 'S$1,234.50' from '1234.50' — purely lexical. Splits on the decimal point and
 * walks the integer digits inserting separators; the fractional part is copied
 * untouched. Nothing is parsed as a number, so precision beyond a double's
 * range survives and no rounding is possible.
 *
 * null/undefined renders 'S$0.00', matching what the invoice detail page shows
 * for a null column (`S${invoice.totalSgd ?? '0.00'}`).
 */
export function formatSgd(amount: string | null | undefined): string {
  if (amount === null || amount === undefined || amount === '') return 'S$0.00'
  const negative = amount.startsWith('-')
  const unsigned = negative ? amount.slice(1) : amount
  const [whole, fraction = '00'] = unsigned.split('.')
  let grouped = ''
  for (let i = 0; i < whole.length; i++) {
    const fromEnd = whole.length - i
    grouped += whole[i]
    if (fromEnd > 1 && fromEnd % 3 === 1) grouped += ','
  }
  return `${negative ? '-' : ''}S$${grouped}.${fraction}`
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
                'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const

/**
 * 'YYYY-MM-DD' -> '01 Jan 2026', by string slicing.
 *
 * Deliberately NOT `new Date(iso).toLocaleDateString()`: that parses the string
 * as UTC midnight and formats it in the host's zone, so an invoice dated
 * 2026-01-01 prints as 31 Dec 2025 anywhere west of Greenwich. On a financial
 * document the date is a legal fact, not a rendering preference.
 */
function formatIsoDate(iso: string | null): string {
  if (!iso) return '—'
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso)
  if (!m) return iso
  const month = MONTHS[Number(m[2]) - 1]
  return month ? `${m[3]} ${month} ${m[1]}` : iso
}

function pad(n: number): string { return String(n).padStart(2, '0') }

/**
 * The generation stamp, always in UTC. A "generated at" that reads differently
 * on the finance clerk's screen and the auditor's is worse than useless, and the
 * platform's servers are UTC anyway.
 */
function formatGeneratedAt(at: Date): string {
  return `${at.getUTCFullYear()}-${pad(at.getUTCMonth() + 1)}-${pad(at.getUTCDate())} `
    + `${pad(at.getUTCHours())}:${pad(at.getUTCMinutes())} UTC`
}

export type InvoicePdfBuyer = {
  name: string
  contactName: string | null
  contactEmail: string | null
  contactPhone: string | null
  billingAddress: string | null
  country: string | null
}

export type InvoicePdfSourceLine = {
  lineNo: number
  description: string
  deviceSn: string | null
  quantity: string
  unitPriceSgd: string
  amountSgd: string
}

/** Exactly what invoicePdfService loads — no derived values, no formatting yet. */
export type InvoicePdfSource = {
  invoiceNo: string
  status: InvoiceStatus
  currency: string
  issueDate: string | null
  dueDate: string | null
  notes: string | null
  subtotalSgd: string | null
  taxSgd: string | null
  totalSgd: string | null
  buyer: InvoicePdfBuyer
  lines: InvoicePdfSourceLine[]
  generatedAt: Date
}

export type InvoicePdfLine = {
  lineNo: number
  description: string
  deviceSn: string | null
  /** Verbatim from numeric(12,2) — '2.00', matching the detail page. */
  quantity: string
  unitPrice: string
  amount: string
}

export type InvoicePdfModel = {
  invoiceNo: string
  status: InvoiceStatus
  statusLabel: string
  watermark: InvoicePdfWatermark
  currency: string
  issueDate: string
  dueDate: string
  /** Address block, blank entries already removed. First entry is the buyer name. */
  buyerLines: string[]
  lines: InvoicePdfLine[]
  subtotal: string
  tax: string
  total: string
  notes: string | null
  generatedAt: string
  /** Content-Disposition-safe. See sanitizeFileName. */
  fileName: string
}

/**
 * invoice_no is `text NOT NULL` and user-entered, so it is untrusted input on
 * the way into a Content-Disposition header and a filesystem name. Everything
 * outside [A-Za-z0-9._-] collapses to a single '-', leading/trailing separators
 * and dots are stripped (so '../../etc/passwd' cannot survive as a traversal),
 * and an invoice number consisting entirely of punctuation falls back to a
 * constant rather than producing '.pdf' or an empty name.
 */
function sanitizeFileName(invoiceNo: string): string {
  const cleaned = invoiceNo
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/\.{2,}/g, '-')
    .replace(/^[-._]+|[-._]+$/g, '')
  return `${cleaned || 'invoice'}.pdf`
}

function buyerAddressLines(buyer: InvoicePdfBuyer): string[] {
  return [
    buyer.name,
    buyer.contactName,
    ...(buyer.billingAddress ? buyer.billingAddress.split('\n') : []),
    buyer.country,
    buyer.contactEmail,
    buyer.contactPhone,
  ]
    .map((l) => (l ?? '').trim())
    .filter((l) => l.length > 0)
}

/** Assembles the render-ready model. Total is the RECORD's total, never a re-sum of the lines. */
export function buildInvoicePdfModel(src: InvoicePdfSource): InvoicePdfModel {
  return {
    invoiceNo: src.invoiceNo,
    status: src.status,
    statusLabel: STATUS_LABEL[src.status],
    watermark: watermarkForStatus(src.status),
    currency: src.currency,
    issueDate: formatIsoDate(src.issueDate),
    dueDate: formatIsoDate(src.dueDate),
    buyerLines: buyerAddressLines(src.buyer),
    lines: src.lines.map((l) => ({
      lineNo: l.lineNo,
      description: l.description,
      deviceSn: l.deviceSn,
      quantity: l.quantity,
      unitPrice: formatSgd(l.unitPriceSgd),
      amount: formatSgd(l.amountSgd),
    })),
    subtotal: formatSgd(src.subtotalSgd),
    tax: formatSgd(src.taxSgd),
    total: formatSgd(src.totalSgd),
    notes: src.notes,
    generatedAt: formatGeneratedAt(src.generatedAt),
    fileName: sanitizeFileName(src.invoiceNo),
  }
}
