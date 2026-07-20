'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { createEcoAction } from '@/app/(platform)/engineering/eco/ecoActions'

type Option = { id: string; label: string }
type Props = { ecrOptions: Option[] }

const NONE = '__none__'

export function NewEcoForm({ ecrOptions }: Props) {
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [ecrId, setEcrId] = useState(NONE)
  const [effectivityDate, setEffectivityDate] = useState('')
  const [effectivitySerial, setEffectivitySerial] = useState('')
  const [effectivityNotes, setEffectivityNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await createEcoAction({
        title: title.trim(),
        description: description.trim() || undefined,
        ecrId: ecrId === NONE ? undefined : ecrId,
        effectivityDate: effectivityDate || undefined,
        effectivitySerial: effectivitySerial.trim() || undefined,
        effectivityNotes: effectivityNotes.trim() || undefined,
      })
      if (!res.ok) { setError(res.error); toast.error(res.error); return }
      toast.success(`Created ${res.data.ecoNo}`)
      router.push(`/engineering/eco/${res.data.id}`)
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
        <Label htmlFor="title" className="mb-1.5 block">Title (required)</Label>
        <Input id="title" value={title} onChange={(e) => setTitle(e.target.value)} required />
      </div>
      <div>
        <Label htmlFor="ecr" className="mb-1.5 block">Realises change request</Label>
        <Select value={ecrId} onValueChange={setEcrId}>
          <SelectTrigger id="ecr"><SelectValue placeholder="—" /></SelectTrigger>
          <SelectContent>
            <SelectItem value={NONE}>—</SelectItem>
            {ecrOptions.map((e) => <SelectItem key={e.id} value={e.id}>{e.label}</SelectItem>)}
          </SelectContent>
        </Select>
      </div>
      <div>
        <Label htmlFor="description" className="mb-1.5 block">Description</Label>
        <Textarea id="description" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="effDate" className="mb-1.5 block">Effectivity date</Label>
          <Input id="effDate" type="date" value={effectivityDate} onChange={(e) => setEffectivityDate(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="effSerial" className="mb-1.5 block">Effectivity serial</Label>
          <Input id="effSerial" value={effectivitySerial} onChange={(e) => setEffectivitySerial(e.target.value)} placeholder="e.g. from SN QTX-P-00412" />
        </div>
      </div>
      <div>
        <Label htmlFor="effNotes" className="mb-1.5 block">Effectivity notes</Label>
        <Textarea id="effNotes" value={effectivityNotes} onChange={(e) => setEffectivityNotes(e.target.value)} />
      </div>
      <p className="text-xs text-muted-foreground">
        New orders start as a draft. Submit, approve, and implement them from the order page.
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => router.push('/engineering/eco')} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting || !title.trim()}>
          {submitting ? 'Creating…' : 'Create order'}
        </Button>
      </div>
    </form>
  )
}
