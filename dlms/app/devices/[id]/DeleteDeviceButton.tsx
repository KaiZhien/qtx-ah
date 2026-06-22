'use client'
import { useState } from 'react'
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from '@/components/ui/alert-dialog'
import { Button } from '@/components/ui/button'
import { Trash2 } from 'lucide-react'
import { softDeleteAction } from '../actions'

export function DeleteDeviceButton({ deviceId }: { deviceId: string }) {
  const [pending, setPending] = useState(false)
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size="sm"><Trash2 className="h-4 w-4 mr-1" />Delete</Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Soft-delete this record?</AlertDialogTitle>
          <AlertDialogDescription>
            The record will be marked as deleted and hidden from the device list. It is never permanently removed.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={async () => {
              setPending(true)
              await softDeleteAction(deviceId)
            }}
            disabled={pending}
          >
            {pending ? 'Deleting...' : 'Delete'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
