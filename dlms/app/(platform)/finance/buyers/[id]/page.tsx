import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { getBuyer } from '@/modules/finance/services/buyerService'
import { listInvoices } from '@/modules/finance/services/invoiceService'
import { BuyerEditDialog } from '@/components/finance/BuyerEditDialog'
import { InvoiceStatusPill } from '@/components/finance/InvoiceStatusPill'

type PageProps = { params: { id: string } }

function formatDate(d: Date | string | null): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/**
 * The buyer profile page. getBuyer's null return IS the 404 — unknown or
 * soft-deleted ids and permission denials both resolve to notFound() so
 * neither confirms whether a record exists (spec §7.3).
 */
export default async function BuyerDetailPage({ params }: PageProps) {
  const actor = await requireActor()
  if (!can(actor, 'view_finance', 'finance')) notFound()

  const buyer = await getBuyer(actor, params.id)
  if (!buyer) notFound()

  const canEdit = can(actor, 'manage_finance', 'finance')
  const { items: invoices } = await listInvoices(actor, { buyerId: buyer.id, limit: 25 })

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3">
        <h1 className="text-2xl font-semibold text-slate-900">{buyer.name}</h1>
        {canEdit && <div className="ml-auto"><BuyerEditDialog key={buyer.version} buyer={buyer} /></div>}
      </div>

      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 rounded-md border p-4 sm:grid-cols-2">
        <Field label="Country" value={buyer.country ?? '—'} />
        <Field label="Contact name" value={buyer.contactName ?? '—'} />
        <Field label="Contact email" value={buyer.contactEmail ?? '—'} />
        <Field label="Contact phone" value={buyer.contactPhone ?? '—'} />
        <div className="sm:col-span-2">
          <dt className="text-xs font-medium text-muted-foreground">Billing address</dt>
          <dd className="mt-0.5 whitespace-pre-wrap text-sm text-slate-900">{buyer.billingAddress ?? '—'}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs font-medium text-muted-foreground">Notes</dt>
          <dd className="mt-0.5 whitespace-pre-wrap text-sm text-slate-900">{buyer.notes ?? '—'}</dd>
        </div>
      </dl>

      <div>
        <h2 className="mb-3 text-lg font-semibold text-slate-900">Invoices</h2>
        {invoices.length === 0 ? (
          <p className="rounded-md border p-4 text-sm text-muted-foreground">No invoices for this buyer yet.</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {invoices.map((i) => (
              <li key={i.id} className="flex items-center justify-between gap-4 px-4 py-2.5">
                <Link href={`/finance/invoices/${i.id}`} className="font-medium text-slate-900 hover:underline">
                  {i.invoiceNo}
                </Link>
                <span className="text-sm text-muted-foreground">{formatDate(i.issueDate)}</span>
                <span className="text-sm text-slate-900">{i.totalSgd ? `S$${i.totalSgd}` : '—'}</span>
                <InvoiceStatusPill status={i.status} />
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-900">{value}</dd>
    </div>
  )
}
