import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { getEco } from '@/modules/engineering/services/engineeringReadService'
import { nextEcoStatuses } from '@/modules/engineering/domain/ecoStatus'
import { changeEcoStatusAction } from '@/app/(platform)/engineering/eco/ecoActions'
import { EngStatusControl } from '@/components/engineering/EngStatusControl'
import { EngStatusBadge } from '@/components/engineering/EngStatusBadge'
import { EcoEffectivityPanel } from '@/components/engineering/EcoEffectivityPanel'
import { TaskPanel } from '@/components/tasks/TaskPanel'

type PageProps = { params: { id: string } }

const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1)
const fmtDate = (d: Date | string | null) =>
  d ? new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '—'

/**
 * ECO detail (spec §4/§8.2). null → 404 (spec §7.3). The submitted→approved
 * option is still offered by the domain to any editor; the server action's
 * second authorize(approve_requests) is what actually gates it, so an operator
 * who lacks it gets a friendly permission error rather than a hidden control
 * that lies about what they can do.
 */
export default async function EcoDetailPage({ params }: PageProps) {
  const actor = await requireActor()
  if (!can(actor, 'view_records', 'engineering')) notFound()

  const eco = await getEco(actor, params.id)
  if (!eco) notFound()

  const canEdit = can(actor, 'edit_records', 'engineering')
  const statusOptions = canEdit
    ? nextEcoStatuses(eco.status).map((s) => ({ value: s, label: cap(s) }))
    : []

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-slate-900">{eco.ecoNo}</h1>
          <EngStatusBadge status={eco.status} />
        </div>
        <p className="mt-1 text-slate-700">{eco.title}</p>
        {canEdit && statusOptions.length > 0 && (
          <div className="mt-3">
            <EngStatusControl
              id={eco.id} version={eco.version} currentLabel={cap(eco.status)}
              options={statusOptions} changeAction={changeEcoStatusAction}
            />
          </div>
        )}
      </div>

      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 rounded-md border p-4 sm:grid-cols-2">
        <div>
          <dt className="text-xs font-medium text-muted-foreground">Realises change request</dt>
          <dd className="mt-0.5 text-sm text-slate-900">
            {eco.ecrId && eco.ecrNo
              ? <Link href={`/engineering/ecr/${eco.ecrId}`} className="text-primary hover:underline">{eco.ecrNo}</Link>
              : '—'}
          </dd>
        </div>
        <Field label="Created by" value={eco.createdByName} />
        <Field label="Effectivity date" value={fmtDate(eco.effectivityDate)} />
        <Field label="Effectivity serial" value={eco.effectivitySerial ?? '—'} />
        <div className="sm:col-span-2">
          <dt className="text-xs font-medium text-muted-foreground">Description</dt>
          <dd className="mt-0.5 whitespace-pre-wrap text-sm text-slate-900">{eco.description ?? '—'}</dd>
        </div>
        <div className="sm:col-span-2">
          <dt className="text-xs font-medium text-muted-foreground">Effectivity notes</dt>
          <dd className="mt-0.5 whitespace-pre-wrap text-sm text-slate-900">{eco.effectivityNotes ?? '—'}</dd>
        </div>
      </dl>

      <EcoEffectivityPanel
        ecoId={eco.id} status={eco.status}
        effectivityDate={eco.effectivityDate} effectivitySerial={eco.effectivitySerial}
      />

      <TaskPanel entityType="eco" entityId={eco.id} module="engineering" />
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
