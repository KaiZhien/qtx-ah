import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { MODULE_REGISTRY } from '@/modules/shared/navigation/moduleRegistry'
import { iconFor } from '@/components/platform/moduleIcons'
import { getDeviceStatusCounts } from '@/modules/manufacturing/services/deviceReadService'

/**
 * Manufacturing module landing (Task 13, replacing Task 7's ModuleLanding
 * stub). Device counts by status come from ONE grouped query
 * (getDeviceStatusCounts) and each tile links into the filtered registry list
 * — the same shape as spec §8.5's Manufacturing dashboard "devices by status"
 * pipeline funnel, minus the variant breakdown (Week 3+).
 */
export default async function ManufacturingPage() {
  const actor = await requireActor()
  const def = MODULE_REGISTRY.find((m) => m.key === 'manufacturing')!
  // 404 rather than 403: a denial must not confirm the section exists (spec §7.3).
  if (!can(actor, def.gate, def.key)) notFound()

  const Icon = iconFor(def.icon)
  const counts = await getDeviceStatusCounts(actor)
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
            <p className="text-sm font-medium text-slate-900">Devices by status</p>
            <p className="text-xs text-muted-foreground">
              {total} device{total === 1 ? '' : 's'} in the registry
            </p>
          </div>
          <Link href="/manufacturing/devices" className="text-sm font-medium text-primary hover:underline">
            View all devices →
          </Link>
        </div>
        <div className="grid grid-cols-2 divide-x divide-y sm:grid-cols-3 lg:grid-cols-4">
          {counts.map((c) => (
            <Link
              key={c.status}
              href={`/manufacturing/devices?status=${c.status}`}
              className="p-4 transition-colors hover:bg-muted/50"
            >
              <p className="text-2xl font-semibold text-slate-900">{c.count}</p>
              <p className="text-sm text-muted-foreground">{c.statusLabel}</p>
            </Link>
          ))}
        </div>
      </div>

      <div className="flex flex-wrap gap-4">
        {can(actor, 'import_data', 'manufacturing') && can(actor, 'view_records', 'manufacturing') && (
          <Link href="/manufacturing/import" className="text-sm font-medium text-primary hover:underline">
            Import devices →
          </Link>
        )}
        {/*
          The component-type catalogue was an ORPHAN — built, gated and tested,
          with nothing anywhere in the app linking to it, so it was reachable only
          by typing the URL. Found by routeReachability.test.ts while closing the
          same defect on /search.

          No `can()` around it, deliberately: the catalogue page enforces
          `view_records` in manufacturing, which is the very gate this landing page
          already required to render at all (MODULE_REGISTRY's manufacturing gate).
          Re-checking it here would imply the two could differ; they cannot, and
          the offer can never dead-end at a 404.
        */}
        <Link href="/manufacturing/components" className="text-sm font-medium text-primary hover:underline">
          Component types →
        </Link>
      </div>

      <p className="inline-block rounded-md bg-slate-100 px-3 py-1 text-sm text-slate-500">
        Create, edit, and status-change actions land Week 3.
      </p>
    </div>
  )
}
