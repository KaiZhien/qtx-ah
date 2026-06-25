'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { toggleSubscriberAction } from './actions'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

interface Props { id: string; active: boolean }

export function ToggleActiveButton({ id, active }: Props) {
  const router = useRouter()
  const [pending, setPending] = useState(false)

  async function toggle() {
    setPending(true)
    try {
      await toggleSubscriberAction(id, !active)
      router.refresh()
      toast.success(active ? 'Subscriber deactivated' : 'Subscriber activated')
    } catch {
      toast.error(active ? 'Failed to deactivate subscriber' : 'Failed to activate subscriber')
    } finally {
      setPending(false)
    }
  }

  return (
    <Button variant="ghost" size="sm" onClick={toggle} disabled={pending}>
      {active ? 'Deactivate' : 'Activate'}
    </Button>
  )
}
