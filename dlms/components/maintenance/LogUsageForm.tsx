'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { recordUsageAction } from '@/app/(platform)/maintenance/usage/actions'
import type { UsageLoggableDevice } from '@/modules/maintenance/services/usageService'

type Props = {
  devices: UsageLoggableDevice[]
  /** Preselected + locked when logged from a device profile's Usage tab. */
  presetDeviceId?: string
  /** Today as YYYY-MM-DD, computed on the server so the default matches the DB's date. */
  todayIso: string
  /** Where to go after a successful append. */
  redirectTo?: string
  onDone?: () => void
}

function deviceLabel(d: UsageLoggableDevice): string {
  const last = d.latestReading === null
    ? 'no readings yet'
    : `last ${d.latestReading.toLocaleString()} on ${d.latestRecordedOn}`
  return `${d.deviceSn ?? 'No serial'} · ${last}`
}

/**
 * Appends one counter reading (spec §6.3).
 *
 * The non-monotonic case is the whole point of this form's feedback: a reading
 * lower than the last one is ACCEPTED and the server returns a `reset`
 * classification, which surfaces here as a warning toast — never an error. The
 * live hint below the field says so BEFORE the user submits, so a technician
 * entering a genuinely-reset counter is not left wondering whether the form is
 * about to reject them.
 */
export function LogUsageForm({ devices, presetDeviceId, todayIso, redirectTo, onDone }: Props) {
  const router = useRouter()
  const [deviceId, setDeviceId] = useState(presetDeviceId ?? devices[0]?.id ?? '')
  const [sessions, setSessions] = useState('')
  const [recordedOn, setRecordedOn] = useState(todayIso)
  const [note, setNote] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const locked = Boolean(presetDeviceId)
  const selected = devices.find((d) => d.id === deviceId)

  const parsed = sessions.trim() === '' ? null : Number(sessions)
  const valid = parsed !== null && Number.isInteger(parsed) && parsed >= 0
  // Predicts the server's classification so the warning is visible before the
  // click. Advisory in exactly the same way the server's is — the row is written
  // either way.
  const looksLikeReset =
    valid && selected?.latestReading !== null && selected?.latestReading !== undefined
      && parsed! < selected.latestReading

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!valid) { setError('Enter the counter reading as a whole number of sessions.'); return }
    setSubmitting(true)
    setError(null)
    try {
      const res = await recordUsageAction({
        deviceId,
        cumulativeSessions: parsed!,
        recordedOn,
        note: note.trim() || undefined,
      })
      if (!res.ok) { setError(res.error); toast.error(res.error); return }

      if (res.data.classification.kind === 'reset') {
        toast.warning(
          `Reading saved. The counter went from ${res.data.classification.previous.toLocaleString()} `
          + `to ${res.data.classification.next.toLocaleString()} — recorded as a counter reset.`,
        )
      } else {
        toast.success('Usage reading saved')
      }

      setSessions('')
      setNote('')
      onDone?.()
      if (redirectTo) router.push(redirectTo)
      else router.refresh()
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
        <Label htmlFor="usage-device" className="mb-1.5 block">Device (required)</Label>
        {locked && selected ? (
          <Input id="usage-device" value={deviceLabel(selected)} readOnly />
        ) : devices.length === 0 ? (
          <p className="text-sm text-muted-foreground">No devices available to log usage against.</p>
        ) : (
          <Select value={deviceId} onValueChange={setDeviceId}>
            <SelectTrigger id="usage-device"><SelectValue placeholder="Select a device" /></SelectTrigger>
            <SelectContent>
              {devices.map((d) => (
                <SelectItem key={d.id} value={d.id}>{deviceLabel(d)}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div>
        <Label htmlFor="usage-sessions" className="mb-1.5 block">
          Cumulative sessions (required)
        </Label>
        <Input
          id="usage-sessions" type="number" min="0" step="1" inputMode="numeric"
          value={sessions} onChange={(e) => setSessions(e.target.value)}
          className="max-w-[14rem]" placeholder="The number on the counter"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          The total the machine&apos;s counter shows — not the sessions since the last reading.
        </p>
        {looksLikeReset && (
          <p className="mt-1 max-w-prose rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800">
            This is lower than the last reading
            {selected?.latestReading !== null && selected?.latestReading !== undefined
              ? ` (${selected.latestReading.toLocaleString()})`
              : ''}
            . That is allowed — it will be saved and flagged as a counter reset.
          </p>
        )}
      </div>

      <div>
        <Label htmlFor="usage-date" className="mb-1.5 block">Reading date</Label>
        <Input
          id="usage-date" type="date" value={recordedOn} max={todayIso}
          onChange={(e) => setRecordedOn(e.target.value)} className="max-w-[14rem]"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          When the counter was read — backdate a logbook entry here.
        </p>
      </div>

      <div>
        <Label htmlFor="usage-note" className="mb-1.5 block">Note</Label>
        <Textarea
          id="usage-note" value={note} onChange={(e) => setNote(e.target.value)}
          placeholder="Anything worth recording alongside the reading (optional)"
        />
      </div>

      <div className="flex justify-end gap-2">
        <Button type="submit" disabled={submitting || !deviceId || !valid}>
          {submitting ? 'Saving…' : 'Save reading'}
        </Button>
      </div>
    </form>
  )
}
