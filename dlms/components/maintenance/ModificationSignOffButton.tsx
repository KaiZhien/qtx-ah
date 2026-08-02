'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { signOffModificationAction } from '@/app/(platform)/maintenance/modifications/actions'

type Props = {
  modificationId: string
  version: number
}

/**
 * Sign-off control for a modification (permission `sign_off_repairs` — there is
 * no separate sign_off_modifications in the §3.2 catalogue, and inventing one
 * would need an RBAC migration; the modification table's COMMENT names this same
 * permission). Only rendered when the modification is at `completed`, which is
 * the pure precondition's only accepted state and the sole route to `closed`.
 *
 * UNLIKE REPAIR'S SIGN-OFF there is no `blockedReason` and no device to return
 * to service. Repair's carries two extra preconditions (testing notes recorded,
 * and a parts-replaced claim backed by a component record); §6.3 names no
 * equivalent artifact for a modification, so the single precondition is the
 * status itself — and the page only shows this button when it holds. The server
 * re-checks it under its own lock regardless.
 */
export function ModificationSignOffButton({ modificationId, version }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleConfirm() {
    setSubmitting(true)
    setError(null)
    try {
      const res = await signOffModificationAction({ modificationId, version })
      if (!res.ok) { setError(res.error); toast.error(res.error); return }
      toast.success('Modification signed off and closed')
      setOpen(false)
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <>
      <Button type="button" onClick={() => setOpen(true)}>Sign off</Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Sign off this modification?</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            {error && (
              <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
            )}
            <p className="text-sm text-muted-foreground">
              Signing off accepts the work and closes the modification. A closed modification is
              terminal — it cannot be reopened or edited afterwards. The device&apos;s status is not
              affected: a modification never took it out of service.
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
