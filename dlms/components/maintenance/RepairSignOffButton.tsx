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
  /** Whether testing notes are present — the sign-off precondition (spec §5.3). */
  hasTestingNotes: boolean
}

/**
 * Sign-off control (permission sign_off_repairs). Only rendered when the repair is
 * at awaiting_sign_off. Disabled with a hint when testing notes are missing — the
 * server enforces the same precondition (evaluateSignOff), so this only saves a
 * doomed round-trip; it is not the enforcement.
 */
export function RepairSignOffButton({ repairId, version, hasTestingNotes }: Props) {
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
      <Button type="button" onClick={() => setOpen(true)} disabled={!hasTestingNotes}>
        Sign off
      </Button>
      {!hasTestingNotes && (
        <p className="mt-1 text-xs text-muted-foreground">
          Record testing notes before signing off.
        </p>
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
