/**
 * Renders the invoice PDF (spec BR-7). A thin renderer over the pure model in
 * modules/finance/domain/invoicePdfModel.ts — it contains NO money logic and NO
 * data access. Everything it prints was already decided and formatted there,
 * which is what makes the money on this document identical to the money on the
 * invoice detail page.
 *
 * Uses React.createElement rather than JSX for the same reason lib/export/pdf.tsx
 * does: a .tsx file here fights Next's webpack bundler over the
 * @jsxImportSource pragma @react-pdf/renderer wants. Plain createElement in a
 * .ts file sidesteps it entirely and keeps the route handler buildable.
 *
 * NOT STORED ANYWHERE. This is generated on demand and streamed. See
 * modules/finance/services/invoicePdfService.ts for why (spec §10's `file` table
 * is on S3 presigned uploads and AWS is deferred).
 */
import React from 'react'
import { renderToBuffer, Document, Page, Text, View, StyleSheet } from '@react-pdf/renderer'
import type { InvoicePdfModel } from '@/modules/finance/domain/invoicePdfModel'
import { QTX_LETTERHEAD, letterheadLines } from '@/modules/finance/pdf/letterhead'

const ce = React.createElement

const styles = StyleSheet.create({
  page: { paddingTop: 40, paddingBottom: 56, paddingHorizontal: 40, fontFamily: 'Helvetica', fontSize: 9.5, color: '#1a1a1a' },

  // Letterhead
  letterhead: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 24 },
  companyName: { fontSize: 15, fontFamily: 'Helvetica-Bold', marginBottom: 4 },
  companyLine: { fontSize: 8.5, color: '#555', lineHeight: 1.4 },
  docTitle: { fontSize: 20, fontFamily: 'Helvetica-Bold', textAlign: 'right', letterSpacing: 1 },
  docNo: { fontSize: 11, textAlign: 'right', marginTop: 4 },
  statusLine: { fontSize: 8.5, textAlign: 'right', marginTop: 4, color: '#555' },

  rule: { borderBottomWidth: 1, borderBottomColor: '#1a1a1a', marginBottom: 16 },

  // Bill-to / meta
  metaRow: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 22 },
  metaCol: { width: '48%' },
  label: { fontSize: 7.5, color: '#777', textTransform: 'uppercase', letterSpacing: 0.6, marginBottom: 4 },
  buyerName: { fontSize: 10.5, fontFamily: 'Helvetica-Bold', marginBottom: 2 },
  addressLine: { fontSize: 9, color: '#333', lineHeight: 1.45 },
  metaPair: { flexDirection: 'row', justifyContent: 'space-between', marginBottom: 3 },
  metaKey: { fontSize: 9, color: '#666' },
  metaVal: { fontSize: 9 },

  // Line-item table
  tHead: { flexDirection: 'row', backgroundColor: '#f2f2f2', paddingVertical: 5, paddingHorizontal: 4 },
  tRow: { flexDirection: 'row', borderBottomWidth: 0.5, borderBottomColor: '#dcdcdc', paddingVertical: 6, paddingHorizontal: 4 },
  th: { fontSize: 8, fontFamily: 'Helvetica-Bold', color: '#333' },
  cNo: { width: '6%' },
  cDesc: { width: '42%' },
  cQty: { width: '12%', textAlign: 'right' },
  cUnit: { width: '20%', textAlign: 'right' },
  cAmt: { width: '20%', textAlign: 'right' },
  cell: { fontSize: 9 },
  deviceSn: { fontSize: 7.5, color: '#777', marginTop: 2 },

  // Totals
  totalsWrap: { flexDirection: 'row', justifyContent: 'flex-end', marginTop: 14 },
  totals: { width: '45%' },
  totalRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 3 },
  grandRow: {
    flexDirection: 'row', justifyContent: 'space-between', paddingTop: 6, marginTop: 4,
    borderTopWidth: 1, borderTopColor: '#1a1a1a',
  },
  grandText: { fontSize: 11, fontFamily: 'Helvetica-Bold' },

  notesBox: { marginTop: 26 },
  notesText: { fontSize: 8.5, color: '#333', lineHeight: 1.5 },

  footer: {
    position: 'absolute', bottom: 26, left: 40, right: 40,
    fontSize: 7.5, color: '#888', textAlign: 'center',
  },

  // Watermark — absolutely positioned, rotated, drawn over the content.
  watermark: {
    position: 'absolute', top: 300, left: 0, right: 0,
    textAlign: 'center', fontSize: 96, fontFamily: 'Helvetica-Bold',
    color: '#d0d0d0', opacity: 0.42, transform: 'rotate(-32deg)', letterSpacing: 8,
  },
})

function metaPair(key: string, value: string, i: number) {
  return ce(View, { key: `m${i}`, style: styles.metaPair },
    ce(Text, { style: styles.metaKey }, key),
    ce(Text, { style: styles.metaVal }, value))
}

/**
 * The watermark is rendered LAST in the page's child list so it paints over the
 * line items rather than under them — a DRAFT mark hidden behind an opaque table
 * row defeats the entire point of having one.
 */
function watermark(text: string) {
  return ce(Text, { key: 'wm', style: styles.watermark, fixed: true }, text)
}

export function buildInvoiceDocument(model: InvoicePdfModel) {
  const [buyerName, ...buyerRest] = model.buyerLines
  const company = letterheadLines()

  return ce(Document, {
    title: `Invoice ${model.invoiceNo}`,
    author: QTX_LETTERHEAD.name,
    subject: `Sales invoice ${model.invoiceNo}`,
    creator: 'QTX Operations Platform',
    producer: 'QTX Operations Platform',
  },
    ce(Page, { size: 'A4', style: styles.page },

      // ── Letterhead ────────────────────────────────────────────────────
      ce(View, { style: styles.letterhead },
        ce(View, { style: { width: '55%' } },
          ce(Text, { style: styles.companyName }, QTX_LETTERHEAD.name),
          ...company.map((l, i) => ce(Text, { key: `c${i}`, style: styles.companyLine }, l)),
        ),
        ce(View, { style: { width: '42%' } },
          // "TAX INVOICE" only when there is a GST registration number to back
          // it. In Singapore a tax invoice must carry the supplier's GST
          // registration number; a document headed TAX INVOICE without one
          // misrepresents its own status and cannot be used by the buyer to
          // claim input tax. QTX_LETTERHEAD.gstRegNo is null until someone fills
          // it in (see letterhead.ts), so this reads INVOICE until then.
          ce(Text, { style: styles.docTitle },
             QTX_LETTERHEAD.gstRegNo ? 'TAX INVOICE' : 'INVOICE'),
          ce(Text, { style: styles.docNo }, model.invoiceNo),
          ce(Text, { style: styles.statusLine }, `Status: ${model.statusLabel}`),
        ),
      ),
      ce(View, { style: styles.rule }),

      // ── Bill to / invoice meta ────────────────────────────────────────
      ce(View, { style: styles.metaRow },
        ce(View, { style: styles.metaCol },
          ce(Text, { style: styles.label }, 'Bill to'),
          ce(Text, { style: styles.buyerName }, buyerName ?? '—'),
          ...buyerRest.map((l, i) => ce(Text, { key: `b${i}`, style: styles.addressLine }, l)),
        ),
        ce(View, { style: styles.metaCol },
          ce(Text, { style: styles.label }, 'Invoice details'),
          metaPair('Invoice no.', model.invoiceNo, 0),
          metaPair('Issue date', model.issueDate, 1),
          metaPair('Due date', model.dueDate, 2),
          metaPair('Currency', model.currency, 3),
          metaPair('Status', model.statusLabel, 4),
        ),
      ),

      // ── Line items ────────────────────────────────────────────────────
      ce(View, { style: styles.tHead },
        ce(Text, { style: [styles.th, styles.cNo] }, '#'),
        ce(Text, { style: [styles.th, styles.cDesc] }, 'Description'),
        ce(Text, { style: [styles.th, styles.cQty] }, 'Qty'),
        ce(Text, { style: [styles.th, styles.cUnit] }, 'Unit price'),
        ce(Text, { style: [styles.th, styles.cAmt] }, 'Amount'),
      ),
      ...model.lines.map((l) =>
        ce(View, { key: `l${l.lineNo}`, style: styles.tRow, wrap: false },
          ce(Text, { style: [styles.cell, styles.cNo] }, String(l.lineNo)),
          ce(View, { style: styles.cDesc },
            ce(Text, { style: styles.cell }, l.description),
            l.deviceSn ? ce(Text, { style: styles.deviceSn }, `S/N ${l.deviceSn}`) : null,
          ),
          ce(Text, { style: [styles.cell, styles.cQty] }, l.quantity),
          ce(Text, { style: [styles.cell, styles.cUnit] }, l.unitPrice),
          ce(Text, { style: [styles.cell, styles.cAmt] }, l.amount),
        )),

      // ── Totals ────────────────────────────────────────────────────────
      ce(View, { style: styles.totalsWrap },
        ce(View, { style: styles.totals },
          ce(View, { style: styles.totalRow },
            ce(Text, { style: styles.metaKey }, 'Subtotal'),
            ce(Text, { style: styles.metaVal }, model.subtotal)),
          ce(View, { style: styles.totalRow },
            ce(Text, { style: styles.metaKey }, 'Tax'),
            ce(Text, { style: styles.metaVal }, model.tax)),
          ce(View, { style: styles.grandRow },
            ce(Text, { style: styles.grandText }, `Total ${model.currency}`),
            ce(Text, { style: styles.grandText }, model.total)),
        ),
      ),

      // ── Notes ─────────────────────────────────────────────────────────
      model.notes
        ? ce(View, { style: styles.notesBox },
            ce(Text, { style: styles.label }, 'Notes'),
            ce(Text, { style: styles.notesText }, model.notes))
        : null,

      ce(Text, {
        style: styles.footer, fixed: true,
        render: ({ pageNumber, totalPages }: { pageNumber: number; totalPages: number }) =>
          `${QTX_LETTERHEAD.name} · Invoice ${model.invoiceNo} · Generated ${model.generatedAt}`
          + ` · Page ${pageNumber} of ${totalPages}`,
      }),

      // Last child = painted on top. See watermark().
      model.watermark ? watermark(model.watermark) : null,
    ),
  )
}

/** Render to a Buffer for streaming. The only async step. */
export async function renderInvoicePdf(model: InvoicePdfModel): Promise<Buffer> {
  return renderToBuffer(buildInvoiceDocument(model)) as unknown as Promise<Buffer>
}
