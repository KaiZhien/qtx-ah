'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

import { escalateFailureAction } from '@/app/(platform)/engineering/failures/failureActions'

type Option = { id: string; label: string }
type Props = {
  id: string
  version: number
  /** Non-terminal ECOs this investigation may escalate into. */
  ecoOptions: Option[]
}

const NEW = '__new__'

/**
 * Escalate an investigation to a change order.
 *
 * Two paths, exactly one of which is sent: link an EXISTING order, or raise a
 * new one. The "raise a new one" path does NOT reimplement ECO creation — the
 * server calls the engineering module's own createEco, so numbering, the
 * initial status and the create_records check all stay in one place.
 *
 * The server refuses escalation when no root cause is recorded, when the
 * investigation is already terminal, or when it is already escalated somewhere
 * else; this control does not try to predict those — it surfaces the message.
 */
export function EscalateFailureControl({ id, version, ecoOptions }: Props) {
  const router = useRouter()
  const [choice, setChoice] = useState(ecoOptions[0]?.id ?? NEW)
  const [title, setTitle] = useState('')
  const [effectivityDate, setEffectivityDate] = useState('')
  const [effectivitySerial, setEffectivitySerial] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const creating = choice === NEW

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await escalateFailureAction(
        creating
          ? {
              id, version,
              newEco: {
                title: title.trim(),
                effectivityDate: effectivityDate || undefined,
                effectivitySerial: effectivitySerial.trim() || undefined,
              },
            }
          : { id, version, ecoId: choice },
      )
      if (!res.ok) { setError(res.error); toast.error(res.error); return }
      toast.success(res.data.ecoNo ? `Escalated to ${res.data.ecoNo}` : 'Escalated to change order')
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={submit} className="space-y-3 rounded-md border p-4">
      <h2 className="text-sm font-medium text-slate-900">Escalate to a change order</h2>
      <p className="text-xs text-muted-foreground">
        Use this when the root cause needs a design change. Requires a recorded root cause.
      </p>
      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      )}
      <div>
        <Label htmlFor="fi-eco" className="mb-1.5 block">Change order</Label>
        <Select value={choice} onValueChange={setChoice}>
          <SelectTrigger id="fi-eco"><SelectValue /></SelectTrigger>
          <SelectContent>
            {ecoOptions.map((o) => <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>)}
            <SelectItem value={NEW}>Raise a new change order…</SelectItem>
          </SelectContent>
        </Select>
      </div>
      {creating && (
        <>
          <div>
            <Label htmlFor="fi-eco-title" className="mb-1.5 block">New order title (required)</Label>
            <Input id="fi-eco-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="fi-eco-date" className="mb-1.5 block">Effectivity date</Label>
              <Input
                id="fi-eco-date" type="date" value={effectivityDate}
                onChange={(e) => setEffectivityDate(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="fi-eco-serial" className="mb-1.5 block">Effectivity serial</Label>
              <Input
                id="fi-eco-serial" value={effectivitySerial}
                onChange={(e) => setEffectivitySerial(e.target.value)}
                placeholder="e.g. QTX-P-00412"
              />
            </div>
          </div>
        </>
      )}
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={busy || (creating && !title.trim())}>
          {busy ? 'Escalating…' : 'Escalate'}
        </Button>
      </div>
    </form>
  )
}
