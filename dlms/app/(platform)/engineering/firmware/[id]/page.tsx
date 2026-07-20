import { notFound } from 'next/navigation'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { getFirmwareRelease } from '@/modules/engineering/services/engineeringReadService'
import { nextFirmwareStatuses } from '@/modules/engineering/domain/firmwareStatus'
import { changeFirmwareStatusAction } from '@/app/(platform)/engineering/firmware/firmwareActions'
import { EngStatusControl } from '@/components/engineering/EngStatusControl'
import { EngStatusBadge } from '@/components/engineering/EngStatusBadge'
import { TaskPanel } from '@/components/tasks/TaskPanel'

type PageProps = { params: { id: string } }

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const fmtDate = (d: Date | string | null) =>
  d ? new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'

/** Firmware release detail (spec §6.3). null → 404 (spec §7.3). */
export default async function FirmwareDetailPage({ params }: PageProps) {
  const actor = await requireActor()
  if (!can(actor, 'view_records', 'engineering')) notFound()

  const fw = await getFirmwareRelease(actor, params.id)
  if (!fw) notFound()

  const canEdit = can(actor, 'edit_records', 'engineering')
  const statusOptions = canEdit
    ? nextFirmwareStatuses(fw.status).map((s) => ({ value: s, label: cap(s) }))
    : []

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-slate-900">{fw.fwVersion}</h1>
          <EngStatusBadge status={fw.status} />
        </div>
        <p className="mt-1 text-slate-700">{fw.componentTypeName}</p>
        {canEdit && statusOptions.length > 0 && (
          <div className="mt-3">
            <EngStatusControl
              id={fw.id} version={fw.version} currentLabel={cap(fw.status)}
              options={statusOptions} changeAction={changeFirmwareStatusAction}
            />
          </div>
        )}
      </div>

      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 rounded-md border p-4 sm:grid-cols-2">
        <Field label="Component type" value={`${fw.componentTypeName} (${fw.componentTypeCode})`} />
        <Field label="Version" value={fw.fwVersion} />
        <Field label="Release date" value={fmtDate(fw.releaseDate)} />
        <Field label="Created by" value={fw.createdByName} />
        <div className="sm:col-span-2">
          <dt className="text-xs font-medium text-muted-foreground">Changelog / notes</dt>
          <dd className="mt-0.5 whitespace-pre-wrap text-sm text-slate-900">{fw.changelog ?? '—'}</dd>
        </div>
      </dl>

      <TaskPanel entityType="firmware_release" entityId={fw.id} module="engineering" />
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
