'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { XCircle } from 'lucide-react'
import { toast } from 'sonner'
import { rejectDraftAction } from '../actions'

export function RejectDraftButton({ draftId }: { draftId: string }) {
  const [pending, setPending] = useState(false)
  const router = useRouter()
  async function handleReject() {
    setPending(true)
    try {
      await rejectDraftAction(draftId)
      toast.success('Draft rejected')
      router.push('/legacy/drafts')
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Failed to reject draft')
      setPending(false)
    }
  }
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" className="gap-2"><XCircle className="h-4 w-4" />Reject</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Reject this draft?</AlertDialogTitle>
          <AlertDialogDescription>
            The draft will be dismissed from the pending queue and will not be promoted to a device.
            It is retained for the record, not permanently deleted.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleReject} disabled={pending}>
            {pending ? 'Rejecting...' : 'Reject'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
