import { notFound } from 'next/navigation'
import Link from 'next/link'
import { Banknote, Users, ShieldCheck } from 'lucide-react'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { getInvoiceStatusCounts } from '@/modules/finance/services/invoiceService'
import { getWarrantyExpiryCounts } from '@/modules/finance/services/warrantyService'
import { InvoiceStatusPill } from '@/components/finance/InvoiceStatusPill'

const STATUS_LABEL: Record<string, string> = { draft: 'Draft', issued: 'Issued', paid: 'Paid', void: 'Void' }

/**
 * The Finance landing page (spec §4.1: Finance = Sales invoices · Buyers ·
 * Approval queue — this basic build has no approval queue, the D18/threshold-
 * approval engine is out of scope). Gated on view_finance, not the coarser
 * module-registry gate (view_records) — spec §3.2: Viewer never holds
 * view_finance even with Finance module access, and D12 makes this
 * page-level gate the whole masking story for this basic build.
 */
export default async function FinancePage() {
  const actor = await requireActor()
  if (!can(actor, 'view_finance', 'finance')) notFound()

  // Warranty reads are gated on view_records-in-finance, a LOWER bar than this
  // page's view_finance gate — so anyone who got here already passes it and the
  // call cannot throw. (The reverse gap is real and deliberate: a Viewer with
  // Finance module access may read /finance/warranties directly but cannot see
  // this landing page, because it also shows invoice money.)
  const [counts, warrantyCounts] = await Promise.all([
    getInvoiceStatusCounts(actor),
    getWarrantyExpiryCounts(actor),
  ])

  return (
    <div className="max-w-3xl space-y-8">
      <div className="flex items-center gap-3">
        <Banknote className="h-8 w-8 text-slate-400" aria-hidden="true" />
        <h1 className="text-2xl font-semibold text-slate-900">Finance</h1>
      </div>
      <p className="text-slate-600">Sales invoices and buyers (D18: sales invoices only — SGD).</p>

      <div>
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">Invoices by status</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {counts.map((c) => (
            <Link
              key={c.status}
              href={`/finance/invoices?status=${c.status}`}
              className="rounded-md border p-4 hover:bg-slate-50"
            >
              <div className="mb-1"><InvoiceStatusPill status={c.status} /></div>
              <p className="text-2xl font-semibold text-slate-900">{c.count}</p>
              <p className="text-xs text-muted-foreground">{STATUS_LABEL[c.status]}</p>
            </Link>
          ))}
        </div>
      </div>

      <div>
        <h2 className="mb-3 text-sm font-medium text-muted-foreground">Warranty expiry</h2>
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
          {([30, 60, 90] as const).map((w) => (
            <Link
              key={w}
              href={`/finance/warranties?within=${w}`}
              className="rounded-md border p-4 hover:bg-slate-50"
            >
              <p className="text-2xl font-semibold text-slate-900">
                {w === 30 ? warrantyCounts.within30 : w === 60 ? warrantyCounts.within60 : warrantyCounts.within90}
              </p>
              <p className="text-xs text-muted-foreground">Expiring within {w} days</p>
            </Link>
          ))}
          <Link href="/finance/warranties" className="rounded-md border p-4 hover:bg-slate-50">
            <p className="text-2xl font-semibold text-slate-900">{warrantyCounts.expired}</p>
            <p className="text-xs text-muted-foreground">Already expired</p>
          </Link>
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <Link
          href="/finance/warranties"
          className="flex items-center gap-2 rounded-md border px-4 py-3 text-sm font-medium text-slate-900 hover:bg-slate-50"
        >
          <ShieldCheck className="h-4 w-4" aria-hidden="true" />
          Warranties
        </Link>
        <Link
          href="/finance/invoices"
          className="flex items-center gap-2 rounded-md border px-4 py-3 text-sm font-medium text-slate-900 hover:bg-slate-50"
        >
          <Banknote className="h-4 w-4" aria-hidden="true" />
          Sales invoices
        </Link>
        <Link
          href="/finance/buyers"
          className="flex items-center gap-2 rounded-md border px-4 py-3 text-sm font-medium text-slate-900 hover:bg-slate-50"
        >
          <Users className="h-4 w-4" aria-hidden="true" />
          Buyers
        </Link>
      </div>

      <p className="inline-block rounded-md bg-slate-100 px-3 py-1 text-sm text-slate-500">
        Approval queue (invoices ≥ threshold) lands with the platform-wide approvals engine — not part of this
        basic build.
      </p>
    </div>
  )
}
