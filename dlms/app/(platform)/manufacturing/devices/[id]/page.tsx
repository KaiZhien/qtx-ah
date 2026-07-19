import { notFound } from 'next/navigation'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { getDevice } from '@/modules/manufacturing/services/deviceReadService'
import { TaskPanel } from '@/components/tasks/TaskPanel'
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs'
import { Badge } from '@/components/ui/badge'
import { DeviceStatusPill } from '@/components/manufacturing/StatusPill'

type PageProps = { params: { id: string } }

function formatDate(d: Date | string | null): string {
  if (!d) return '—'
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatDateTime(d: Date | string): string {
  return new Date(d).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

// The remaining spec §8.2 tabs beyond Overview/Status history/Tasks, each
// naming the roadmap week (§17) its real build lands — a visible stub beats a
// tab that silently pretends to be finished (same principle as ModuleLanding).
const STUB_TABS = [
  { value: 'components', label: 'Components',
    week: 'Week 4 (Aug 14) — component catalogue, units, and installation history' },
  { value: 'post_sales', label: 'Post-sales',
    week: 'Week 8 (Sep 11) — buyer, delivery orders, invoices, warranty' },
  { value: 'usage', label: 'Usage',
    week: 'Week 8 (Sep 11) — cumulative usage counter and log entries' },
  { value: 'repairs', label: 'Repairs',
    week: 'Week 7 (Sep 4) — 6-state repair workflow and sign-off' },
  { value: 'modifications', label: 'Modifications',
    week: 'Week 8 (Sep 11) — modification records and ECO-retrofit spawn' },
  { value: 'engineering', label: 'Engineering',
    week: 'Week 5 (Aug 21) — ECOs affecting this device, failure investigations' },
  { value: 'files', label: 'Files',
    week: 'Week 7 (Sep 4) — attachments pipeline, grouped by source' },
  { value: 'audit', label: 'Audit',
    week: 'Week 10 (Sep 27) — per-record fn_audit trail UI' },
] as const

/**
 * The device profile page (spec §8.2). getDevice's null return IS the 404 —
 * unknown or soft-deleted ids and permission denials both resolve to notFound()
 * so neither confirms whether a record exists (spec §7.3).
 *
 * Tasks tab renders <TaskPanel> from Task 12 completely unchanged; this route
 * MUST stay exactly /manufacturing/devices/[id] because entityHref (Task 12)
 * already assumes it for entityType 'device'.
 */
export default async function DeviceDetailPage({ params }: PageProps) {
  const actor = await requireActor()
  if (!can(actor, 'view_records', 'manufacturing')) notFound()

  const device = await getDevice(actor, params.id)
  if (!device) notFound()

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-slate-900">
            {device.deviceSn ?? device.legacySn ?? 'No serial'}
          </h1>
          <Badge variant="outline">{device.variantName}</Badge>
          <DeviceStatusPill status={device.status} label={device.statusLabel} />
          {device.needsDataReview && <Badge variant="warning">Needs review</Badge>}
        </div>
        {device.deviceSn && device.legacySn && (
          <p className="mt-1 text-sm text-muted-foreground">Legacy serial: {device.legacySn}</p>
        )}
      </div>

      <Tabs defaultValue="overview">
        <TabsList className="h-auto flex-wrap justify-start">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="status_history">Status history</TabsTrigger>
          <TabsTrigger value="tasks">Tasks</TabsTrigger>
          {STUB_TABS.map((t) => (
            <TabsTrigger key={t.value} value={t.value}>{t.label}</TabsTrigger>
          ))}
        </TabsList>

        <TabsContent value="overview">
          <dl className="grid grid-cols-1 gap-x-8 gap-y-4 rounded-md border p-4 sm:grid-cols-2">
            <Field label="Serial number" value={device.deviceSn ?? '—'} />
            <Field label="Legacy PCBA-A serial" value={device.legacySn ?? '—'} />
            <Field label="Product name" value={device.productName ?? '—'} />
            <Field label="Model no." value={device.modelNo ?? '—'} />
            <Field label="Customer" value={device.customer ?? '—'} />
            <Field label="Destination" value={device.destination ?? '—'} />
            <Field label="Phase" value={device.phase ?? '—'} />
            <Field label="Build date" value={formatDate(device.buildDate)} />
            <Field label="Ship date" value={formatDate(device.shipDate)} />
            <Field label="Delivered date" value={formatDate(device.deliveredDate)} />
            <div className="sm:col-span-2">
              <dt className="text-xs font-medium text-muted-foreground">Remarks</dt>
              <dd className="mt-0.5 whitespace-pre-wrap text-sm text-slate-900">
                {device.remarks ?? '—'}
              </dd>
            </div>
          </dl>
        </TabsContent>

        <TabsContent value="status_history">
          {device.statusHistory.length === 0 ? (
            <p className="rounded-md border p-4 text-sm text-muted-foreground">
              No status changes recorded.
            </p>
          ) : (
            <ol className="space-y-4 border-l pl-4">
              {device.statusHistory.map((h, i) => (
                <li key={i}>
                  <p className="text-sm font-medium text-slate-900">
                    {h.fromStatus ?? 'Created'} → {h.toStatus}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    {h.changedByName} · {formatDateTime(h.changedAt)}
                  </p>
                  {h.reason && <p className="mt-0.5 text-sm text-slate-700">{h.reason}</p>}
                </li>
              ))}
            </ol>
          )}
        </TabsContent>

        <TabsContent value="tasks">
          <TaskPanel entityType="device" entityId={device.id} module="manufacturing" />
        </TabsContent>

        {STUB_TABS.map((t) => (
          <TabsContent key={t.value} value={t.value}>
            <p className="inline-block rounded-md bg-slate-100 px-3 py-1 text-sm text-slate-500">
              {t.label} lands {t.week}.
            </p>
          </TabsContent>
        ))}
      </Tabs>
    </div>
  )
}

function Field({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-900">{value}</dd>
    </div>
  )
}
