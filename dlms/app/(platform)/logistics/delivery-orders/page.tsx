import { notFound } from 'next/navigation'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { listDeliveryOrders } from '@/modules/logistics/services/deliveryOrderService'
import { DO_STATUSES, type DoStatus } from '@/modules/logistics/domain/doStatus'
import { DeliveryOrderFilters } from '@/components/logistics/DeliveryOrderFilters'
import { DeliveryOrderTable } from '@/components/logistics/DeliveryOrderTable'
import { Button } from '@/components/ui/button'

const PAGE_SIZE = 25

type PageProps = { searchParams: { status?: string } }

function isDoStatus(v: string): v is DoStatus {
  return (DO_STATUSES as readonly string[]).includes(v)
}

/**
 * The delivery order list (Basic Logistics scope). Same URL-driven filter
 * convention as manufacturing/devices/page.tsx: every filter combination is a
 * plain server-rendered fetch through listDeliveryOrders.
 */
export default async function DeliveryOrdersPage({ searchParams }: PageProps) {
  const actor = await requireActor()
  // 404 rather than 403: a denial must not confirm the section exists (spec §7.3).
  if (!can(actor, 'view_records', 'logistics')) notFound()

  const status = searchParams.status
    ? searchParams.status.split(',').filter(isDoStatus)
    : undefined
  const filter = { status, limit: PAGE_SIZE }

  const { items, nextCursor } = await listDeliveryOrders(actor, filter)

  // Forces DeliveryOrderTable to remount (dropping accumulated "Load more"
  // pages) whenever the filter actually changes.
  const filterKey = searchParams.status ?? ''

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Delivery orders</h1>
          <p className="mt-1 text-slate-600">
            Delivery orders with proof-of-delivery references and a simple status flow.
          </p>
        </div>
        {can(actor, 'create_records', 'logistics') && (
          <Button asChild>
            <Link href="/logistics/delivery-orders/new">
              <Plus className="mr-1.5 h-4 w-4" />
              New delivery order
            </Link>
          </Button>
        )}
      </div>
      <DeliveryOrderFilters />
      <DeliveryOrderTable key={filterKey} initialItems={items} initialCursor={nextCursor} filter={filter} />
    </div>
  )
}
