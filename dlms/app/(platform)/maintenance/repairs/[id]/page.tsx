import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import {
  getRepair, getRepairSignOffApprovalState,
} from '@/modules/maintenance/services/repairService'
import { allowedNextRepairStatuses, repairStatusLabel } from '@/modules/maintenance/domain/repairStatus'
import { requestRepairSignOffApprovalAction } from '@/app/(platform)/maintenance/repairs/actions'
import { ApprovalRequestPanel } from '@/components/platform/ApprovalRequestPanel'
import { TaskPanel } from '@/components/tasks/TaskPanel'
import { RepairStatusPill } from '@/components/maintenance/RepairStatusPill'
import { RepairStatusControl } from '@/components/maintenance/RepairStatusControl'
import { RepairSignOffButton } from '@/components/maintenance/RepairSignOffButton'
import { RepairEditForm } from '@/components/maintenance/RepairEditForm'
import { DeviceStatusPill } from '@/components/manufacturing/StatusPill'
import { DeviceComponentsTab } from '@/components/manufacturing/DeviceComponentsTab'

type PageProps = { params: { id: string } }

function formatDateTime(d: Date | string): string {
  return new Date(d).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

/**
 * The repair detail page (spec §5.3). getRepair's null return IS the 404 —
 * unknown/soft-deleted ids and permission denials both resolve to notFound() so
 * neither confirms whether a record exists (spec §7.3).
 */
export default async function RepairDetailPage({ params }: PageProps) {
  const actor = await requireActor()
  if (!can(actor, 'view_records', 'maintenance')) notFound()

  const repair = await getRepair(actor, params.id)
  if (!repair) notFound()

  const canEdit = can(actor, 'edit_records', 'maintenance')
  const canSignOff = can(actor, 'sign_off_repairs', 'maintenance')
  const transitions = canEdit ? allowedNextRepairStatuses(repair.status) : []
  const showSignOff = canSignOff && repair.status === 'awaiting_sign_off'

  // THIS PAGE DID NOT CALL getRepairSignOffApprovalState AT ALL, which made a
  // drift refusal invisible: a signer met it only as the failure of the Sign off
  // click, on a screen that had said nothing about an approval existing. Now the
  // state has a surface, and — see the panel — the signer sees it even without
  // `edit_records`, because they are the person the gate is about to stop.
  const approvalState = await getRepairSignOffApprovalState(actor, repair.id)

  // The components panel reads and writes MANUFACTURING's component registry,
  // under manufacturing's own permissions — a maintenance-only user simply does
  // not see it (its services throw rather than degrade, so this is a gate, not
  // a style choice).
  const canViewComponents = can(actor, 'view_records', 'manufacturing')
  const canReplaceComponents = can(actor, 'edit_records', 'manufacturing')

  // The same facts evaluateSignOff decides on, in the same order — this only
  // spares a doomed round-trip; signOffRepair re-reads them under its own lock.
  const signOffBlockedReason = !repair.testingNotes?.trim()
    ? 'Record testing notes before signing off.'
    : repair.partsReplaced && repair.recordedReplacementCount === 0
      ? 'This repair says parts were replaced, but no component change references it. '
        + 'Replace the component below, or clear the parts-replaced claim.'
      : null

  return (
    <div className="space-y-6">
      <div>
        <div className="flex flex-wrap items-center gap-3">
          <h1 className="text-2xl font-semibold text-slate-900">{repair.repairNo}</h1>
          <RepairStatusPill status={repair.status} />
          <Link
            href={`/manufacturing/devices/${repair.deviceId}`}
            className="ml-auto text-sm font-medium text-primary hover:underline"
          >
            {repair.deviceSn ?? 'View device'} →
          </Link>
        </div>
        <div className="mt-2 flex flex-wrap items-center gap-2 text-sm text-muted-foreground">
          <span>Device status:</span>
          <DeviceStatusPill status={repair.deviceStatus} label={repair.deviceStatusLabel} />
        </div>

        {canEdit && (
          <div className="mt-3">
            <RepairStatusControl
              repairId={repair.id}
              version={repair.version}
              currentStatus={repair.status}
              transitions={transitions}
            />
          </div>
        )}
        {showSignOff && (
          <div className="mt-3">
            <RepairSignOffButton
              repairId={repair.id}
              version={repair.version}
              blockedReason={signOffBlockedReason}
            />
          </div>
        )}
      </div>

      {/*
        Immediately under the Sign off button on purpose: the drift refusal this
        surfaces is a refusal of THAT button, and an explanation placed further
        down the page than the control it explains is one the user reads after
        they have already been refused.
      */}
      {approvalState && (
        <ApprovalRequestPanel
          subject="repair"
          gatedAct="signed off"
          canRequest={canEdit}
          requestable={approvalState.requestable}
          requestableReason={approvalState.requestableReason}
          approval={approvalState.approval && {
            status: approvalState.approval.status,
            requestedByName: approvalState.approval.requestedByName,
            requestedAt: approvalState.approval.requestedAt.toISOString(),
            decidedByName: approvalState.approval.decidedByName,
            decidedAt: approvalState.approval.decidedAt?.toISOString() ?? null,
            decisionNote: approvalState.approval.decisionNote,
          }}
          drift={approvalState.drift}
          requestInput={{ repairId: repair.id, version: repair.version }}
          requestAction={requestRepairSignOffApprovalAction}
        />
      )}

      {canEdit && (
        <RepairEditForm
          repairId={repair.id}
          version={repair.version}
          initial={{
            faultDescription: repair.faultDescription,
            diagnosis: repair.diagnosis,
            correctiveAction: repair.correctiveAction,
            testingNotes: repair.testingNotes,
            warrantyFlag: repair.warrantyFlag,
            warrantyJustification: repair.warrantyJustification,
            costSgd: repair.costSgd,
            partsReplaced: repair.partsReplaced,
          }}
        />
      )}

      <dl className="grid grid-cols-1 gap-x-8 gap-y-4 rounded-md border p-4 sm:grid-cols-2">
        <Field label="Reported fault" value={repair.faultDescription} span />
        <Field label="Diagnosis" value={repair.diagnosis} span />
        <Field label="Corrective action" value={repair.correctiveAction} span />
        <Field label="Testing notes" value={repair.testingNotes} span />
        <Field label="Warranty" value={repair.warrantyFlag ? 'Covered' : 'Not covered'} />
        <Field label="Cost (SGD)" value={repair.costSgd} />
        <Field
          label="Parts replaced"
          value={repair.partsReplaced
            ? `Yes — ${repair.recordedReplacementCount} component record(s) reference this repair`
            : 'No'}
          span
        />
        {repair.warrantyFlag && (
          <Field label="Warranty justification" value={repair.warrantyJustification} span />
        )}
        <Field label="Reported by" value={repair.reportedByName} />
        <Field label="Assigned to" value={repair.assignedToName} />
        <Field label="Opened" value={formatDateTime(repair.openedAt)} />
        <Field label="Closed" value={repair.closedAt ? formatDateTime(repair.closedAt) : null} />
        {repair.signedOffAt && (
          <Field
            label="Signed off"
            value={`${repair.signedOffByName ?? 'Unknown'} · ${formatDateTime(repair.signedOffAt)}`}
            span
          />
        )}
      </dl>

      {/*
        Spec §5.4 — the engineer performs ONE action and the system fans out.
        This is the device profile's own replacement control, rendered here with
        the repair attached, so a swap done from inside the repair writes
        component_installation rows that reference it. No second dialog, no
        double entry, and no way to "record the swap" as a separate chore that
        gets skipped.
      */}
      {canViewComponents && (
        <div>
          <h2 className="mb-2 text-sm font-semibold text-slate-900">
            Device components
          </h2>
          <DeviceComponentsTab
            deviceId={repair.deviceId}
            canEdit={canReplaceComponents}
            attribution={{ repairId: repair.id, label: repair.repairNo }}
          />
        </div>
      )}

      <div>
        <h2 className="mb-2 text-sm font-semibold text-slate-900">Status history</h2>
        {repair.statusHistory.length === 0 ? (
          <p className="rounded-md border p-4 text-sm text-muted-foreground">
            No status changes recorded.
          </p>
        ) : (
          <ol className="space-y-4 border-l pl-4">
            {repair.statusHistory.map((h, i) => (
              <li key={i}>
                <p className="text-sm font-medium text-slate-900">
                  {h.fromStatus ? repairStatusLabel(h.fromStatus) : 'Opened'} → {repairStatusLabel(h.toStatus)}
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

      <TaskPanel entityType="repair" entityId={repair.id} module="maintenance" />
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
