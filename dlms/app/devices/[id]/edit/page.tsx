'use client'
import { useEffect, useState } from 'react'
import { useParams, useRouter } from 'next/navigation'
import { DeviceForm } from '@/components/device/DeviceForm'
import { createBrowserClient } from '@/lib/supabase/client'
import { updateDeviceAction } from '../../actions'
import type { DeviceRow, DeviceInput, StatusOption, PhaseOption } from '@/lib/types'
import { AppError } from '@/lib/types'

export default function EditDevicePage() {
  const params = useParams<{ id: string }>()
  const router = useRouter()
  const [device, setDevice] = useState<DeviceRow | null>(null)
  const [statuses, setStatuses] = useState<StatusOption[]>([])
  const [phases, setPhases] = useState<PhaseOption[]>([])
  const [conflict, setConflict] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  useEffect(() => {
    const supabase = createBrowserClient()
    Promise.all([
      supabase.from('device').select('*').eq('id', params.id).single(),
      supabase.from('status_option').select('*').eq('active', true).order('sort_order'),
      supabase.from('phase_option').select('*').eq('active', true).order('sort_order'),
    ]).then(([{ data: d }, { data: s }, { data: p }]) => {
      setDevice(d as DeviceRow)
      setStatuses((s ?? []) as StatusOption[])
      setPhases((p ?? []) as PhaseOption[])
    })
  }, [params.id])

  async function handleSubmit(data: DeviceInput) {
    if (!device) return
    setSubmitting(true)
    setConflict(null)
    try {
      await updateDeviceAction(params.id, data, device.version)
      router.push(`/devices/${params.id}`)
    } catch (e) {
      const err = e as AppError
      if (err?.serviceError?.type === 'conflict') {
        setConflict(err.serviceError.message)
      } else {
        setConflict((e as Error).message)
      }
      setSubmitting(false)
    }
  }

  if (!device) return <div className="text-muted-foreground">Loading...</div>

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold mb-6">Edit Device</h1>
      <DeviceForm
        initialData={device}
        statuses={statuses}
        phases={phases}
        onSubmit={handleSubmit}
        isSubmitting={submitting}
        conflictError={conflict}
      />
    </div>
  )
}
