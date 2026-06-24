'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { toggleSubscriberAction } from './actions'
import { useRouter } from 'next/navigation'

interface Props { id: string; active: boolean }

export function ToggleActiveButton({ id, active }: Props) {
  const router = useRouter()
  const [pending, setPending] = useState(false)

  async function toggle() {
    setPending(true)
    await toggleSubscriberAction(id, !active)
    router.refresh()
    setPending(false)
  }

  return (
    <Button variant="ghost" size="sm" onClick={toggle} disabled={pending}>
      {active ? 'Deactivate' : 'Activate'}
    </Button>
  )
}
