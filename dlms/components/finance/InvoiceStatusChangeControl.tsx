'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { changeInvoiceStatusAction } from '@/app/(platform)/finance/invoices/invoiceWriteActions'
import type { InvoiceStatus } from '@/modules/finance/domain/invoiceStatus'

type Props = {
  invoiceId: string
  version: number
  currentStatus: InvoiceStatus
  transitions: InvoiceStatus[]
}

const STATUS_LABEL: Record<InvoiceStatus, string> = { draft: 'Draft', issued: 'Issued', paid: 'Paid', void: 'Void' }

/**
 * Renders the allowed next-status moves for an invoice (empty once
 * paid/void — the two terminal states). Same convention as
 * manufacturing/StatusChangeControl.tsx, minus the reason field: the invoice
 * flow (modules/finance/domain/invoiceStatus.ts) has no requires_reason
 * concept — it's a fixed 4-state map, not an admin-editable graph.
 */
export function InvoiceStatusChangeControl({ invoiceId, version, currentStatus, transitions }: Props) {
  const router = useRouter()
  const [target, setTarget] = useState<InvoiceStatus | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (transitions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No further status changes from “{STATUS_LABEL[currentStatus]}”.
      </p>
    )
  }

  async function handleConfirm() {
    if (!target) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await changeInvoiceStatusAction({ invoiceId, version, toStatus: target })
      if (!res.ok) { setError(res.error); toast.error(res.error); return }
      toast.success(`Moved to ${STATUS_LABEL[target]}`)
      setTarget(null)
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <label className="text-sm text-muted-foreground" htmlFor="invoice-status-move">Change status</label>
      <Select value="" onValueChange={(v) => { setError(null); setTarget(v as InvoiceStatus) }}>
        <SelectTrigger id="invoice-status-move" className="w-48"><SelectValue placeholder="Move to…" /></SelectTrigger>
        <SelectContent>
          {transitions.map((t) => <SelectItem key={t} value={t}>{STATUS_LABEL[t]}</SelectItem>)}
        </SelectContent>
      </Select>

      {target && (
        <Dialog open onOpenChange={(open) => { if (!open) setTarget(null) }}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Move to {STATUS_LABEL[target]}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              {error && (
                <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
              )}
              <p className="text-sm text-muted-foreground">
                {STATUS_LABEL[currentStatus]} → {STATUS_LABEL[target]}
                {(target === 'paid' || target === 'void') && ' · this is a final status'}
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
