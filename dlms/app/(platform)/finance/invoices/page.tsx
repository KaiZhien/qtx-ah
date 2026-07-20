import { notFound } from 'next/navigation'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { listInvoices } from '@/modules/finance/services/invoiceService'
import { listBuyerOptions } from '@/modules/finance/services/buyerService'
import { InvoiceFilters } from '@/components/finance/InvoiceFilters'
import { InvoiceTable } from '@/components/finance/InvoiceTable'
import { Button } from '@/components/ui/button'
import type { InvoiceStatus } from '@/modules/finance/domain/invoiceStatus'

const PAGE_SIZE = 25

type PageProps = { searchParams: { status?: string; buyer?: string } }

/**
 * The sales invoice list (finance module, basic portions, D18: sales invoices
 * only). 404-not-403 via view_finance (spec §3.2/D12 — see buyers/page.tsx).
 */
export default async function InvoicesPage({ searchParams }: PageProps) {
  const actor = await requireActor()
  if (!can(actor, 'view_finance', 'finance')) notFound()

  const filter = {
    status: searchParams.status ? [searchParams.status as InvoiceStatus] : undefined,
    buyerId: searchParams.buyer || undefined,
    limit: PAGE_SIZE,
  }

  const [{ items, nextCursor }, buyerOptions] = await Promise.all([
    listInvoices(actor, filter),
    listBuyerOptions(actor),
  ])

  const filterKey = `${searchParams.status ?? ''}|${searchParams.buyer ?? ''}`

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Sales invoices</h1>
          <p className="mt-1 text-slate-600">Draft, issue, and track payment status.</p>
        </div>
        {can(actor, 'manage_finance', 'finance') && (
          <Button asChild>
            <Link href="/finance/invoices/new">
              <Plus className="mr-1.5 h-4 w-4" />
              New invoice
            </Link>
          </Button>
        )}
      </div>
      <InvoiceFilters buyerOptions={buyerOptions} />
      <InvoiceTable key={filterKey} initialItems={items} initialCursor={nextCursor} filter={filter} />
    </div>
  )
}
