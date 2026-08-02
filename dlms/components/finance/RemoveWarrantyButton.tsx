'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from '@/components/ui/alert-dialog'
import { removeWarrantyAction } from '@/app/(platform)/finance/warranties/warrantyWriteActions'

type Props = { deviceId: string; warrantyId: string; version: number }

/**
 * Retract a warranty recorded in error. Behind a confirmation because it removes
 * a commercial commitment from the record — and because the device then falls
 * back to "no warranty", not to some inferred window.
 *
 * Soft delete: the row stays in the table (and in listDeviceWarrantyHistory) and
 * the audit trail keeps the whole story.
 */
export function RemoveWarrantyButton({ deviceId, warrantyId, version }: Props) {
  const router = useRouter()
  const [submitting, setSubmitting] = useState(false)

  async function handleRemove() {
    setSubmitting(true)
    try {
      const res = await removeWarrantyAction({ warrantyId, version, deviceId })
      if (!res.ok) { toast.error(res.error); return }
      toast.success('Warranty removed')
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Trash2 className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          Remove
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove this warranty?</AlertDialogTitle>
          <AlertDialogDescription>
            The device will show no warranty cover at all — nothing is inferred from its ship
            date. If cover simply changed, use Renew instead so the original terms stay on
            the record.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleRemove} disabled={submitting}>
            {submitting ? 'Removing…' : 'Remove warranty'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
