'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { changeDeviceStatusAction } from '@/app/(platform)/manufacturing/devices/deviceWriteActions'
import type { AllowedTransition } from '@/modules/manufacturing/services/deviceWriteService'

type Props = {
  deviceId: string
  version: number
  currentLabel: string
  transitions: AllowedTransition[]
}

/**
 * Renders the allowed next-status moves for a device (empty for a terminal
 * status). Picking a move opens a confirm dialog; the reason field appears and
 * is required only when the chosen transition's requiresReason is set, matching
 * the server's fail-closed enforcement so the UI never offers an illegal move.
 */
export function StatusChangeControl({ deviceId, version, currentLabel, transitions }: Props) {
  const router = useRouter()
  const [target, setTarget] = useState<AllowedTransition | null>(null)
  const [reason, setReason] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (transitions.length === 0) {
    return <p className="text-sm text-muted-foreground">No further status changes from “{currentLabel}”.</p>
  }

  function choose(code: string) {
    const t = transitions.find((x) => x.toStatus === code) ?? null
    setReason('')
    setError(null)
    setTarget(t)
  }

  const reasonRequired = target?.requiresReason ?? false
  const canSubmit = !reasonRequired || reason.trim().length > 0

  async function handleConfirm() {
    if (!target) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await changeDeviceStatusAction({
        deviceId, version, toStatus: target.toStatus,
        reason: reason.trim() || undefined,
      })
      if (!res.ok) { setError(res.error); toast.error(res.error); return }
      toast.success(`Moved to ${target.toLabel}`)
      setTarget(null)
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Label htmlFor="status-move" className="text-sm text-muted-foreground">Change status</Label>
      <Select value="" onValueChange={choose}>
        <SelectTrigger id="status-move" className="w-56"><SelectValue placeholder="Move to…" /></SelectTrigger>
        <SelectContent>
          {transitions.map((t) => (
            <SelectItem key={t.toStatus} value={t.toStatus}>
              {t.toLabel}{t.isTerminal ? ' (final)' : ''}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {target && (
        <Dialog open onOpenChange={(open) => { if (!open) setTarget(null) }}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Move to {target.toLabel}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              {error && (
                <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
              )}
              <p className="text-sm text-muted-foreground">
                {currentLabel} → {target.toLabel}
                {target.isTerminal && ' · this is a final status'}
              </p>
              <div>
                <Label htmlFor="move-reason" className="mb-1.5 block">
                  Reason {reasonRequired ? '(required)' : '(optional)'}
                </Label>
                <Textarea
                  id="move-reason" value={reason}
                  onChange={(e) => setReason(e.target.value)}
                  placeholder="Why is the status changing?"
                />
              </div>
              <div className="flex justify-end gap-2">
                <Button type="button" variant="outline" onClick={() => setTarget(null)} disabled={submitting}>
                  Cancel
                </Button>
                <Button type="button" onClick={handleConfirm} disabled={submitting || !canSubmit}>
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
