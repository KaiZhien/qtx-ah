import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { MODULE_REGISTRY } from '@/modules/shared/navigation/moduleRegistry'
import { iconFor } from '@/components/platform/moduleIcons'
import { getDoStatusCounts } from '@/modules/logistics/services/deliveryOrderService'
import { DO_STATUS_LABELS } from '@/components/logistics/DoStatusPill'

/**
 * Logistics module landing (replaces the Task-7 ModuleLanding stub). DO
 * counts by status come from ONE grouped query (getDoStatusCounts), each tile
 * links into the filtered delivery-order list — same shape as
 * app/(platform)/manufacturing/page.tsx's device-counts-by-status widget.
 */
export default async function LogisticsPage() {
  const actor = await requireActor()
  const def = MODULE_REGISTRY.find((m) => m.key === 'logistics')!
  // 404 rather than 403: a denial must not confirm the section exists (spec §7.3).
  if (!can(actor, def.gate, def.key)) notFound()

  const Icon = iconFor(def.icon)
  const counts = await getDoStatusCounts(actor)
  const total = counts.reduce((sum, c) => sum + c.count, 0)

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <Icon className="h-8 w-8 text-slate-400" aria-hidden="true" />
        <h1 className="text-2xl font-semibold text-slate-900">{def.label}</h1>
      </div>
      <p className="text-slate-600">{def.description}</p>

      <div className="rounded-md border">
        <div className="flex items-center justify-between border-b p-4">
          <div>
            <p className="text-sm font-medium text-slate-900">Delivery orders by status</p>
            <p className="text-xs text-muted-foreground">
              {total} delivery order{total === 1 ? '' : 's'}
            </p>
          </div>
          <Link href="/logistics/delivery-orders" className="text-sm font-medium text-primary hover:underline">
            View all delivery orders →
          </Link>
        </div>
        <div className="grid grid-cols-2 divide-x divide-y sm:grid-cols-3 lg:grid-cols-5">
          {counts.map((c) => (
            <Link
              key={c.status}
              href={`/logistics/delivery-orders?status=${c.status}`}
              className="p-4 transition-colors hover:bg-muted/50"
            >
              <p className="text-2xl font-semibold text-slate-900">{c.count}</p>
              <p className="text-sm text-muted-foreground">{DO_STATUS_LABELS[c.status]}</p>
            </Link>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-3">
        <Link href="/logistics/locations" className="text-sm font-medium text-primary hover:underline">
          Manage stock locations →
        </Link>
      </div>
    </div>
  )
}
