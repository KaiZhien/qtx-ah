'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { toggleStatusActiveAction, togglePhaseActiveAction } from './actions'
import { useRouter } from 'next/navigation'

interface Props { table: 'status_option' | 'phase_option'; code: string; active: boolean }

export function ToggleActiveButton({ table, code, active }: Props) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  async function toggle() {
    setPending(true)
    if (table === 'status_option') await toggleStatusActiveAction(code, !active)
    else await togglePhaseActiveAction(code, !active)
    router.refresh()
    setPending(false)
  }
  return (
    <Button variant="ghost" size="sm" onClick={toggle} disabled={pending}>
      {active ? 'Deactivate' : 'Activate'}
    </Button>
  )
}
