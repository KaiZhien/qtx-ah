'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { changeRepairStatusAction } from '@/app/(platform)/maintenance/repairs/actions'
import { repairStatusLabel, type RepairStatus } from '@/modules/maintenance/domain/repairStatus'

type Props = {
  repairId: string
  version: number
  currentStatus: RepairStatus
  /** The ordinary next moves (allowedNextRepairStatuses) — sign-off is separate. */
  transitions: RepairStatus[]
}

/**
 * The ordinary status moves for a repair (empty at a terminal state or at
 * awaiting_sign_off, where the Sign-off control takes over). Picking a move opens
 * a confirm dialog; the note field is required only when cancelling, matching the
 * server's fail-closed enforcement so the UI never offers a doomed choice.
 */
export function RepairStatusControl({ repairId, version, currentStatus, transitions }: Props) {
  const router = useRouter()
  const [target, setTarget] = useState<RepairStatus | null>(null)
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (transitions.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No further status changes from “{repairStatusLabel(currentStatus)}”.
      </p>
    )
  }

  function choose(code: string) {
    setNote('')
    setError(null)
    setTarget(code as RepairStatus)
  }

  const noteRequired = target === 'cancelled'
  const canSubmit = !noteRequired || note.trim().length > 0

  async function handleConfirm() {
    if (!target) return
    setSubmitting(true)
    setError(null)
    try {
      const res = await changeRepairStatusAction({
        repairId, version, toStatus: target, note: note.trim() || undefined,
      })
      if (!res.ok) { setError(res.error); toast.error(res.error); return }
      toast.success(`Moved to ${repairStatusLabel(target)}`)
      setTarget(null)
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex items-center gap-2">
      <Label htmlFor="repair-move" className="text-sm text-muted-foreground">Change status</Label>
      <Select value="" onValueChange={choose}>
        <SelectTrigger id="repair-move" className="w-56"><SelectValue placeholder="Move to…" /></SelectTrigger>
        <SelectContent>
          {transitions.map((t) => (
            <SelectItem key={t} value={t}>{repairStatusLabel(t)}</SelectItem>
          ))}
        </SelectContent>
      </Select>

      {target && (
        <Dialog open onOpenChange={(open) => { if (!open) setTarget(null) }}>
          <DialogContent className="max-w-lg">
            <DialogHeader>
              <DialogTitle>Move to {repairStatusLabel(target)}</DialogTitle>
            </DialogHeader>
            <div className="space-y-4">
              {error && (
                <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
              )}
              <p className="text-sm text-muted-foreground">
                {repairStatusLabel(currentStatus)} → {repairStatusLabel(target)}
              </p>
              <div>
                <Label htmlFor="repair-note" className="mb-1.5 block">
                  Note {noteRequired ? '(required)' : '(optional)'}
                </Label>
                <Textarea
                  id="repair-note" value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder={noteRequired ? 'Why is the repair being cancelled?' : 'Add a note (optional)'}
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
