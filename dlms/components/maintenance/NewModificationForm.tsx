'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { createModificationAction } from '@/app/(platform)/maintenance/modifications/actions'
import type {
  ModifiableDevice, ModificationTypeOption, EcoOption,
} from '@/modules/maintenance/services/modificationService'

type Props = {
  devices: ModifiableDevice[]
  types: ModificationTypeOption[]
  /**
   * Empty when the actor has no ENGINEERING access — the page does not call
   * listEcoOptions at all in that case, because it throws rather than returning
   * empty. An absent ECO link is valid; eco_id is nullable.
   */
  ecos: EcoOption[]
  /** Preselected + locked when navigated from a specific device profile. */
  presetDeviceId?: string
  todayIso: string
}

// Sentinel for "no ECO" — a Radix Select item cannot carry an empty string value.
const NO_ECO = '__none__'

function deviceLabel(d: ModifiableDevice): string {
  return `${d.deviceSn ?? 'No serial'} · ${d.statusLabel}`
}

/**
 * Raise a modification against a device (spec §6.3).
 *
 * Deliberately WITHOUT a "also move the device" control. The New Repair form has
 * one because a repair takes the device out of service; §6.3 gives a
 * modification no device-status semantics at all, so there is no move to offer
 * and none to get wrong.
 *
 * The repair link is NOT collected here. It is same-device-validated by the
 * service, and the picker of valid repairs depends on which device is chosen —
 * so it lives on the detail page's edit form, where the device is already fixed
 * and the options can be scoped to it. Offering a free-text or unscoped repair
 * here would be offering a choice the write refuses.
 */
export function NewModificationForm({
  devices, types, ecos, presetDeviceId, todayIso,
}: Props) {
  const router = useRouter()
  const [deviceId, setDeviceId] = useState(presetDeviceId ?? devices[0]?.id ?? '')
  const [typeId, setTypeId] = useState(types[0]?.id ?? '')
  const [ecoId, setEcoId] = useState(NO_ECO)
  const [reason, setReason] = useState('')
  const [description, setDescription] = useState('')
  const [previousConfiguration, setPreviousConfiguration] = useState('')
  const [newConfiguration, setNewConfiguration] = useState('')
  const [requestedOn, setRequestedOn] = useState(todayIso)
  const [cost, setCost] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const locked = Boolean(presetDeviceId)
  const selected = devices.find((d) => d.id === deviceId)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const parsedCost = cost.trim() === '' ? undefined : Number(cost)
      if (parsedCost !== undefined && Number.isNaN(parsedCost)) {
        setError('Cost must be a number.'); return
      }
      const res = await createModificationAction({
        deviceId,
        modificationTypeId: typeId,
        reason: reason.trim() || undefined,
        description: description.trim() || undefined,
        previousConfiguration: previousConfiguration.trim() || undefined,
        newConfiguration: newConfiguration.trim() || undefined,
        requestedOn: requestedOn || undefined,
        ecoId: ecoId === NO_ECO ? undefined : ecoId,
        costSgd: parsedCost,
      })
      if (!res.ok) { setError(res.error); toast.error(res.error); return }
      toast.success(`Modification ${res.data.modificationNo} raised`)
      router.push(`/maintenance/modifications/${res.data.modificationId}`)
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
        <Label htmlFor="mod-device" className="mb-1.5 block">Device (required)</Label>
        {locked && selected ? (
          <Input id="mod-device" value={deviceLabel(selected)} readOnly />
        ) : devices.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No devices available to raise a modification against.
          </p>
        ) : (
          <Select value={deviceId} onValueChange={setDeviceId}>
            <SelectTrigger id="mod-device"><SelectValue placeholder="Select a device" /></SelectTrigger>
            <SelectContent>
              {devices.map((d) => (
                <SelectItem key={d.id} value={d.id}>{deviceLabel(d)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div>
        <Label htmlFor="mod-type" className="mb-1.5 block">Modification type (required)</Label>
        {types.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No modification types are active. An admin can add one in the vocabulary console.
          </p>
        ) : (
          <Select value={typeId} onValueChange={setTypeId}>
            <SelectTrigger id="mod-type"><SelectValue placeholder="Select a type" /></SelectTrigger>
            <SelectContent>
              {types.map((t) => (
                <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div>
        <Label htmlFor="mod-reason" className="mb-1.5 block">Reason</Label>
        <Textarea
          id="mod-reason" value={reason} onChange={(e) => setReason(e.target.value)}
          placeholder="Why is this change wanted?"
        />
      </div>

      <div>
        <Label htmlFor="mod-description" className="mb-1.5 block">Description</Label>
        <Textarea
          id="mod-description" value={description} onChange={(e) => setDescription(e.target.value)}
          placeholder="What is being done?"
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="mod-prev" className="mb-1.5 block">Previous configuration</Label>
          <Textarea
            id="mod-prev" value={previousConfiguration}
            onChange={(e) => setPreviousConfiguration(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="mod-new" className="mb-1.5 block">New configuration</Label>
          <Textarea
            id="mod-new" value={newConfiguration}
            onChange={(e) => setNewConfiguration(e.target.value)}
          />
        </div>
      </div>
      <p className="text-xs text-muted-foreground">
        These two are narrative. The structured record of what physically moved is the device&apos;s
        component history — record the swap from this modification once it exists.
      </p>

      {ecos.length > 0 && (
        <div>
          <Label htmlFor="mod-eco" className="mb-1.5 block">ECO this retrofits (optional)</Label>
          <Select value={ecoId} onValueChange={setEcoId}>
            <SelectTrigger id="mod-eco"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NO_ECO}>No ECO</SelectItem>
              {ecos.map((e) => (
                <SelectItem key={e.id} value={e.id}>{e.ecoNo} — {e.title}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="mod-requested" className="mb-1.5 block">Requested on</Label>
          <Input
            id="mod-requested" type="date" value={requestedOn}
            onChange={(e) => setRequestedOn(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="mod-cost" className="mb-1.5 block">Cost (SGD)</Label>
          <Input
            id="mod-cost" type="number" min="0" step="0.01" value={cost}
            onChange={(e) => setCost(e.target.value)}
          />
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        New modifications start at <span className="font-medium">Requested</span>. Move them onward
        from the modification page.
      </p>

      <div className="flex justify-end gap-2">
        <Button
          type="button" variant="outline" disabled={submitting}
          onClick={() => router.push('/maintenance/modifications')}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={submitting || !deviceId || !typeId}>
          {submitting ? 'Raising…' : 'Raise modification'}
        </Button>
      </div>
    </form>
  )
}
