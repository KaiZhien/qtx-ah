'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { createFailureAction } from '@/app/(platform)/engineering/failures/failureActions'

type Option = { id: string; label: string }
type Props = { deviceOptions: Option[]; repairOptions: Option[] }

const NONE = '__none__'

/**
 * Raise a failure investigation. Device and repair are BOTH optional and
 * independent — a failure may be reported against a device, against the repair
 * that uncovered it, or stand alone (a process/batch failure with no single
 * device yet). Root cause and corrective action are deliberately absent from
 * this form: they are what the investigation produces, recorded on the detail
 * page, and each is the precondition for the state that asserts it.
 */
export function NewFailureForm({ deviceOptions, repairOptions }: Props) {
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [severity, setSeverity] = useState('normal')
  const [description, setDescription] = useState('')
  const [containment, setContainment] = useState('')
  const [deviceId, setDeviceId] = useState(NONE)
  const [repairId, setRepairId] = useState(NONE)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await createFailureAction({
        title: title.trim(),
        severity: severity as 'low' | 'normal' | 'high' | 'critical',
        description: description.trim() || undefined,
        containment: containment.trim() || undefined,
        deviceId: deviceId === NONE ? undefined : deviceId,
        repairId: repairId === NONE ? undefined : repairId,
      })
      if (!res.ok) { setError(res.error); toast.error(res.error); return }
      toast.success(`Created ${res.data.fiNo}`)
      router.push(`/engineering/failures/${res.data.id}`)
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
        <Label htmlFor="title" className="mb-1.5 block">What failed? (required)</Label>
        <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} required />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="severity" className="mb-1.5 block">Severity</Label>
          <Select value={severity} onValueChange={setSeverity}>
            <SelectTrigger id="severity"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="normal">Normal</SelectItem>
              <SelectItem value="high">High</SelectItem>
              <SelectItem value="critical">Critical</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="device" className="mb-1.5 block">Device</Label>
          <Select value={deviceId} onValueChange={setDeviceId}>
            <SelectTrigger id="device"><SelectValue placeholder="—" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>—</SelectItem>
              {deviceOptions.map((d) => <SelectItem key={d.id} value={d.id}>{d.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div>
        <Label htmlFor="repair" className="mb-1.5 block">Raised from repair</Label>
        <Select value={repairId} onValueChange={setRepairId}>
          <SelectTrigger id="repair"><SelectValue placeholder="—" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>—</SelectItem>
            {repairOptions.map((r) => <SelectItem key={r.id} value={r.id}>{r.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label htmlFor="description" className="mb-1.5 block">Description</Label>
        <Textarea
          id="description" value={description} onChange={(e) => setDescription(e.target.value)}
          placeholder="How did the failure present? What was observed?"
        />
      </div>
      <div>
        <Label htmlFor="containment" className="mb-1.5 block">Containment</Label>
        <Textarea
          id="containment" value={containment} onChange={(e) => setContainment(e.target.value)}
          placeholder="What was done immediately to limit the impact?"
        />
      </div>
      <p className="text-xs text-muted-foreground">
        New investigations start Open. Record the root cause and corrective action on the
        investigation page — each is required before the matching step.
      </p>
      <div className="flex justify-end gap-2">
        <Button
          type="button" variant="outline" disabled={submitting}
          onClick={() => router.push('/engineering/failures')}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={submitting || !title.trim()}>
          {submitting ? 'Creating…' : 'Open investigation'}
        </Button>
      </div>
    </form>
  )
}
