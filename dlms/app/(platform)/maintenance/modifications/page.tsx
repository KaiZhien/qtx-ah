import { notFound } from 'next/navigation'
import Link from 'next/link'
import { Plus } from 'lucide-react'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { listModifications } from '@/modules/maintenance/services/modificationService'
import {
  MODIFICATION_STATUSES, modificationStatusLabel, type ModificationStatus,
} from '@/modules/maintenance/domain/modificationStatus'
import { ModificationStatusPill } from '@/components/maintenance/ModificationStatusPill'
import { Button } from '@/components/ui/button'

type PageProps = { searchParams: { status?: string } }

function parseStatus(v: string | undefined): ModificationStatus | undefined {
  return MODIFICATION_STATUSES.includes(v as ModificationStatus)
    ? (v as ModificationStatus) : undefined
}

function formatDate(d: Date | string | null): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

/**
 * The modifications list (spec §6.3) — the sibling of the repairs list. Status
 * filter lives in the URL search param, so each filter is a plain server-rendered
 * fetch through listModifications. Basic scope shows one page (no "load more");
 * keyset pagination is already wired in the service.
 */
export default async function ModificationsPage({ searchParams }: PageProps) {
  const actor = await requireActor()
  // 404 rather than 403: a denial must not confirm the section exists (spec §7.3).
  if (!can(actor, 'view_records', 'maintenance')) notFound()

  const status = parseStatus(searchParams.status)
  const { items } = await listModifications(actor, { status: status ? [status] : undefined })

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Modifications</h1>
          <p className="mt-1 text-slate-600">
            Hardware upgrades, ECO retrofits and field changes to devices already built.
          </p>
        </div>
        {can(actor, 'create_records', 'maintenance') && (
          <Button asChild>
            <Link href="/maintenance/modifications/new">
              <Plus className="mr-1.5 h-4 w-4" />
              New modification
            </Link>
          </Button>
        )}
      </div>

      <div className="flex flex-wrap gap-2">
        <FilterChip label="All" href="/maintenance/modifications" active={!status} />
        {MODIFICATION_STATUSES.map((s) => (
          <FilterChip
            key={s} label={modificationStatusLabel(s)}
            href={`/maintenance/modifications?status=${s}`} active={status === s}
          />
        ))}
      </div>

      {items.length === 0 ? (
        <p className="rounded-md border p-4 text-sm text-muted-foreground">
          No modifications match this view.
        </p>
      ) : (
        <div className="overflow-x-auto rounded-md border">
          <table className="w-full text-sm">
            <thead className="border-b bg-muted/50 text-left text-xs text-muted-foreground">
              <tr>
                <th className="p-3 font-medium">Modification</th>
                <th className="p-3 font-medium">Device</th>
                <th className="p-3 font-medium">Status</th>
                <th className="p-3 font-medium">Type</th>
                <th className="p-3 font-medium">Reason</th>
                <th className="p-3 font-medium">Requested</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {items.map((m) => (
                <tr key={m.id} className="hover:bg-muted/50">
                  <td className="p-3">
                    <Link
                      href={`/maintenance/modifications/${m.id}`}
                      className="font-medium text-primary hover:underline"
                    >
                      {m.modificationNo}
                    </Link>
                  </td>
                  <td className="p-3">
                    <Link href={`/manufacturing/devices/${m.deviceId}`} className="hover:underline">
                      {m.deviceSn ?? 'No serial'}
                    </Link>
                  </td>
                  <td className="p-3"><ModificationStatusPill status={m.status} /></td>
                  <td className="p-3 text-slate-700">{m.typeName}</td>
                  <td className="max-w-xs truncate p-3 text-slate-700">{m.reason ?? '—'}</td>
                  <td className="whitespace-nowrap p-3 text-slate-700">{formatDate(m.requestedOn)}</td>
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
