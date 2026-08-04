import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import {
  getModification, listModificationTypeOptions, listEcoOptions, listDeviceRepairOptions,
} from '@/modules/maintenance/services/modificationService'
import {
  allowedNextModificationStatuses, modificationStatusLabel,
  isTerminalModificationStatus,
} from '@/modules/maintenance/domain/modificationStatus'
import { TaskPanel } from '@/components/tasks/TaskPanel'
import { ModificationStatusPill } from '@/components/maintenance/ModificationStatusPill'
import { ModificationStatusControl } from '@/components/maintenance/ModificationStatusControl'
import { ModificationSignOffButton } from '@/components/maintenance/ModificationSignOffButton'
import { ModificationEditForm } from '@/components/maintenance/ModificationEditForm'
import { DeviceStatusPill } from '@/components/manufacturing/StatusPill'
import { DeviceComponentsTab } from '@/components/manufacturing/DeviceComponentsTab'

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

/**
 * The modification detail page (spec §6.3) — the sibling of the repair detail
 * page. getModification's null return IS the 404: unknown/soft-deleted ids and
 * permission denials both resolve to notFound() so neither confirms whether a
 * record exists (spec §7.3).
 *
 * ═══ THE TWO CROSS-MODULE GATES, AND WHY BOTH ARE REQUIRED ═══
 *
 * Everything on this page except the two blocks below is Maintenance's own. The
 * exceptions reach into other modules, and BOTH of those services THROW on a
 * missing permission rather than returning empty — so an ungated call is a 500,
 * not a quietly hidden section:
 *
 *   * MANUFACTURING — the components panel. `componentService.getDeviceComponents`
 *     and `replaceComponentInstallation` are Manufacturing's, gated on
 *     Manufacturing's own permissions. Maintenance access alone does not imply
 *     Manufacturing access. This repeats the repair detail page's gate exactly,
 *     which is the carried finding that named this page before it existed.
 *   * ENGINEERING — the ECO option list, for the edit form's ECO link.
 *
 * The panel is rendered here with the MODIFICATION attached, so a swap performed
 * from inside a modification writes component_installation rows referencing it
 * (spec §5.4 / §14). The engineer performs one action and the system fans out —
 * no second dialog, and no way to leave "record the swap" as a separate chore
 * that gets skipped.
 */
export default async function ModificationDetailPage({ params }: PageProps) {
  const actor = await requireActor()
  if (!can(actor, 'view_records', 'maintenance')) notFound()

  const modification = await getModification(actor, params.id)
  if (!modification) notFound()

  // TWO conditions, not one. `edit_records` says the actor may edit A
  // modification; the terminal check says THIS one is still editable. The
  // sign-off dialog promises a closed record "cannot be reopened or edited
  // afterwards", and rendering an edit form beside that promise made it false —
  // a signed-off record's cost could be rewritten with no status-history row to
  // show it, since that log records status changes only. The real enforcement is
  // in updateModification (the action is directly callable); this only stops the
  // page offering what the server will refuse.
  const isTerminal = isTerminalModificationStatus(modification.status)
  const canEdit = can(actor, 'edit_records', 'maintenance') && !isTerminal
  const canSignOff = can(actor, 'sign_off_repairs', 'maintenance')
  const transitions = canEdit ? allowedNextModificationStatuses(modification.status) : []
  // `completed` is this record's awaiting_sign_off: the pure graph has no edge
  // into `closed`, so sign-off is the only route and it is offered only there.
  const showSignOff = canSignOff && modification.status === 'completed'

  const canViewComponents = can(actor, 'view_records', 'manufacturing')
  const canReplaceComponents = can(actor, 'edit_records', 'manufacturing')
  const canSeeEcos = can(actor, 'view_records', 'engineering')

  const [types, ecos, repairs] = await Promise.all([
    canEdit ? listModificationTypeOptions(actor) : Promise.resolve([]),
    canEdit && canSeeEcos ? listEcoOptions(actor) : Promise.resolve([]),
    canEdit ? listDeviceRepairOptions(actor, modification.deviceId) : Promise.resolve([]),
  ])

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-slate-900">{modification.modificationNo}</h1>
          <ModificationStatusPill status={modification.status} />
          <Link
            href={`/manufacturing/devices/${modification.deviceId}`}
            className="ml-auto text-sm font-medium text-primary hover:underline"
          >
            {modification.deviceSn ?? 'View device'} →
          </Link>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>Device status:</span>
          <DeviceStatusPill
            status={modification.deviceStatus}
            label={modification.deviceStatusLabel}
          />
          <span className="text-xs">(a modification does not change it)</span>
        </div>

        {canEdit && (
          <div className="mt-3">
            <ModificationStatusControl
              modificationId={modification.id}
              version={modification.version}
              currentStatus={modification.status}
              transitions={transitions}
            />
          </div>
        )}
        {showSignOff && (
          <div className="mt-3">
            <ModificationSignOffButton
              modificationId={modification.id}
              version={modification.version}
            />
          </div>
        )}
      </div>

      {isTerminal && can(actor, 'edit_records', 'maintenance') && (
        // Says WHY the edit control is gone. Silently removing it from a record
        // that had one yesterday reads as a permissions bug.
        <p className="rounded-md border bg-muted/50 px-3 py-2 text-sm text-muted-foreground">
          This modification is {modificationStatusLabel(modification.status).toLowerCase()} and can
          no longer be edited. Its details are the record of what was accepted.
        </p>
      )}

      {canEdit && (
        <ModificationEditForm
          key={modification.version}
          modificationId={modification.id}
          version={modification.version}
          types={types}
          ecos={ecos}
          repairs={repairs}
          initial={{
            modificationTypeId: modification.typeId,
            reason: modification.reason,
            description: modification.description,
            previousConfiguration: modification.previousConfiguration,
            newConfiguration: modification.newConfiguration,
            // The TEXT projections, not the Date fields — a date input seeded
            // from a local-midnight Date walks backwards a day on a UTC+ host.
            requestedOn: modification.requestedOnText,
            completedOn: modification.completedOnText,
            ecoId: modification.ecoId,
            repairId: modification.repairId,
            costSgd: modification.costSgd,
          }}
        />
      )}

      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 rounded-md border p-4 sm:grid-cols-2">
        <Field label="Type" value={modification.typeName} />
        <Field label="Cost (SGD)" value={modification.costSgd} />
        <Field label="Reason" value={modification.reason} span />
        <Field label="Description" value={modification.description} span />
        <Field label="Previous configuration" value={modification.previousConfiguration} span />
        <Field label="New configuration" value={modification.newConfiguration} span />
        <Field label="Requested on" value={formatDate(modification.requestedOn)} />
        <Field label="Completed on" value={formatDate(modification.completedOn)} />
        <Field label="Requested by" value={modification.requestedByName} />
        <Field label="Approved by" value={modification.approvedByName} />
        <Field label="Completed by" value={modification.completedByName} />
        <Field label="Raised" value={formatDateTime(modification.createdAt)} />
        {modification.ecoNo && (
          <Field label="ECO retrofitted" value={modification.ecoNo} />
        )}
        {modification.repairId && (
          <div>
            <dt className="text-xs font-medium text-muted-foreground">Arose from repair</dt>
            <dd className="mt-0.5 text-sm">
              <Link
                href={`/maintenance/repairs/${modification.repairId}`}
                className="font-medium text-primary hover:underline"
              >
                {modification.repairNo}
              </Link>
            </dd>
          </div>
        )}
        {modification.signedOffAt && (
          <Field
            label="Signed off"
            value={`${modification.signedOffByName ?? 'Unknown'} · ${formatDateTime(modification.signedOffAt)}`}
            span
          />
        )}
        {modification.closedAt && !modification.signedOffAt && (
          <Field label="Closed" value={formatDateTime(modification.closedAt)} span />
        )}
      </dl>

      {/*
        Spec §5.4/§14 — the replacement primitive, with THIS modification
        attached, so every component swap it causes is attributable to it. See
        this page's header for why the gate is not optional.
      */}
      {canViewComponents && (
        <div>
          <h2 className="mb-2 text-sm font-semibold text-slate-900">Device components</h2>
          <DeviceComponentsTab
            deviceId={modification.deviceId}
            canEdit={canReplaceComponents}
            attribution={{
              modificationId: modification.id,
              label: modification.modificationNo,
            }}
          />
        </div>
      )}

      <div>
        <h2 className="mb-2 text-sm font-semibold text-slate-900">Status history</h2>
        {modification.statusHistory.length === 0 ? (
          <p className="rounded-md border p-4 text-sm text-muted-foreground">
            No status changes recorded.
          </p>
        ) : (
          <ol className="space-y-4 border-l pl-4">
            {modification.statusHistory.map((h, i) => (
              <li key={i}>
                <p className="text-sm font-medium text-slate-900">
                  {h.fromStatus ? modificationStatusLabel(h.fromStatus) : 'Raised'}
                  {' → '}
                  {modificationStatusLabel(h.toStatus)}
                </p>
                <p className="text-xs text-muted-foreground">
                  {h.changedByName} · {formatDateTime(h.changedAt)}
                </p>
                {h.note && <p className="mt-0.5 text-sm text-slate-700">{h.note}</p>}
              </li>
            ))}
          </ol>
        )}
      </div>

      <TaskPanel entityType="modification" entityId={modification.id} module="maintenance" />
    </div>
  )
}

function Field({ label, value, span }: { label: string; value: string | null; span?: boolean }) {
  return (
    <div className={span ? 'sm:col-span-2' : undefined}>
      <dt className="text-xs font-medium text-muted-foreground">{label}</dt>
      <dd className="mt-0.5 whitespace-pre-wrap text-sm text-slate-900">{value ?? '—'}</dd>
    </div>
  )
}
