'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { signOffRepairAction } from '@/app/(platform)/maintenance/repairs/actions'

type Props = {
  repairId: string
  version: number
  /**
   * Why sign-off is not yet possible, or null when it is — the page derives it
   * from the same facts evaluateSignOff decides on (spec §5.3/§5.4).
   */
  blockedReason: string | null
}

/**
 * Sign-off control (permission sign_off_repairs). Only rendered when the repair
 * is at awaiting_sign_off. Disabled with a hint when a precondition is unmet —
 * missing testing notes, or a parts-replaced claim with no component change
 * recorded against the repair. The server enforces the same preconditions
 * (evaluateSignOff, on facts read inside its own transaction), so this only
 * saves a doomed round-trip; it is not the enforcement.
 */
export function RepairSignOffButton({ repairId, version, blockedReason }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleConfirm() {
    setSubmitting(true)
    setError(null)
    try {
      const res = await signOffRepairAction({ repairId, version })
      if (!res.ok) { setError(res.error); toast.error(res.error); return }
      toast.success('Repair signed off and closed')
      if (!res.data.deviceReturned) {
        toast.warning('Repair closed, but the device was not returned to service — move it manually.')
      }
      setOpen(false)
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)} disabled={blockedReason !== null}>
        Sign off
      </Button>
      {blockedReason && (
        <p className="mt-1 max-w-prose text-xs text-muted-foreground">{blockedReason}</p>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Sign off this repair?</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {error && (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
            )}
            <p className="text-sm text-muted-foreground">
              Signing off closes the repair and returns the device to service (Under Repair → Active)
              when it is currently under repair.
            </p>
            <div className="flex justify-end gap-2">
              <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
                Cancel
              </Button>
              <Button type="button" onClick={handleConfirm} disabled={submitting}>
                {submitting ? 'Signing off…' : 'Confirm sign-off'}
              </Button>
            </div>
          </div>
        </DialogContent>
      </Dialog>
    </>
  )
}
