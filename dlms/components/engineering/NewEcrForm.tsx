'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { createEcrAction } from '@/app/(platform)/engineering/ecr/ecrActions'

type Option = { id: string; label: string }
type Props = { variantOptions: Option[] }

const NONE = '__none__' // Radix Select cannot hold an empty-string value
const PRIORITIES = [
  { value: 'low', label: 'Low' }, { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' }, { value: 'urgent', label: 'Urgent' },
]

export function NewEcrForm({ variantOptions }: Props) {
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [priority, setPriority] = useState('normal')
  const [reason, setReason] = useState('')
  const [description, setDescription] = useState('')
  const [variantId, setVariantId] = useState(NONE)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await createEcrAction({
        title: title.trim(),
        priority: priority as 'low' | 'normal' | 'high' | 'urgent',
        reason: reason.trim() || undefined,
        description: description.trim() || undefined,
        variantId: variantId === NONE ? undefined : variantId,
      })
      if (!res.ok) { setError(res.error); toast.error(res.error); return }
      toast.success(`Created ${res.data.ecrNo}`)
      router.push(`/engineering/ecr/${res.data.id}`)
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
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="priority" className="mb-1.5 block">Priority</Label>
          <Select value={priority} onValueChange={setPriority}>
            <SelectTrigger id="priority"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PRIORITIES.map((p) => <SelectItem key={p.value} value={p.value}>{p.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="variant" className="mb-1.5 block">Affected variant</Label>
          <Select value={variantId} onValueChange={setVariantId}>
            <SelectTrigger id="variant"><SelectValue placeholder="—" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>—</SelectItem>
              {variantOptions.map((v) => <SelectItem key={v.id} value={v.id}>{v.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
      </div>
      <div>
        <Label htmlFor="reason" className="mb-1.5 block">Reason for change</Label>
        <Textarea id="reason" value={reason} onChange={(e) => setReason(e.target.value)} />
      </div>
      <div>
        <Label htmlFor="description" className="mb-1.5 block">Description</Label>
        <Textarea id="description" value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <p className="text-xs text-muted-foreground">
        New requests start as a draft. Submit and accept/reject them from the request page.
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => router.push('/engineering/ecr')} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting || !title.trim()}>
          {submitting ? 'Creating…' : 'Create request'}
        </Button>
      </div>
    </form>
  )
}
