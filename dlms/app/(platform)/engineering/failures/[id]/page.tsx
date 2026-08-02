import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import {
  getFailure, listFailureStatusHistory, listEscalationEcoOptions,
} from '@/modules/engineering/services/failureService'
import {
  nextFailureStatuses, failureStatusLabel, isTerminalFailureStatus,
} from '@/modules/engineering/domain/failureStatus'
import { FailureStatusBadge, SeverityBadge } from '@/components/engineering/FailureBadges'
import { FailureStatusControl } from '@/components/engineering/FailureStatusControl'
import { FailureFindingsForm } from '@/components/engineering/FailureFindingsForm'
import { EscalateFailureControl } from '@/components/engineering/EscalateFailureControl'
import { TaskPanel } from '@/components/tasks/TaskPanel'

type PageProps = { params: { id: string } }

const fmtDateTime = (d: Date | string | null) =>
  d ? new Date(d).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  }) : '—'

/**
 * Failure-investigation detail. null → 404 (spec §7.3).
 *
 * The legal status targets come from the pure domain, so only reachable moves
 * are offered — but the server re-evaluates the SAME graph AND its preconditions
 * under the row lock, so a stale option can never force an illegal transition or
 * a close with no root cause on record.
 */
export default async function FailureDetailPage({ params }: PageProps) {
  const actor = await requireActor()
  if (!can(actor, 'view_records', 'engineering')) notFound()

  const failure = await getFailure(actor, params.id)
  if (!failure) notFound()

  const canEdit = can(actor, 'edit_records', 'engineering')
  const history = await listFailureStatusHistory(actor, failure.id)
  const statusOptions = canEdit
    ? nextFailureStatuses(failure.status).map((s) => ({ value: s, label: failureStatusLabel(s) }))
    : []

  // The escalation control only makes sense while the investigation is live and
  // not already escalated; the ECO picker is only loaded when it will render.
  const canEscalate = canEdit && !failure.ecoId && !isTerminalFailureStatus(failure.status)
  const ecoOptions = canEscalate ? await listEscalationEcoOptions(actor) : []

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-slate-900">{failure.fiNo}</h1>
          <FailureStatusBadge status={failure.status} />
          <SeverityBadge severity={failure.severity} />
        </div>
        <p className="mt-1 text-slate-700">{failure.title}</p>
        {statusOptions.length > 0 && (
          <div className="mt-3">
            <FailureStatusControl
              id={failure.id} version={failure.version}
              currentLabel={failure.statusLabel} options={statusOptions}
            />
          </div>
        )}
      </div>

      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 rounded-md border p-4 sm:grid-cols-2">
        <div>
          <dt className="text-xs font-medium text-muted-foreground">Device</dt>
          <dd className="mt-0.5 text-sm text-slate-900">
            {failure.deviceId && failure.deviceLabel
              ? <Link href={`/manufacturing/devices/${failure.deviceId}`} className="text-primary hover:underline">{failure.deviceLabel}</Link>
              : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-muted-foreground">Raised from repair</dt>
          <dd className="mt-0.5 text-sm text-slate-900">
            {failure.repairId && failure.repairNo
              ? <Link href={`/maintenance/repairs/${failure.repairId}`} className="text-primary hover:underline">{failure.repairNo}</Link>
              : '—'}
          </dd>
        </div>
        <div>
          <dt className="text-xs font-medium text-muted-foreground">Escalated to</dt>
          <dd className="mt-0.5 text-sm text-slate-900">
            {failure.ecoId && failure.ecoNo
              ? <Link href={`/engineering/eco/${failure.ecoId}`} className="text-primary hover:underline">{failure.ecoNo}</Link>
              : '—'}
          </dd>
        </div>
        <Field label="Reported by" value={failure.reportedByName ?? failure.createdByName} />
        <Field label="Assigned to" value={failure.assignedToName ?? '—'} />
        <Field label="Opened" value={fmtDateTime(failure.openedAt)} />
        <Field label="Closed" value={fmtDateTime(failure.closedAt)} />
        <div className="sm:col-span-2">
          <dt className="text-xs font-medium text-muted-foreground">Description</dt>
          <dd className="mt-0.5 whitespace-pre-wrap text-sm text-slate-900">
            {failure.description ?? '—'}
          </dd>
        </div>
      </dl>

      {canEdit ? (
        <FailureFindingsForm
          id={failure.id} version={failure.version}
          containment={failure.containment} rootCause={failure.rootCause}
          correctiveAction={failure.correctiveAction}
        />
      ) : (
        <dl className="grid grid-cols-1 gap-4 rounded-md border p-4">
          <ReadOnlyField label="Containment" value={failure.containment} />
          <ReadOnlyField label="Root cause" value={failure.rootCause} />
          <ReadOnlyField label="Corrective action" value={failure.correctiveAction} />
        </dl>
      )}

      {canEscalate && (
        <EscalateFailureControl
          id={failure.id} version={failure.version} ecoOptions={ecoOptions}
        />
      )}

      <div className="rounded-md border">
        <h2 className="border-b px-4 py-3 text-sm font-medium text-slate-900">Status history</h2>
        {history.length === 0 ? (
          <p className="p-4 text-sm text-muted-foreground">No status changes yet.</p>
        ) : (
          <ul className="divide-y">
            {history.map((h) => (
              <li key={h.id} className="flex flex-wrap items-baseline gap-x-2 px-4 py-3 text-sm">
                <span className="text-slate-900">
                  {h.fromLabel ? `${h.fromLabel} → ${h.toLabel}` : `Opened as ${h.toLabel}`}
                </span>
                <span className="text-muted-foreground">{h.changedByName}</span>
                <span className="text-muted-foreground">{fmtDateTime(h.changedAt)}</span>
                {h.note && <span className="w-full text-muted-foreground">“{h.note}”</span>}
              </li>
            ))}
          </ul>
        )}
      </div>

      <TaskPanel entityType="failure_investigation" entityId={failure.id} module="engineering" />
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

function ReadOnlyField({ label, value }: { label: string; value: string | null }) {
  return (
    <div>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 whitespace-pre-wrap text-sm text-slate-900">{value ?? '—'}</dd>
    </div>
  )
}
