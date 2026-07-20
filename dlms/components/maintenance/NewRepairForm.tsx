'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { createRepairAction } from '@/app/(platform)/maintenance/repairs/actions'
import type { RepairableDevice } from '@/modules/maintenance/services/repairService'

type Props = {
  devices: RepairableDevice[]
  /** Preselected + locked when navigated from a specific device profile. */
  presetDeviceId?: string
  /** Whether the actor can also move the device → Under Repair on open. */
  canMoveDevice: boolean
}

function deviceLabel(d: RepairableDevice): string {
  return `${d.deviceSn ?? 'No serial'} · ${d.statusLabel}`
}

export function NewRepairForm({ devices, presetDeviceId, canMoveDevice }: Props) {
  const router = useRouter()
  const [deviceId, setDeviceId] = useState(presetDeviceId ?? devices[0]?.id ?? '')
  const [faultDescription, setFaultDescription] = useState('')
  const [warrantyFlag, setWarrantyFlag] = useState(false)
  const [warrantyJustification, setWarrantyJustification] = useState('')
  const [moveDevice, setMoveDevice] = useState(false)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const locked = Boolean(presetDeviceId)
  const selected = devices.find((d) => d.id === deviceId)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await createRepairAction({
        deviceId,
        faultDescription: faultDescription.trim() || undefined,
        warrantyFlag,
        warrantyJustification: warrantyFlag ? warrantyJustification.trim() || undefined : undefined,
        moveDevice: canMoveDevice && moveDevice,
      })
      if (!res.ok) { setError(res.error); toast.error(res.error); return }
      toast.success('Repair opened')
      if (canMoveDevice && moveDevice && !res.data.deviceMoved) {
        toast.warning('Repair opened, but the device status was not changed — move it manually.')
      }
      router.push(`/maintenance/repairs/${res.data.repairId}`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-2xl space-y-4">
      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      )}

      <div>
        <Label htmlFor="device" className="mb-1.5 block">Device (required)</Label>
        {locked && selected ? (
          <Input id="device" value={deviceLabel(selected)} readOnly />
        ) : devices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No devices available to open a repair against.</p>
        ) : (
          <Select value={deviceId} onValueChange={setDeviceId}>
            <SelectTrigger id="device"><SelectValue placeholder="Select a device" /></SelectTrigger>
            <SelectContent>
              {devices.map((d) => (
                <SelectItem key={d.id} value={d.id}>{deviceLabel(d)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div>
        <Label htmlFor="fault" className="mb-1.5 block">Reported fault</Label>
        <Textarea
          id="fault" value={faultDescription}
          onChange={(e) => setFaultDescription(e.target.value)}
          placeholder="What was reported?"
        />
      </div>

      <div className="flex items-center gap-2">
        <input
          id="warranty" type="checkbox" checked={warrantyFlag}
          onChange={(e) => setWarrantyFlag(e.target.checked)}
          className="h-4 w-4 rounded border-input"
        />
        <Label htmlFor="warranty" className="cursor-pointer">Covered under warranty</Label>
      </div>
      {warrantyFlag && (
        <div>
          <Label htmlFor="warranty-note" className="mb-1.5 block">Warranty justification</Label>
          <Textarea
            id="warranty-note" value={warrantyJustification}
            onChange={(e) => setWarrantyJustification(e.target.value)}
            placeholder="Why is this covered?"
          />
        </div>
      )}

      {canMoveDevice && (
        <div className="flex items-center gap-2">
          <input
            id="move-device" type="checkbox" checked={moveDevice}
            onChange={(e) => setMoveDevice(e.target.checked)}
            className="h-4 w-4 rounded border-input"
          />
          <Label htmlFor="move-device" className="cursor-pointer">
            Also move the device to Under Repair
          </Label>
        </div>
      )}

      <p className="text-xs text-muted-foreground">
        New repairs start at <span className="font-medium">Reported</span>. Move them onward from
        the repair page.
      </p>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => router.push('/maintenance/repairs')} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting || !deviceId}>
          {submitting ? 'Opening…' : 'Open repair'}
        </Button>
      </div>
    </form>
  )
}
