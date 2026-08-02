'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { PackageCheck } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  changeTransferStatusAction, receiveStockTransferAction,
} from '@/app/(platform)/logistics/transfers/actions'
import {
  listAllowedTransferTransitions, type StockTransferStatus,
} from '@/modules/logistics/domain/transferStatus'
import { TRANSFER_STATUS_LABELS } from './TransferStatusPill'

type Props = {
  stockTransferId: string
  version: number
  currentStatus: StockTransferStatus
  fromLocationName: string
  toLocationName: string
}

/** Only these two are reachable through the plain status control. */
type PlainTarget = 'dispatched' | 'cancelled'

/**
 * Status control for a stock transfer.
 *
 * `received` is deliberately NOT one of the dropdown's options even though the
 * domain graph allows the edge: receiving POSTS STOCK, so it gets its own
 * explicit, separately-confirmed button below with the movement spelled out.
 * The service enforces the same split — changeTransferStatus refuses
 * 'received' outright — so this is a UI echo of a real boundary, not just
 * presentation.
 */
export function TransferStatusChangeControl({
  stockTransferId, version, currentStatus, fromLocationName, toLocationName,
}: Props) {
  const router = useRouter()
  const plainTransitions = listAllowedTransferTransitions(currentStatus)
    .filter((t): t is PlainTarget => t === 'dispatched' || t === 'cancelled')
  const canReceive = listAllowedTransferTransitions(currentStatus).includes('received')

  const [target, setTarget] = useState<PlainTarget | null>(null)
  const [receiving, setReceiving] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (plainTransitions.length === 0 && !canReceive) {
    return (
      <p className="text-sm text-muted-foreground">
        No further status changes from “{TRANSFER_STATUS_LABELS[currentStatus]}”.
      </p>
    )
  }

  async function handleConfirm() {
    if (!target) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await changeTransferStatusAction({ stockTransferId, version, toStatus: target })
      if (!res.ok) { setError(res.error); toast.error(res.error); return }
      toast.success(`Moved to ${TRANSFER_STATUS_LABELS[target]}`)
      setTarget(null)
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  async function handleReceive() {
    setSubmitting(true)
    setError(null)
    try {
      const res = await receiveStockTransferAction({ stockTransferId, version })
      if (!res.ok) { setError(res.error); toast.error(res.error); return }
      toast.success('Transfer received — stock levels updated')
      setReceiving(false)
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      {plainTransitions.length > 0 && (
        <>
          <Label htmlFor="transfer-status-move" className="text-sm text-muted-foreground">
            Change status
          </Label>
          <Select value="" onValueChange={(v) => { setError(null); setTarget(v as PlainTarget) }}>
            <SelectTrigger id="transfer-status-move" className="w-52">
              <SelectValue placeholder="Move to…" />
            </SelectTrigger>
            <SelectContent>
              {plainTransitions.map((t) => (
                <SelectItem key={t} value={t}>{TRANSFER_STATUS_LABELS[t]}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </>
      )}

      {canReceive && (
        <Button type="button" onClick={() => { setError(null); setReceiving(true) }}>
          <PackageCheck className="mr-1.5 h-4 w-4" />
          Receive transfer
        </Button>
      )}

      {target && (
        <Dialog open onOpenChange={(open) => { if (!open) setTarget(null) }}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Move to {TRANSFER_STATUS_LABELS[target]}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              {error && (
                <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
              )}
              <p className="text-sm text-muted-foreground">
                {TRANSFER_STATUS_LABELS[currentStatus]} → {TRANSFER_STATUS_LABELS[target]}
                {target === 'cancelled' && ' · this is a final status'}
              </p>
              {target === 'dispatched' && (
                <p className="text-sm text-muted-foreground">
                  Dispatching does not move stock. Balances change only when the transfer is
                  received at {toLocationName}.
                </p>
              )}
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setTarget(null)} disabled={submitting}>
                  Cancel
                </Button>
                <Button type="button" onClick={handleConfirm} disabled={submitting}>
                  {submitting ? 'Moving…' : 'Confirm'}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}

      {receiving && (
        <Dialog open onOpenChange={(open) => { if (!open) setReceiving(false) }}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Receive this transfer</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              {error && (
                <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
              )}
              <p className="text-sm text-muted-foreground">
                This moves every line off {fromLocationName} and onto {toLocationName}, and
                updates stock levels at both. It cannot be undone from here.
              </p>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setReceiving(false)} disabled={submitting}>
                  Cancel
                </Button>
                <Button type="button" onClick={handleReceive} disabled={submitting}>
                  {submitting ? 'Receiving…' : 'Receive and post stock'}
                </Button>
              </div>
            </div>
          </DialogContent>
        </Dialog>
      )}
    </div>
  )
}
