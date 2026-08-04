'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ShieldCheck, ShieldAlert, Clock, XCircle, ShieldQuestion } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { callFailed } from '@/components/platform/callFailed'
import {
  approvalStatusLabel, type ApprovalStatus,
} from '@/modules/shared/approvals/domain/approvalDecision'
import {
  approvalRequestAvailability,
} from '@/modules/shared/approvals/domain/approvalRequestAvailability'

export type ApprovalPanelApproval = {
  status: ApprovalStatus
  requestedByName: string | null
  requestedAt: string
  decidedByName: string | null
  decidedAt: string | null
  decisionNote: string | null
}

type ActionResult = { ok: true; data: { approvalId: string } } | { ok: false; error: string }

type Props<I> = {
  /** How the copy names the record: "change order", "repair". Lower case, no article. */
  subject: string
  /** What the approval GATES, phrased for the sentence "…before it can be X". */
  gatedAct: string
  /** The requester's own permission (`edit_records`), resolved by the server page. */
  canRequest: boolean
  /** Whether the record's status admits a request — from the service, never re-derived. */
  requestable: boolean
  /** The sentence that decision built, verbatim. */
  requestableReason: string | null
  approval: ApprovalPanelApproval | null
  /** Non-empty only when an APPROVED snapshot no longer describes the record. */
  drift: string[]
  /** Exactly what the action wants; passed straight through, so no key-name adapter. */
  requestInput: I
  requestAction: (input: I) => Promise<ActionResult>
}

function when(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

/**
 * The approval state of one ECO or one repair, and the control that asks for one.
 *
 * MODELLED ON InvoiceApprovalPanel, WITH ONE DELIBERATE DIFFERENCE, and it is the
 * difference that matters most on this screen. Finance renders NOTHING below its
 * threshold, because an invoice the gate does not apply to must not grow a panel
 * explaining a rule it is not subject to. ECO and repair have no threshold and no
 * equivalent — nothing in the schema says WHEN one of them needs a second pair of
 * eyes — so approval here is never automatic and never mandatory. The posture is
 * "requested ⇒ binding": a record nobody raised a request for behaves exactly as
 * it did before, and this panel is the ability to ask, not a requirement to.
 *
 * The copy has to carry that, because a panel headed "Approval required" on an
 * ECO that requires no approval would be a lie the code does not tell.
 *
 * WHY IT IS ONE COMPONENT AND NOT TWO. Everything below except three strings and
 * the action is identical for the two consumers, and the gating rule is shared and
 * pure (`approvalRequestAvailability`). The server action arrives as a prop, which
 * is the same shape `EngStatusControl` already uses for `changeAction`.
 *
 * THE DRIFT WARNING IS SHOWN HERE, next to the record, rather than only as the
 * refusal that comes back from the gated act. On the repair page that is a
 * genuine repair of a dead end: before this panel existed the page did not call
 * `getRepairSignOffApprovalState` at all, so a signer met the drift refusal at
 * the moment they clicked Sign off, with — until this branch also fixed the
 * mapping — no explanation attached to it.
 */
export function ApprovalRequestPanel<I>({
  subject, gatedAct, canRequest, requestable, requestableReason,
  approval, drift, requestInput, requestAction,
}: Props<I>) {
  const router = useRouter()
  const [submitting, setSubmitting] = useState(false)

  const drifted = approval?.status === 'approved' && drift.length > 0

  // Nothing has been asked and this reader cannot ask: the panel would be a
  // paragraph about a rule that does not apply and a control they cannot use.
  // Anyone who CAN see an existing request still sees it, including a signer who
  // holds sign_off_repairs but not edit_records — otherwise the one person the
  // gate is about to stop is the one person it does not explain itself to.
  if (!approval && !canRequest) return null

  const availability = approvalRequestAvailability({
    requestable, requestableReason, approvalStatus: approval?.status ?? null, drifted,
  })

  async function handleRequest() {
    setSubmitting(true)
    try {
      const res = await requestAction(requestInput)
      if (!res.ok) { toast.error(res.error); return }
      toast.success('Sent for approval')
      router.refresh()
    } catch (err) {
      // The action itself never throws; the INVOCATION can — a dropped
      // connection, a stale action id after a redeploy, a session that expired on
      // a tab left open overnight. Uncaught, that rejection escalates to the
      // error boundary and replaces the page.
      toast.error(callFailed('request approval', err))
    } finally {
      setSubmitting(false)
    }
  }

  const tone = drifted || approval?.status === 'rejected'
    ? 'border-destructive/40 bg-destructive/5'
    : approval?.status === 'approved'
      ? 'border-emerald-300 bg-emerald-50'
      : approval?.status === 'pending'
        ? 'border-amber-300 bg-amber-50'
        : 'border-slate-200 bg-slate-50'

  return (
    <section className={`rounded-md border p-4 ${tone}`} aria-label="Approval">
      <div className="flex flex-wrap items-start gap-3">
        <Icon status={approval?.status ?? null} drifted={drifted} />
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="text-sm font-semibold text-slate-900">
            {approval ? `Approval ${approvalStatusLabel(approval.status).toLowerCase()}` : 'No approval requested'}
          </h2>

          {!approval && (
            <p className="text-sm text-slate-700">
              This {subject} does not need an approval. If you want a second pair of eyes before
              it is {gatedAct}, request one — once requested, it becomes binding and the {subject}{' '}
              cannot be {gatedAct} until it is approved.
            </p>
          )}

          {approval?.status === 'pending' && (
            <p className="text-sm text-slate-700">
              Requested by {approval.requestedByName ?? 'someone'} on {when(approval.requestedAt)}.
              Waiting on a decision — nobody may decide their own request.
            </p>
          )}

          {approval?.status === 'approved' && !drifted && (
            <p className="text-sm text-slate-700">
              Approved by {approval.decidedByName ?? 'someone'} on {when(approval.decidedAt)}.
              {approval.decisionNote ? ` “${approval.decisionNote}”` : ''}
            </p>
          )}

          {approval?.status === 'approved' && drifted && (
            <div className="space-y-1 text-sm text-slate-700">
              <p>
                Approved by {approval.decidedByName ?? 'someone'} on {when(approval.decidedAt)},
                but this {subject} has changed since. Going ahead now would ride an approval
                nobody granted, so it is blocked until a fresh one is requested:
              </p>
              <ul className="list-disc pl-5 font-mono text-xs">
                {drift.map((line) => <li key={line}>{line}</li>)}
              </ul>
            </div>
          )}

          {approval?.status === 'rejected' && (
            <p className="text-sm text-slate-700">
              Rejected by {approval.decidedByName ?? 'someone'} on {when(approval.decidedAt)}
              {approval.decisionNote ? `: “${approval.decisionNote}”` : ''}. A rejected request is
              never reopened — change what was asked for and request approval again.
            </p>
          )}

          {/*
            THE HOUSE RULE: do not offer a control the write will refuse. When a
            request cannot be raised in this state the button stays visible and
            DISABLED with the reason underneath, rather than vanishing — a control
            that disappears teaches nothing, and the reason is the service's own
            sentence, so it says exactly what the write would have said.
          */}
          {canRequest && !availability.canRequest && (
            <p className="pt-1 text-xs text-muted-foreground">{availability.reason}</p>
          )}
        </div>

        {canRequest && (
          <Button
            type="button"
            onClick={handleRequest}
            disabled={submitting || !availability.canRequest}
          >
            {submitting ? 'Sending…' : availability.canRequest ? availability.label : 'Request approval'}
          </Button>
        )}
      </div>
    </section>
  )
}

function Icon({ status, drifted }: { status: ApprovalStatus | null; drifted: boolean }) {
  const cls = 'mt-0.5 h-5 w-5 shrink-0'
  if (drifted) return <ShieldAlert className={`${cls} text-destructive`} aria-hidden="true" />
  if (status === 'approved') return <ShieldCheck className={`${cls} text-emerald-600`} aria-hidden="true" />
  if (status === 'rejected') return <XCircle className={`${cls} text-destructive`} aria-hidden="true" />
  if (status === 'pending') return <Clock className={`${cls} text-amber-600`} aria-hidden="true" />
  // Deliberately NOT the amber warning Finance uses for its no-approval case:
  // there, no approval on an above-threshold invoice is a problem. Here it is the
  // ordinary state of almost every record.
  return <ShieldQuestion className={`${cls} text-slate-400`} aria-hidden="true" />
}
