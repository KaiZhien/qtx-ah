import { notFound } from 'next/navigation'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { listStockTransfers } from '@/modules/logistics/services/stockTransferService'
import {
  STOCK_TRANSFER_STATUSES, type StockTransferStatus,
} from '@/modules/logistics/domain/transferStatus'
import { StockTransferTable } from '@/components/logistics/StockTransferTable'
import { TRANSFER_STATUS_LABELS } from '@/components/logistics/TransferStatusPill'
import { Button } from '@/components/ui/button'

const PAGE_SIZE = 25

type PageProps = { searchParams: { status?: string } }

function isTransferStatus(v: string): v is StockTransferStatus {
  return (STOCK_TRANSFER_STATUSES as readonly string[]).includes(v)
}

/** URL-driven filters, same convention as the delivery-order list. */
export default async function StockTransfersPage({ searchParams }: PageProps) {
  const actor = await requireActor()
  // 404 rather than 403: a denial must not confirm the section exists (spec §7.3).
  if (!can(actor, 'view_records', 'logistics')) notFound()

  const status = searchParams.status
    ? searchParams.status.split(',').filter(isTransferStatus)
    : undefined
  const filter = { status, limit: PAGE_SIZE }

  const { items, nextCursor } = await listStockTransfers(actor, filter)
  const active = searchParams.status ?? ''

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Stock transfers</h1>
          <p className="mt-1 text-slate-600">
            Movements of stock between locations. Balances change when a transfer is received.
          </p>
        </div>
        {can(actor, 'create_records', 'logistics') && (
          <Button asChild>
            <Link href="/logistics/transfers/new">
              <Plus className="mr-1.5 h-4 w-4" />
              New transfer
            </Link>
          </Button>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <Link
          href="/logistics/transfers"
          className={`rounded-md border px-3 py-1.5 text-sm ${
            active === '' ? 'border-primary bg-primary/5 font-medium text-primary' : 'text-slate-700'}`}
        >
          All
        </Link>
        {STOCK_TRANSFER_STATUSES.map((s) => (
          <Link
            key={s}
            href={`/logistics/transfers?status=${s}`}
            className={`rounded-md border px-3 py-1.5 text-sm ${
              active === s ? 'border-primary bg-primary/5 font-medium text-primary' : 'text-slate-700'}`}
          >
            {TRANSFER_STATUS_LABELS[s]}
          </Link>
        ))}
      </div>

      {/* key forces a remount (dropping accumulated "Load more" pages) when the filter changes. */}
      <StockTransferTable key={active} initialItems={items} initialCursor={nextCursor} filter={filter} />
    </div>
  )
}
