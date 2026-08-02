'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { updateFailureAction } from '@/app/(platform)/engineering/failures/failureActions'

type CauseOption = { id: string; code: string; label: string }

type Props = {
  id: string
  version: number
  containment: string | null
  rootCauseId: string | null
  rootCause: string | null
  correctiveAction: string | null
  /** Active root_cause_option rows, resolved from the DB — never hardcoded. */
  causeOptions: CauseOption[]
}

const NONE = '__none__'

/**
 * The fields the lifecycle reads. Editable while the investigation is live
 * because each is a PRECONDITION for the state that asserts it — you must be
 * able to record the cause before you can move to root_cause_identified. The
 * server re-reads them under the row lock when the move happens, so clearing one
 * here later cannot leave a closed investigation unclassified.
 *
 * The ROOT-CAUSE CLASSIFICATION (not the prose) is what the lifecycle checks and
 * what the "by root cause" dashboard groups on. The text box beside it is
 * elaboration.
 */
export function FailureFindingsForm({
  id, version, containment, rootCauseId, rootCause, correctiveAction, causeOptions,
}: Props) {
  const router = useRouter()
  const [c, setC] = useState(containment ?? '')
  const [cause, setCause] = useState(rootCauseId ?? NONE)
  const [rc, setRc] = useState(rootCause ?? '')
  const [ca, setCa] = useState(correctiveAction ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const dirty = c !== (containment ?? '') || rc !== (rootCause ?? '')
    || ca !== (correctiveAction ?? '') || cause !== (rootCauseId ?? NONE)

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
        rootCauseId: cause === NONE ? null : cause,
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
        <Label htmlFor="fi-cause" className="mb-1.5 block">
          Root cause{' '}
          <span className="text-muted-foreground">(required to identify a root cause)</span>
        </Label>
        <Select value={cause} onValueChange={setCause}>
          <SelectTrigger id="fi-cause"><SelectValue placeholder="Not yet classified" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>Not yet classified</SelectItem>
            {causeOptions.map((o) => <SelectItem key={o.id} value={o.id}>{o.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label htmlFor="fi-rootcause" className="mb-1.5 block">
          Root-cause detail <span className="text-muted-foreground">(optional)</span>
        </Label>
        <Textarea
          id="fi-rootcause" value={rc} onChange={(e) => setRc(e.target.value)}
          placeholder="Evidence, the 5-whys chain, anything the classification alone doesn't carry."
        />
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
