'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { changeDoStatusAction } from '@/app/(platform)/logistics/delivery-orders/deliveryOrderWriteActions'
import { listAllowedDoTransitions, type DoStatus } from '@/modules/logistics/domain/doStatus'
import { DO_STATUS_LABELS } from './DoStatusPill'

type Props = {
  deliveryOrderId: string
  version: number
  currentStatus: DoStatus
}

/**
 * Renders the allowed next-status moves for a delivery order (empty for a
 * sink status: delivered/cancelled). Mirrors
 * components/manufacturing/StatusChangeControl.tsx, simplified — the DO flow
 * has no reason field or terminal-permission upgrade, since
 * modules/logistics/domain/doStatus.ts is a fixed five-state graph, not an
 * admin-editable one.
 */
export function DoStatusChangeControl({ deliveryOrderId, version, currentStatus }: Props) {
  const router = useRouter()
  const transitions = listAllowedDoTransitions(currentStatus)
  const [target, setTarget] = useState<DoStatus | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (transitions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No further status changes from “{DO_STATUS_LABELS[currentStatus]}”.
      </p>
    )
  }

  async function handleConfirm() {
    if (!target) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await changeDoStatusAction({ deliveryOrderId, version, toStatus: target })
      if (!res.ok) { setError(res.error); toast.error(res.error); return }
      toast.success(`Moved to ${DO_STATUS_LABELS[target]}`)
      setTarget(null)
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Label htmlFor="do-status-move" className="text-sm text-muted-foreground">Change status</Label>
      <Select value="" onValueChange={(v) => { setError(null); setTarget(v as DoStatus) }}>
        <SelectTrigger id="do-status-move" className="w-56"><SelectValue placeholder="Move to…" /></SelectTrigger>
        <SelectContent>
          {transitions.map((t) => (
            <SelectItem key={t} value={t}>{DO_STATUS_LABELS[t]}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {target && (
        <Dialog open onOpenChange={(open) => { if (!open) setTarget(null) }}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Move to {DO_STATUS_LABELS[target]}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              {error && (
                <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
              )}
              <p className="text-sm text-muted-foreground">
                {DO_STATUS_LABELS[currentStatus]} → {DO_STATUS_LABELS[target]}
                {(target === 'delivered' || target === 'cancelled') && ' · this is a final status'}
              </p>
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
    </div>
  )
}
