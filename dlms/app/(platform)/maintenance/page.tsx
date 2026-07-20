import { notFound } from 'next/navigation'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { MODULE_REGISTRY } from '@/modules/shared/navigation/moduleRegistry'
import { iconFor } from '@/components/platform/moduleIcons'
import { getRepairStatusCounts, listRepairs } from '@/modules/maintenance/services/repairService'
import { RepairStatusPill } from '@/components/maintenance/RepairStatusPill'
import { Button } from '@/components/ui/button'

/**
 * Maintenance module landing (spec §8.5: active repairs by state + recent). Repair
 * counts by state come from one grouped query (getRepairStatusCounts, zero-filled
 * across the fixed vocabulary); each tile links into the filtered repairs list.
 */
export default async function MaintenancePage() {
  const actor = await requireActor()
  const def = MODULE_REGISTRY.find((m) => m.key === 'maintenance')!
  // 404 rather than 403: a denial must not confirm the section exists (spec §7.3).
  if (!can(actor, def.gate, def.key)) notFound()

  const Icon = iconFor(def.icon)
  const [counts, { items: recent }] = await Promise.all([
    getRepairStatusCounts(actor),
    listRepairs(actor, { limit: 8 }),
  ])
  const total = counts.reduce((sum, c) => sum + c.count, 0)
  const canCreate = can(actor, 'create_records', 'maintenance')

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <Icon className="h-8 w-8 text-slate-400" aria-hidden="true" />
          <h1 className="text-2xl font-semibold text-slate-900">{def.label}</h1>
        </div>
        {canCreate && (
          <Button asChild>
            <Link href="/maintenance/repairs/new">
              <Plus className="mr-1.5 h-4 w-4" />
              New repair
            </Link>
          </Button>
        )}
      </div>
      <p className="text-slate-600">Repairs — the six-state repair workflow and sign-off.</p>

      <div className="rounded-md border">
        <div className="flex items-center justify-between border-b p-4">
          <div>
            <p className="text-sm font-medium text-slate-900">Repairs by state</p>
            <p className="text-xs text-muted-foreground">
              {total} repair{total === 1 ? '' : 's'} on record
            </p>
          </div>
          <Link href="/maintenance/repairs" className="text-sm font-medium text-primary hover:underline">
            View all repairs →
          </Link>
        </div>
        <div className="grid grid-cols-2 divide-x divide-y sm:grid-cols-3 lg:grid-cols-4">
          {counts.map((c) => (
            <Link
              key={c.status}
              href={`/maintenance/repairs?status=${c.status}`}
              className="p-4 transition-colors hover:bg-muted/50"
            >
              <p className="text-2xl font-semibold text-slate-900">{c.count}</p>
              <p className="text-sm text-muted-foreground">{c.statusLabel}</p>
            </Link>
          ))}
        </div>
      </div>

      <div className="rounded-md border">
        <div className="border-b p-4">
          <p className="text-sm font-medium text-slate-900">Recent repairs</p>
        </div>
        {recent.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No repairs yet.</p>
        ) : (
          <ul className="divide-y">
            {recent.map((r) => (
              <li key={r.id}>
                <Link
                  href={`/maintenance/repairs/${r.id}`}
                  className="flex items-center justify-between gap-3 p-4 text-sm hover:bg-muted/50"
                >
                  <span className="flex min-w-0 flex-col">
                    <span className="font-medium text-slate-900">{r.repairNo}</span>
                    <span className="truncate text-muted-foreground">
                      {r.deviceSn ?? 'No serial'}
                      {r.faultDescription ? ` · ${r.faultDescription}` : ''}
                    </span>
                  </span>
                  <RepairStatusPill status={r.status} />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </div>

      <p className="inline-block rounded-md bg-slate-100 px-3 py-1 text-sm text-slate-500">
        Files, usage logs, modifications, and downtime reporting land later (spec §17, Weeks 7–8).
      </p>
    </div>
  )
}
