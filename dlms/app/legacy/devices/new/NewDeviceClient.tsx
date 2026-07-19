'use client'
import { useState, useCallback } from 'react'
import { useRouter } from 'next/navigation'
import { DeviceForm } from '@/components/device/DeviceForm'
import type { DeviceInput, StatusOption, PhaseOption } from '@/lib/types'

import { useEffect } from 'react'
import { createBrowserClient } from '@/lib/supabase/client'
import { createDeviceBatchAction } from '../actions'
import { expandSerialRange } from '@/lib/domain/serialRange'

export function NewDeviceClient() {
  const router = useRouter()
  const [statuses, setStatuses] = useState<StatusOption[]>([])
  const [phases, setPhases] = useState<PhaseOption[]>([])
  const [error, setError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [batchCount, setBatchCount] = useState<number | null>(null)

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

  const handlePcbaSnChange = useCallback((pcbaASn: string) => {
    const result = expandSerialRange(pcbaASn.trim())
    setBatchCount('serials' in result && result.serials.length > 1 ? result.serials.length : null)
  }, [])

  async function handleSubmit(data: DeviceInput) {
    setSubmitting(true)
    setError(null)
    try {
      await createDeviceBatchAction(data)
    } catch (e) {
      setError((e as Error).message)
      setSubmitting(false)
    }
  }

  const isBatch = batchCount !== null && batchCount > 1

  return (
    <div className="max-w-3xl">
      <h1 className="text-2xl font-bold mb-6">Create Device</h1>

      {isBatch && (
        <div className="mb-4 flex items-center gap-2 rounded-md border border-blue-200 bg-blue-50 px-4 py-2.5 text-sm text-blue-800">
          <span className="font-semibold">{batchCount} devices will be created</span>
          <span className="text-blue-600">— one per serial number in the range</span>
        </div>
      )}

      <DeviceForm
        statuses={statuses}
        phases={phases}
        onSubmit={handleSubmit}
        isSubmitting={submitting}
        conflictError={error}
        onPcbaSnChange={handlePcbaSnChange}
        submitLabel={isBatch ? `Create ${batchCount} Devices` : undefined}
      />
    </div>
  )
}
