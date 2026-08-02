'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { updateModificationAction } from '@/app/(platform)/maintenance/modifications/actions'
import type {
  ModificationTypeOption, EcoOption, RepairOption,
} from '@/modules/maintenance/services/modificationService'

type Props = {
  modificationId: string
  version: number
  types: ModificationTypeOption[]
  ecos: EcoOption[]
  /** Repairs on THIS device only — the service enforces the same-device rule. */
  repairs: RepairOption[]
  initial: {
    modificationTypeId: string
    reason: string | null
    description: string | null
    previousConfiguration: string | null
    newConfiguration: string | null
    requestedOn: string | null
    completedOn: string | null
    ecoId: string | null
    repairId: string | null
    costSgd: string | null
  }
}

// Radix Select cannot carry an empty string value, so "unlinked" needs a
// sentinel. It maps back to an explicit `null` on submit — which the service
// reads as "clear this field", distinct from omitting the key (leave untouched).
const NONE = '__none__'

/**
 * Edits a modification's detail fields (spec §6.3) under optimistic concurrency.
 * A collapsible editor so the detail page stays read-first — the same shape as
 * RepairEditForm.
 *
 * `status` is absent on purpose: it moves only through the status control and
 * sign-off, so the transition graph and the history log can never be bypassed.
 * The three lifecycle actor stamps are absent for the same reason — each is set
 * by the transition that earns it, never typed in afterwards.
 */
export function ModificationEditForm({
  modificationId, version, types, ecos, repairs, initial,
}: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [typeId, setTypeId] = useState(initial.modificationTypeId)
  const [reason, setReason] = useState(initial.reason ?? '')
  const [description, setDescription] = useState(initial.description ?? '')
  const [prevConfig, setPrevConfig] = useState(initial.previousConfiguration ?? '')
  const [newConfig, setNewConfig] = useState(initial.newConfiguration ?? '')
  const [requestedOn, setRequestedOn] = useState(initial.requestedOn ?? '')
  const [completedOn, setCompletedOn] = useState(initial.completedOn ?? '')
  const [ecoId, setEcoId] = useState(initial.ecoId ?? NONE)
  const [repairId, setRepairId] = useState(initial.repairId ?? NONE)
  const [cost, setCost] = useState(initial.costSgd ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const parsedCost = cost.trim() === '' ? null : Number(cost)
      if (parsedCost !== null && Number.isNaN(parsedCost)) {
        setError('Cost must be a number.'); return
      }
      const res = await updateModificationAction({
        modificationId, version,
        modificationTypeId: typeId,
        reason: reason.trim() || null,
        description: description.trim() || null,
        previousConfiguration: prevConfig.trim() || null,
        newConfiguration: newConfig.trim() || null,
        requestedOn: requestedOn || null,
        completedOn: completedOn || null,
        ecoId: ecoId === NONE ? null : ecoId,
        repairId: repairId === NONE ? null : repairId,
        costSgd: parsedCost,
      })
      if (!res.ok) { setError(res.error); toast.error(res.error); return }
      toast.success('Modification updated')
      setOpen(false)
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  if (!open) {
    return (
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        Edit details
      </Button>
    )
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-4 rounded-md border p-4">
      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      )}

      <div>
        <Label htmlFor="edit-mod-type" className="mb-1.5 block">Modification type</Label>
        <Select value={typeId} onValueChange={setTypeId}>
          <SelectTrigger id="edit-mod-type"><SelectValue /></SelectTrigger>
          <SelectContent>
            {/*
              An INACTIVE type this record already uses is not in `types` (the
              option list filters on active), so it is not offered — but leaving
              the select untouched keeps the stored value, because the id is
              seeded from the record itself.
            */}
            {types.map((t) => (
              <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      <div>
        <Label htmlFor="edit-mod-reason" className="mb-1.5 block">Reason</Label>
        <Textarea id="edit-mod-reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="edit-mod-description" className="mb-1.5 block">Description</Label>
        <Textarea
          id="edit-mod-description" value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="edit-mod-prev" className="mb-1.5 block">Previous configuration</Label>
          <Textarea id="edit-mod-prev" value={prevConfig} onChange={(e) => setPrevConfig(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="edit-mod-new" className="mb-1.5 block">New configuration</Label>
          <Textarea id="edit-mod-new" value={newConfig} onChange={(e) => setNewConfig(e.target.value)} />
        </div>
      </div>

      {ecos.length > 0 && (
        <div>
          <Label htmlFor="edit-mod-eco" className="mb-1.5 block">ECO this retrofits</Label>
          <Select value={ecoId} onValueChange={setEcoId}>
            <SelectTrigger id="edit-mod-eco"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>No ECO</SelectItem>
              {ecos.map((e) => (
                <SelectItem key={e.id} value={e.id}>{e.ecoNo} — {e.title}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      <div>
        <Label htmlFor="edit-mod-repair" className="mb-1.5 block">Repair this arose from</Label>
        {repairs.length === 0 ? (
          <p className="text-sm text-muted-foreground">No repairs on record for this device.</p>
        ) : (
          <Select value={repairId} onValueChange={setRepairId}>
            <SelectTrigger id="edit-mod-repair"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>No repair</SelectItem>
              {repairs.map((r) => (
                <SelectItem key={r.id} value={r.id}>{r.repairNo}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <p className="mt-1 text-xs text-muted-foreground">
          Only this device&apos;s repairs are listed — a link across devices is refused.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <div>
          <Label htmlFor="edit-mod-requested" className="mb-1.5 block">Requested on</Label>
          <Input
            id="edit-mod-requested" type="date" value={requestedOn}
            onChange={(e) => setRequestedOn(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="edit-mod-completed" className="mb-1.5 block">Completed on</Label>
          <Input
            id="edit-mod-completed" type="date" value={completedOn}
            onChange={(e) => setCompletedOn(e.target.value)}
          />
        </div>
        <div>
          <Label htmlFor="edit-mod-cost" className="mb-1.5 block">Cost (SGD)</Label>
          <Input
            id="edit-mod-cost" type="number" min="0" step="0.01" value={cost}
            onChange={(e) => setCost(e.target.value)}
          />
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting}>{submitting ? 'Saving…' : 'Save'}</Button>
      </div>
    </form>
  )
}
