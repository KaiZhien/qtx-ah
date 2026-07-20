'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { updateRepairAction } from '@/app/(platform)/maintenance/repairs/actions'

type Props = {
  repairId: string
  version: number
  initial: {
    faultDescription: string | null
    diagnosis: string | null
    correctiveAction: string | null
    testingNotes: string | null
    warrantyFlag: boolean
    warrantyJustification: string | null
    costSgd: string | null
  }
}

/**
 * Records the repair's detail fields (spec §5.3): diagnosis on the way into
 * repair, corrective action before testing, and testing notes — the field
 * sign-off requires. A collapsible editor so the detail page stays read-first.
 */
export function RepairEditForm({ repairId, version, initial }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [fault, setFault] = useState(initial.faultDescription ?? '')
  const [diagnosis, setDiagnosis] = useState(initial.diagnosis ?? '')
  const [corrective, setCorrective] = useState(initial.correctiveAction ?? '')
  const [testing, setTesting] = useState(initial.testingNotes ?? '')
  const [warranty, setWarranty] = useState(initial.warrantyFlag)
  const [warrantyNote, setWarrantyNote] = useState(initial.warrantyJustification ?? '')
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
      const res = await updateRepairAction({
        repairId, version,
        faultDescription: fault.trim() || null,
        diagnosis: diagnosis.trim() || null,
        correctiveAction: corrective.trim() || null,
        testingNotes: testing.trim() || null,
        warrantyFlag: warranty,
        warrantyJustification: warranty ? warrantyNote.trim() || null : null,
        costSgd: parsedCost,
      })
      if (!res.ok) { setError(res.error); toast.error(res.error); return }
      toast.success('Repair updated')
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
        <Label htmlFor="edit-fault" className="mb-1.5 block">Reported fault</Label>
        <Textarea id="edit-fault" value={fault} onChange={(e) => setFault(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="edit-diagnosis" className="mb-1.5 block">Diagnosis</Label>
        <Textarea id="edit-diagnosis" value={diagnosis} onChange={(e) => setDiagnosis(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="edit-corrective" className="mb-1.5 block">Corrective action</Label>
        <Textarea id="edit-corrective" value={corrective} onChange={(e) => setCorrective(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="edit-testing" className="mb-1.5 block">
          Testing notes <span className="text-muted-foreground">(required to sign off)</span>
        </Label>
        <Textarea id="edit-testing" value={testing} onChange={(e) => setTesting(e.target.value)} />
      </div>
      <div className="flex items-center gap-2">
        <input
          id="edit-warranty" type="checkbox" checked={warranty}
          onChange={(e) => setWarranty(e.target.checked)}
          className="h-4 w-4 rounded border-input"
        />
        <Label htmlFor="edit-warranty" className="cursor-pointer">Covered under warranty</Label>
      </div>
      {warranty && (
        <div>
          <Label htmlFor="edit-warranty-note" className="mb-1.5 block">Warranty justification</Label>
          <Textarea id="edit-warranty-note" value={warrantyNote} onChange={(e) => setWarrantyNote(e.target.value)} />
        </div>
      )}
      <div>
        <Label htmlFor="edit-cost" className="mb-1.5 block">Cost (SGD)</Label>
        <Input
          id="edit-cost" type="number" min="0" step="0.01" value={cost}
          onChange={(e) => setCost(e.target.value)} className="max-w-[12rem]"
        />
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
