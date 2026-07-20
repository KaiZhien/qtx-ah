import { notFound } from 'next/navigation'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { getEcr } from '@/modules/engineering/services/engineeringReadService'
import { nextEcrStatuses } from '@/modules/engineering/domain/ecrStatus'
import { changeEcrStatusAction } from '@/app/(platform)/engineering/ecr/ecrActions'
import { EngStatusControl } from '@/components/engineering/EngStatusControl'
import { EngStatusBadge, PriorityBadge } from '@/components/engineering/EngStatusBadge'
import { TaskPanel } from '@/components/tasks/TaskPanel'

type PageProps = { params: { id: string } }

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const fmtDate = (d: Date | string | null) =>
  d ? new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'

/**
 * ECR detail (spec §4/§8.2). getEcr's null return IS the 404 — unknown/soft-
 * deleted ids and permission denials both resolve to notFound() so neither
 * confirms a record exists (spec §7.3). Only legal onward statuses (from the
 * pure domain) are offered; the server re-validates the move.
 */
export default async function EcrDetailPage({ params }: PageProps) {
  const actor = await requireActor()
  if (!can(actor, 'view_records', 'engineering')) notFound()

  const ecr = await getEcr(actor, params.id)
  if (!ecr) notFound()

  const canEdit = can(actor, 'edit_records', 'engineering')
  const statusOptions = canEdit
    ? nextEcrStatuses(ecr.status).map((s) => ({ value: s, label: cap(s) }))
    : []

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-slate-900">{ecr.ecrNo}</h1>
          <EngStatusBadge status={ecr.status} />
          <PriorityBadge priority={ecr.priority} />
        </div>
        <p className="mt-1 text-slate-700">{ecr.title}</p>
        {canEdit && statusOptions.length > 0 && (
          <div className="mt-3">
            <EngStatusControl
              id={ecr.id} version={ecr.version} currentLabel={cap(ecr.status)}
              options={statusOptions} changeAction={changeEcrStatusAction}
            />
          </div>
        )}
      </div>

      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 rounded-md border p-4 sm:grid-cols-2">
        <Field label="Affected variant" value={ecr.variantName ?? '—'} />
        <Field label="Affected device" value={ecr.deviceLabel ?? '—'} />
        <Field label="Created by" value={ecr.createdByName} />
        <Field label="Created" value={fmtDate(ecr.createdAt)} />
        <div className="sm:col-span-2">
          <dt className="text-xs font-medium text-muted-foreground">Reason</dt>
          <dd className="mt-0.5 whitespace-pre-wrap text-sm text-slate-900">{ecr.reason ?? '—'}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs font-medium text-muted-foreground">Description</dt>
          <dd className="mt-0.5 whitespace-pre-wrap text-sm text-slate-900">{ecr.description ?? '—'}</dd>
        </div>
      </dl>

      <TaskPanel entityType="ecr" entityId={ecr.id} module="engineering" />
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
