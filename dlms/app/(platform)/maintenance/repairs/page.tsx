import { notFound } from 'next/navigation'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { listRepairs } from '@/modules/maintenance/services/repairService'
import {
  REPAIR_STATUSES, repairStatusLabel, type RepairStatus,
} from '@/modules/maintenance/domain/repairStatus'
import { RepairStatusPill } from '@/components/maintenance/RepairStatusPill'
import { Button } from '@/components/ui/button'

type PageProps = { searchParams: { status?: string } }

function parseStatus(v: string | undefined): RepairStatus | undefined {
  return REPAIR_STATUSES.includes(v as RepairStatus) ? (v as RepairStatus) : undefined
}

function formatDate(d: Date | string | null): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/**
 * The repairs list (spec §5.3). Status filter lives in the URL search param, so
 * each filter is a plain server-rendered fetch through listRepairs. Basic scope
 * shows one page (no "load more"); keyset pagination is wired in the service.
 */
export default async function RepairsPage({ searchParams }: PageProps) {
  const actor = await requireActor()
  // 404 rather than 403: a denial must not confirm the section exists (spec §7.3).
  if (!can(actor, 'view_records', 'maintenance')) notFound()

  const status = parseStatus(searchParams.status)
  const { items } = await listRepairs(actor, { status: status ? [status] : undefined })

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Repairs</h1>
          <p className="mt-1 text-slate-600">The repair register — open, track, and sign off repairs.</p>
        </div>
        {can(actor, 'create_records', 'maintenance') && (
          <Button asChild>
            <Link href="/maintenance/repairs/new">
              <Plus className="mr-1.5 h-4 w-4" />
              New repair
            </Link>
          </Button>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <FilterChip label="All" href="/maintenance/repairs" active={!status} />
        {REPAIR_STATUSES.map((s) => (
          <FilterChip
            key={s} label={repairStatusLabel(s)}
            href={`/maintenance/repairs?status=${s}`} active={status === s}
          />
        ))}
      </div>

      {items.length === 0 ? (
        <p className="rounded-md border p-4 text-sm text-muted-foreground">No repairs match this view.</p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-3 font-medium">Repair</th>
                <th className="p-3 font-medium">Device</th>
                <th className="p-3 font-medium">Status</th>
                <th className="p-3 font-medium">Fault</th>
                <th className="p-3 font-medium">Assigned</th>
                <th className="p-3 font-medium">Opened</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {items.map((r) => (
                <tr key={r.id} className="hover:bg-muted/50">
                  <td className="p-3">
                    <Link href={`/maintenance/repairs/${r.id}`} className="font-medium text-primary hover:underline">
                      {r.repairNo}
                    </Link>
                  </td>
                  <td className="p-3">
                    <Link href={`/manufacturing/devices/${r.deviceId}`} className="hover:underline">
                      {r.deviceSn ?? 'No serial'}
                    </Link>
                  </td>
                  <td className="p-3"><RepairStatusPill status={r.status} /></td>
                  <td className="max-w-xs truncate p-3 text-slate-700">{r.faultDescription ?? '—'}</td>
                  <td className="p-3 text-slate-700">{r.assignedToName ?? '—'}</td>
                  <td className="p-3 text-slate-700">{formatDate(r.openedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}

function FilterChip({ label, href, active }: { label: string; href: string; active: boolean }) {
  return (
    <Link
      href={href}
      className={`rounded-full border px-3 py-1 text-sm transition-colors ${
        active ? 'border-primary bg-primary text-primary-foreground' : 'hover:bg-muted'
      }`}
    >
      {label}
    </Link>
  )
}
