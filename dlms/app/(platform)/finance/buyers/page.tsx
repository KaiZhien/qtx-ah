import { notFound } from 'next/navigation'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { listBuyers } from '@/modules/finance/services/buyerService'
import { BuyerFilters } from '@/components/finance/BuyerFilters'
import { BuyerTable } from '@/components/finance/BuyerTable'
import { Button } from '@/components/ui/button'

const PAGE_SIZE = 25

type PageProps = { searchParams: { q?: string } }

/**
 * The buyer list (finance module, basic portions). 404-not-403: a denial must
 * not confirm the section exists (spec §7.3). Gated on view_finance, not
 * view_records — a buyer is financial-adjacent data (spec §3.2: Viewer never
 * holds view_finance).
 */
export default async function BuyersPage({ searchParams }: PageProps) {
  const actor = await requireActor()
  if (!can(actor, 'view_finance', 'finance')) notFound()

  const filter = { q: searchParams.q || undefined, limit: PAGE_SIZE }
  const { items, nextCursor } = await listBuyers(actor, filter)

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Buyers</h1>
          <p className="mt-1 text-slate-600">Customers billed on sales invoices.</p>
        </div>
        {can(actor, 'manage_finance', 'finance') && (
          <Button asChild>
            <Link href="/finance/buyers/new">
              <Plus className="mr-1.5 h-4 w-4" />
              New buyer
            </Link>
          </Button>
        )}
      </div>
      <BuyerFilters />
      <BuyerTable key={searchParams.q ?? ''} initialItems={items} initialCursor={nextCursor} filter={filter} />
    </div>
  )
}
