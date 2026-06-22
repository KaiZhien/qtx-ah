'use client'
import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { DeviceForm } from '@/components/device/DeviceForm'
import type { DeviceInput, StatusOption, PhaseOption } from '@/lib/types'

// We need statuses/phases — fetch them client-side for the prototype
// In production these would be passed as RSC props
import { useEffect } from 'react'
import { createBrowserClient } from '@/lib/supabase/client'
import { createDeviceAction } from '../actions'

export default function NewDevicePage() {
  const router = useRouter()
  const [statuses, setStatuses] = useState<StatusOption[]>([])
  const [phases, setPhases] = useState<PhaseOption[]>([])
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    const supabase = createBrowserClient()
    Promise.all([
      supabase.from('status_option').select('*').eq('active', true).order('sort_order'),
      supabase.from('phase_option').select('*').eq('active', true).order('sort_order'),
    ]).then(([{ data: s }, { data: p }]) => {
      setStatuses((s ?? []) as StatusOption[])
      setPhases((p ?? []) as PhaseOption[])
    })
  }, [])

  async function handleSubmit(data: DeviceInput) {
    setSubmitting(true)
    setError(null)
    try {
      await createDeviceAction(data)
    } catch (e) {
      setError((e as Error).message)
      setSubmitting(false)
    }
  }

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold mb-6">Create Device</h1>
      <DeviceForm
        statuses={statuses}
        phases={phases}
        onSubmit={handleSubmit}
        isSubmitting={submitting}
        conflictError={error}
      />
    </div>
  )
}
