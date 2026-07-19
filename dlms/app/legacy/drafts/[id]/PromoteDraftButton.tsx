'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { promoteDraftAction } from '../actions'
import { CheckCircle } from 'lucide-react'

export function PromoteDraftButton({ draftId }: { draftId: string }) {
  const [pending, setPending] = useState(false)
  const router = useRouter()
  async function handlePromote() {
    setPending(true)
    try {
      const deviceId = await promoteDraftAction(draftId)
      router.push(`/legacy/devices/${deviceId}`)
    } catch (e) {
      alert((e as Error).message)
      setPending(false)
    }
  }
  return (
    <Button onClick={handlePromote} disabled={pending} className="gap-2">
      <CheckCircle className="h-4 w-4" />
      {pending ? 'Confirming...' : 'Confirm & Promote to Device'}
    </Button>
  )
}
