import { notFound } from 'next/navigation'
import Link from 'next/link'
import { FileDown } from 'lucide-react'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import {
  getInvoice, listAllowedInvoiceTransitions, getInvoiceApprovalState,
} from '@/modules/finance/services/invoiceService'
import { listInvoiceDocumentAccess } from '@/modules/finance/services/invoicePdfService'
import { listBuyerOptions } from '@/modules/finance/services/buyerService'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { InvoiceStatusPill } from '@/components/finance/InvoiceStatusPill'
import { InvoiceStatusChangeControl } from '@/components/finance/InvoiceStatusChangeControl'
import { InvoiceEditDialog } from '@/components/finance/InvoiceEditDialog'
import { InvoiceApprovalPanel } from '@/components/finance/InvoiceApprovalPanel'

type PageProps = { params: { id: string } }

function formatDate(d: Date | string | null): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/**
 * The invoice detail page. getInvoice's null return IS the 404 — unknown or
 * soft-deleted ids and permission denials both resolve to notFound() so
 * neither confirms whether a record exists (spec §7.3).
 */
export default async function InvoiceDetailPage({ params }: PageProps) {
  const actor = await requireActor()
  if (!can(actor, 'view_finance', 'finance')) notFound()

  const invoice = await getInvoice(actor, params.id)
  if (!invoice) notFound()

  const canEdit = can(actor, 'manage_finance', 'finance')
  // Who has downloaded the PDF is a staff-monitoring view, so it rides on
  // view_full_audit rather than on ordinary finance reading.
  const canSeeAccessLog = can(actor, 'view_full_audit', 'finance')
  const [transitions, buyerOptions, approvalState, documentAccess] = await Promise.all([
    canEdit ? listAllowedInvoiceTransitions(actor, invoice.status) : Promise.resolve([]),
    canEdit ? listBuyerOptions(actor) : Promise.resolve([]),
    // Read for every view_finance actor, not only editors: whether this invoice is
    // blocked on someone else's decision is part of reading it.
    getInvoiceApprovalState(actor, invoice.id),
    canSeeAccessLog ? listInvoiceDocumentAccess(actor, invoice.id) : Promise.resolve([]),
  ])

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-slate-900">{invoice.invoiceNo}</h1>
          <InvoiceStatusPill status={invoice.status} />
          <div className="ml-auto flex items-center gap-2">
            {/*
              A plain link, not a fetch: the route streams application/pdf with a
              Content-Disposition attachment header, so the browser's own download
              handling is exactly the right behaviour. Every click writes a
              document_access_log row server-side (spec §10). No prefetch — a
              prefetched download would log an access nobody asked for.
            */}
            <Link
              href={`/finance/invoices/${invoice.id}/pdf`}
              prefetch={false}
              className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-sm font-medium text-slate-900 hover:bg-slate-50"
            >
              <FileDown className="h-3.5 w-3.5" aria-hidden="true" />
              Download PDF
            </Link>
            {canEdit && (
              <InvoiceEditDialog key={invoice.version} invoice={invoice} buyerOptions={buyerOptions} />
            )}
          </div>
        </div>
        {invoice.status === 'draft' && (
          <p className="mt-2 text-xs text-muted-foreground">
            This invoice is still a draft — the PDF is watermarked DRAFT and must not be sent
            to a buyer.
          </p>
        )}
        {canEdit && (
          <div className="mt-3">
            <InvoiceStatusChangeControl
              invoiceId={invoice.id}
              version={invoice.version}
              currentStatus={invoice.status}
              transitions={transitions}
            />
          </div>
        )}
      </div>

      {approvalState && (
        <InvoiceApprovalPanel
          invoiceId={invoice.id}
          version={invoice.version}
          invoiceStatus={invoice.status}
          canManage={canEdit}
          thresholdSgd={approvalState.thresholdSgd}
          requiresApproval={approvalState.requiresApproval}
          drift={approvalState.drift}
          approval={approvalState.approval && {
            status: approvalState.approval.status,
            requestedByName: approvalState.approval.requestedByName,
            requestedAt: approvalState.approval.requestedAt.toISOString(),
            decidedByName: approvalState.approval.decidedByName,
            decidedAt: approvalState.approval.decidedAt?.toISOString() ?? null,
            decisionNote: approvalState.approval.decisionNote,
          }}
        />
      )}

      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 rounded-md border p-4 sm:grid-cols-2">
        <div>
          <dt className="text-xs font-medium text-muted-foreground">Buyer</dt>
          <dd className="mt-0.5 text-sm text-slate-900">
            <Link href={`/finance/buyers/${invoice.buyerId}`} className="hover:underline">{invoice.buyerName}</Link>
          </dd>
        </div>
        <Field label="Currency" value={invoice.currency} />
        <Field label="Issue date" value={formatDate(invoice.issueDate)} />
        <Field label="Due date" value={formatDate(invoice.dueDate)} />
        <div className="sm:col-span-2">
          <dt className="text-xs font-medium text-muted-foreground">Notes</dt>
          <dd className="mt-0.5 whitespace-pre-wrap text-sm text-slate-900">{invoice.notes ?? '—'}</dd>
        </div>
      </dl>

      <div>
        <h2 className="mb-3 text-lg font-semibold text-slate-900">Line items</h2>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>#</TableHead>
                <TableHead>Description</TableHead>
                <TableHead>Device</TableHead>
                <TableHead className="text-right">Qty</TableHead>
                <TableHead className="text-right">Unit price</TableHead>
                <TableHead className="text-right">Amount</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {invoice.lines.map((l) => (
                <TableRow key={l.id}>
                  <TableCell>{l.lineNo}</TableCell>
                  <TableCell>{l.description}</TableCell>
                  <TableCell>
                    {l.deviceId ? (
                      <Link href={`/manufacturing/devices/${l.deviceId}`} className="hover:underline">
                        {l.deviceSn ?? l.deviceId}
                      </Link>
                    ) : '—'}
                  </TableCell>
                  <TableCell className="text-right">{l.quantity}</TableCell>
                  <TableCell className="text-right">S${l.unitPriceSgd}</TableCell>
                  <TableCell className="text-right">S${l.amountSgd}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
        <div className="mt-3 ml-auto max-w-xs space-y-1 text-sm">
          <div className="flex justify-between"><span className="text-muted-foreground">Subtotal</span><span>S${invoice.subtotalSgd ?? '0.00'}</span></div>
          <div className="flex justify-between"><span className="text-muted-foreground">Tax</span><span>S${invoice.taxSgd ?? '0.00'}</span></div>
          <div className="flex justify-between font-medium"><span>Total</span><span>S${invoice.totalSgd ?? '0.00'}</span></div>
        </div>
      </div>

      {canSeeAccessLog && (
        <div>
          <h2 className="mb-3 text-lg font-semibold text-slate-900">PDF downloads</h2>
          {documentAccess.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              Nobody has downloaded this invoice&rsquo;s PDF yet.
            </p>
          ) : (
            <ul className="space-y-1 rounded-md border p-3 text-sm text-slate-600">
              {documentAccess.map((a) => (
                <li key={a.id} className="flex flex-wrap gap-x-3">
                  <span className="text-slate-900">{a.actorName ?? a.actorEmail ?? a.actorId}</span>
                  <span>{formatDateTime(a.accessedAt)}</span>
                  {a.entityStatus && (
                    <span className="text-muted-foreground">· copy taken while {a.entityStatus}</span>
                  )}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

function formatDateTime(d: Date | string): string {
  return new Date(d).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-900">{value}</dd>
    </div>
  )
}
