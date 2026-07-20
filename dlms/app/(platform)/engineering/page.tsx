import { notFound } from 'next/navigation'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { MODULE_REGISTRY } from '@/modules/shared/navigation/moduleRegistry'
import { iconFor } from '@/components/platform/moduleIcons'
import {
  getEngineeringCounts, type EngStatusCount,
} from '@/modules/engineering/services/engineeringReadService'
import { EngStatusBadge } from '@/components/engineering/EngStatusBadge'

/**
 * Engineering module landing (replaces the ModuleLanding stub). Status counts
 * for the three record types come from getEngineeringCounts (one grouped query
 * apiece) and each card links into its filtered list — the same shape as the
 * Manufacturing landing (spec §8.5), scoped to Engineering's basic entities.
 */
export default async function EngineeringPage() {
  const actor = await requireActor()
  const def = MODULE_REGISTRY.find((m) => m.key === 'engineering')!
  // 404 rather than 403: a denial must not confirm the section exists (spec §7.3).
  if (!can(actor, def.gate, def.key)) notFound()

  const Icon = iconFor(def.icon)
  const counts = await getEngineeringCounts(actor)
  const canCreate = can(actor, 'create_records', 'engineering')

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-center gap-3">
        <Icon className="h-8 w-8 text-slate-400" aria-hidden="true" />
        <h1 className="text-2xl font-semibold text-slate-900">{def.label}</h1>
      </div>
      <p className="text-slate-600">{def.description}</p>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <SummaryCard
          title="Change requests" href="/engineering/ecr" newHref="/engineering/ecr/new"
          canCreate={canCreate} counts={counts.ecr}
        />
        <SummaryCard
          title="Change orders" href="/engineering/eco" newHref="/engineering/eco/new"
          canCreate={canCreate} counts={counts.eco}
        />
        <SummaryCard
          title="Firmware releases" href="/engineering/firmware" newHref="/engineering/firmware/new"
          canCreate={canCreate} counts={counts.firmware}
        />
      </div>
    </div>
  )
}

function SummaryCard({
  title, href, newHref, canCreate, counts,
}: {
  title: string; href: string; newHref: string; canCreate: boolean; counts: EngStatusCount[]
}) {
  const total = counts.reduce((sum, c) => sum + c.count, 0)
  return (
    <div className="flex flex-col rounded-md border">
      <div className="border-b p-4">
        <Link href={href} className="text-sm font-medium text-slate-900 hover:underline">{title}</Link>
        <p className="mt-1 text-2xl font-semibold text-slate-900">{total}</p>
      </div>
      <div className="flex flex-1 flex-col gap-2 p-4">
        {counts.length === 0 ? (
          <p className="text-sm text-muted-foreground">None yet.</p>
        ) : (
          <ul className="space-y-1.5">
            {counts.map((c) => (
              <li key={c.status} className="flex items-center justify-between text-sm">
                <EngStatusBadge status={c.status} />
                <span className="tabular-nums text-slate-700">{c.count}</span>
              </li>
            ))}
          </ul>
        )}
      </div>
      <div className="flex items-center justify-between border-t p-3">
        <Link href={href} className="text-sm font-medium text-primary hover:underline">View all →</Link>
        {canCreate && (
          <Link href={newHref} className="inline-flex items-center text-sm font-medium text-primary hover:underline">
            <Plus className="mr-1 h-3.5 w-3.5" /> New
          </Link>
        )}
      </div>
    </div>
  )
}
