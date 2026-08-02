'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { updateFailureAction } from '@/app/(platform)/engineering/failures/failureActions'

type Props = {
  id: string
  version: number
  containment: string | null
  rootCause: string | null
  correctiveAction: string | null
}

/**
 * The three narrative fields the lifecycle reads. Editable while the
 * investigation is live because each is a PRECONDITION for the state that
 * asserts it — you must be able to write the root cause down before you can
 * move to root_cause_identified. The server re-reads both fields under the row
 * lock when the move happens, so blanking one here later cannot leave a closed
 * investigation with an empty root cause.
 */
export function FailureFindingsForm({
  id, version, containment, rootCause, correctiveAction,
}: Props) {
  const router = useRouter()
  const [c, setC] = useState(containment ?? '')
  const [rc, setRc] = useState(rootCause ?? '')
  const [ca, setCa] = useState(correctiveAction ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dirty = c !== (containment ?? '') || rc !== (rootCause ?? '') || ca !== (correctiveAction ?? '')

  async function save(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      // Empty string clears the field (null); the service treats an explicit
      // null as "clear" and an absent key as "leave alone".
      const res = await updateFailureAction({
        id, version,
        containment: c.trim() || null,
        rootCause: rc.trim() || null,
        correctiveAction: ca.trim() || null,
      })
      if (!res.ok) { setError(res.error); toast.error(res.error); return }
      toast.success('Findings saved')
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <form onSubmit={save} className="space-y-4 rounded-md border p-4">
      <h2 className="text-sm font-medium text-slate-900">Findings</h2>
      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      )}
      <div>
        <Label htmlFor="fi-containment" className="mb-1.5 block">Containment</Label>
        <Textarea id="fi-containment" value={c} onChange={(e) => setC(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="fi-rootcause" className="mb-1.5 block">
          Root cause <span className="text-muted-foreground">(required to identify a root cause)</span>
        </Label>
        <Textarea id="fi-rootcause" value={rc} onChange={(e) => setRc(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="fi-corrective" className="mb-1.5 block">
          Corrective action <span className="text-muted-foreground">(required to reach corrective action)</span>
        </Label>
        <Textarea id="fi-corrective" value={ca} onChange={(e) => setCa(e.target.value)} />
      </div>
      <div className="flex justify-end">
        <Button type="submit" size="sm" disabled={busy || !dirty}>
          {busy ? 'Saving…' : 'Save findings'}
        </Button>
      </div>
    </form>
  )
}
