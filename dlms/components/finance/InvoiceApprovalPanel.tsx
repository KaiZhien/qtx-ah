'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { ShieldCheck, ShieldAlert, Clock, XCircle } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { requestInvoiceApprovalAction } from '@/app/(platform)/finance/invoices/invoiceWriteActions'
import { approvalStatusLabel, type ApprovalStatus } from '@/modules/shared/approvals/domain/approvalDecision'
import type { InvoiceStatus } from '@/modules/finance/domain/invoiceStatus'

export type InvoiceApprovalPanelApproval = {
  status: ApprovalStatus
  requestedByName: string | null
  requestedAt: string
  decidedByName: string | null
  decidedAt: string | null
  decisionNote: string | null
}

type Props = {
  invoiceId: string
  version: number
  invoiceStatus: InvoiceStatus
  canManage: boolean
  thresholdSgd: string
  requiresApproval: boolean
  approval: InvoiceApprovalPanelApproval | null
  /** Non-empty only when an APPROVED snapshot no longer describes this invoice. */
  drift: string[]
}

function when(iso: string | null): string {
  if (!iso) return ''
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

/**
 * The approval state of one invoice, and the control that asks for one.
 *
 * RENDERS NOTHING BELOW THE THRESHOLD. That is the point of "below the threshold,
 * nothing changes": an invoice the gate does not apply to must not grow a panel
 * explaining a rule it is not subject to.
 *
 * The drift warning is shown HERE, next to the numbers, rather than only as the
 * refusal that comes back from Issue. Being told "the total moved from 12,000.00
 * to 18,500.00, request a fresh approval" while looking at the invoice is
 * something a user can act on; being told it after clicking Issue is a dead end.
 */
export function InvoiceApprovalPanel({
  invoiceId, version, invoiceStatus, canManage, thresholdSgd, requiresApproval, approval, drift,
}: Props) {
  const router = useRouter()
  const [submitting, setSubmitting] = useState(false)

  if (!requiresApproval) return null

  const drifted = approval?.status === 'approved' && drift.length > 0
  // A fresh request is possible whenever nothing live governs the invoice: never
  // requested, rejected, or approved-then-edited. A PENDING request is not
  // re-requestable — the partial unique index refuses it, and so should the button.
  const canRequest = canManage && invoiceStatus === 'draft'
    && (!approval || approval.status === 'rejected' || drifted)

  async function handleRequest() {
    setSubmitting(true)
    try {
      const res = await requestInvoiceApprovalAction({ invoiceId, version })
      if (!res.ok) { toast.error(res.error); return }
      toast.success('Sent for approval')
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  const tone = drifted || approval?.status === 'rejected'
    ? 'border-destructive/40 bg-destructive/5'
    : approval?.status === 'approved'
      ? 'border-emerald-300 bg-emerald-50'
      : 'border-amber-300 bg-amber-50'

  return (
    <section className={`rounded-md border p-4 ${tone}`} aria-label="Approval">
      <div className="flex flex-wrap items-start gap-3">
        <Icon status={approval?.status ?? null} drifted={drifted} />
        <div className="min-w-0 flex-1 space-y-1">
          <h2 className="text-sm font-semibold text-slate-900">
            {approval ? `Approval ${approvalStatusLabel(approval.status).toLowerCase()}` : 'Approval required'}
          </h2>

          {!approval && (
            <p className="text-sm text-slate-700">
              This invoice is at or above the S${thresholdSgd} approval threshold, so it needs a
              second pair of eyes before it can be issued.
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
                but this invoice has changed since. Issuing it now would ride an approval nobody
                granted, so it is blocked until a fresh one is requested:
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
        </div>

        {canRequest && (
          <Button type="button" onClick={handleRequest} disabled={submitting}>
            {submitting ? 'Sending…' : approval ? 'Request approval again' : 'Request approval'}
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
  return <ShieldAlert className={`${cls} text-amber-600`} aria-hidden="true" />
}
