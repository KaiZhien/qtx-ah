'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'

type StatusResult =
  | { ok: true; data: { status: string; version: number } }
  | { ok: false; error: string }

type Props = {
  id: string
  version: number
  currentLabel: string
  /** Legal onward statuses computed from the pure domain by the server page. */
  options: { value: string; label: string }[]
  /** The entity's server action; its input shape is identical across ECR/ECO/firmware. */
  changeAction: (input: { id: string; version: number; toStatus: string }) => Promise<StatusResult>
}

/**
 * Generic status-change control reused by every engineering detail page. The
 * legal targets arrive already filtered (the domain's next*Statuses), so only
 * valid moves are offered; the server still re-validates through the same pure
 * domain, so a stale option can never force an illegal transition. Terminal
 * records (no options) render nothing.
 */
export function EngStatusControl({ id, version, currentLabel, options, changeAction }: Props) {
  const router = useRouter()
  const [target, setTarget] = useState(options[0]?.value ?? '')
  const [busy, setBusy] = useState(false)

  if (options.length === 0) return null

  async function submit() {
    if (!target) return
    setBusy(true)
    try {
      const res = await changeAction({ id, version, toStatus: target })
      if (!res.ok) { toast.error(res.error); return }
      toast.success(`Status changed to ${res.data.status}`)
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="text-sm text-muted-foreground">Status: {currentLabel}</span>
      <Select value={target} onValueChange={setTarget}>
        <SelectTrigger className="w-48" aria-label="New status">
          <SelectValue placeholder="Move to…" />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
      <Button size="sm" onClick={submit} disabled={busy || !target}>
        {busy ? 'Updating…' : 'Update status'}
      </Button>
    </div>
  )
}
