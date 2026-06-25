'use client'
import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { toggleStatusActiveAction, togglePhaseActiveAction } from './actions'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'

interface Props { table: 'status_option' | 'phase_option'; code: string; active: boolean }

export function ToggleActiveButton({ table, code, active }: Props) {
  const router = useRouter()
  const [pending, setPending] = useState(false)
  async function toggle() {
    setPending(true)
    try {
      if (table === 'status_option') await toggleStatusActiveAction(code, !active)
      else await togglePhaseActiveAction(code, !active)
      router.refresh()
      toast.success(active ? 'Entry deactivated' : 'Entry activated')
    } catch {
      toast.error(active ? 'Failed to deactivate entry' : 'Failed to activate entry')
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
