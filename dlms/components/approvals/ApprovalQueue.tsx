'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Badge } from '@/components/ui/badge'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { decideApprovalAction } from '@/app/(platform)/approvals/actions'
import type { ApprovalStatus } from '@/modules/shared/approvals/domain/approvalDecision'

export type ApprovalQueueRow = {
  id: string
  kindLabel: string
  moduleLabel: string
  status: ApprovalStatus
  recordLabel: string
  href: string | null
  requestedByName: string
  age: string
  /** Flattened for display — the approver has to see what they are agreeing to. */
  snapshot: { key: string; value: string }[]
  /** Nobody may decide their own request (approvalDecision.evaluateDecision). */
  isOwnRequest: boolean
  decidedByName: string | null
  decisionNote: string | null
}

type Props = { rows: ApprovalQueueRow[]; showingDecided: boolean }

const STATUS_TONE: Record<ApprovalStatus, string> = {
  pending: 'bg-amber-100 text-amber-900',
  approved: 'bg-emerald-100 text-emerald-900',
  rejected: 'bg-destructive/10 text-destructive',
}

/**
 * The approvals queue (spec §6.3).
 *
 * REJECTION COLLECTS ITS NOTE BEFORE THE CLICK. A rejection without a note is
 * refused three times over — by a CHECK, by the service, and by the action — and
 * being told any of that AFTER pressing Reject is the worst version of a rule that
 * exists to help the requester. So Reject opens a dialog whose confirm button
 * stays disabled until something has been typed, and the same dialog explains why
 * the note is required.
 *
 * Hiding a control is never the authorization: `decideApprovalAction` re-checks
 * everything, and the self-approval refusal lives in the pure domain precisely so
 * that no surface can forget it. The disabled button here is a courtesy.
 */
export function ApprovalQueue({ rows, showingDecided }: Props) {
  const router = useRouter()
  const [busyId, setBusyId] = useState<string | null>(null)
  const [rejecting, setRejecting] = useState<ApprovalQueueRow | null>(null)
  const [note, setNote] = useState('')

  async function decide(row: ApprovalQueueRow, decision: 'approved' | 'rejected', text?: string) {
    setBusyId(row.id)
    try {
      const res = await decideApprovalAction({ approvalId: row.id, decision, note: text })
      if (!res.ok) { toast.error(res.error); return }
      toast.success(decision === 'approved' ? 'Approved' : 'Rejected')
      setRejecting(null)
      setNote('')
      router.refresh()
    } finally {
      setBusyId(null)
    }
  }

  if (rows.length === 0) {
    return (
      <p className="rounded-md border border-dashed p-8 text-center text-sm text-muted-foreground">
        {showingDecided
          ? 'No approval requests yet.'
          : 'Nothing is waiting on you. Decided requests stay on the “All” tab.'}
      </p>
    )
  }

  return (
    <>
      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Kind</TableHead>
              <TableHead>Record</TableHead>
              <TableHead>What was requested</TableHead>
              <TableHead>Requested by</TableHead>
              <TableHead>Waiting</TableHead>
              <TableHead className="text-right">Decision</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((row) => (
              <TableRow key={row.id}>
                <TableCell className="align-top">
                  <div className="font-medium text-slate-900">{row.kindLabel}</div>
                  <div className="text-xs text-muted-foreground">{row.moduleLabel}</div>
                </TableCell>

                <TableCell className="align-top">
                  {row.href
                    ? <Link href={row.href} className="font-medium hover:underline">{row.recordLabel}</Link>
                    : <span className="font-medium">{row.recordLabel}</span>}
                </TableCell>

                <TableCell className="align-top">
                  <dl className="space-y-0.5 text-xs">
                    {row.snapshot.map((f) => (
                      <div key={f.key} className="flex gap-2">
                        <dt className="text-muted-foreground">{f.key}</dt>
                        <dd className="font-mono text-slate-900">{f.value}</dd>
                      </div>
                    ))}
                  </dl>
                </TableCell>

                <TableCell className="align-top text-sm">{row.requestedByName}</TableCell>
                <TableCell className="align-top text-sm">{row.age}</TableCell>

                <TableCell className="align-top text-right">
                  {row.status !== 'pending' ? (
                    <div className="space-y-1">
                      <Badge className={STATUS_TONE[row.status]} variant="secondary">
                        {row.status === 'approved' ? 'Approved' : 'Rejected'}
                        {row.decidedByName ? ` · ${row.decidedByName}` : ''}
                      </Badge>
                      {row.decisionNote && (
                        <p className="text-xs text-muted-foreground">“{row.decisionNote}”</p>
                      )}
                    </div>
                  ) : row.isOwnRequest ? (
                    <span className="text-xs text-muted-foreground">
                      Your own request — someone else has to review it
                    </span>
                  ) : (
                    <div className="flex justify-end gap-2">
                      <Button
                        type="button" size="sm" variant="outline"
                        disabled={busyId === row.id}
                        onClick={() => { setNote(''); setRejecting(row) }}
                      >
                        Reject
                      </Button>
                      <Button
                        type="button" size="sm"
                        disabled={busyId === row.id}
                        onClick={() => decide(row, 'approved')}
                      >
                        {busyId === row.id ? 'Working…' : 'Approve'}
                      </Button>
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>

      {rejecting && (
        <Dialog open onOpenChange={(open) => { if (!open) { setRejecting(null); setNote('') } }}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Reject {rejecting.recordLabel}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="rejection-note">Why? (required)</Label>
                <Textarea
                  id="rejection-note" rows={4} value={note} autoFocus
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="What has to change before this can be approved?"
                />
                <p className="text-xs text-muted-foreground">
                  A rejection is final — the requester raises a new request rather than reopening
                  this one — so the note is what tells them what to change.
                </p>
              </div>
              <div className="flex justify-end gap-2">
                <Button
                  type="button" variant="outline"
                  onClick={() => { setRejecting(null); setNote('') }}
                  disabled={busyId === rejecting.id}
                >
                  Cancel
                </Button>
                <Button
                  type="button" variant="destructive"
                  disabled={!note.trim() || busyId === rejecting.id}
                  onClick={() => decide(rejecting, 'rejected', note.trim())}
                >
                  {busyId === rejecting.id ? 'Rejecting…' : 'Reject'}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </>
  )
}
