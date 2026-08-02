'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { changeFailureStatusAction } from '@/app/(platform)/engineering/failures/failureActions'

type Props = {
  id: string
  version: number
  currentLabel: string
  /** Legal onward statuses, already filtered by the pure domain on the server. */
  options: { value: string; label: string }[]
}

/**
 * FI status control. The note field appears only for `cancelled`, which is the
 * one target the domain requires a note for — but the server re-evaluates the
 * SAME pure rule, so hiding the field is a convenience, never the enforcement.
 * Terminal records (no legal targets) render nothing at all.
 */
export function FailureStatusControl({ id, version, currentLabel, options }: Props) {
  const router = useRouter()
  const [target, setTarget] = useState(options[0]?.value ?? '')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  if (options.length === 0) return null
  const needsNote = target === 'cancelled'

  async function submit() {
    if (!target) return
    setBusy(true)
    try {
      const res = await changeFailureStatusAction({
        id, version, toStatus: target as never, note: note.trim() || undefined,
      })
      if (!res.ok) { toast.error(res.error); return }
      toast.success(`Moved to ${res.data.status.replace(/_/g, ' ')}`)
      setNote('')
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-sm text-muted-foreground">Status: {currentLabel}</span>
        <Select value={target} onValueChange={setTarget}>
          <SelectTrigger className="w-56" aria-label="New status">
            <SelectValue placeholder="Move to…" />
          </SelectTrigger>
          <SelectContent>
            {options.map((o) => (
              <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button size="sm" onClick={submit} disabled={busy || !target || (needsNote && !note.trim())}>
          {busy ? 'Updating…' : 'Update status'}
        </Button>
      </div>
      {needsNote && (
        <div className="max-w-md">
          <Label htmlFor="fi-note" className="mb-1.5 block text-xs">Reason (required to cancel)</Label>
          <Input
            id="fi-note" value={note} onChange={(e) => setNote(e.target.value)}
            placeholder="e.g. duplicate of FI-2026-0004"
          />
        </div>
      )}
    </div>
  )
}
