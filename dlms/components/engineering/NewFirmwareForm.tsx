'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { createFirmwareAction } from '@/app/(platform)/engineering/firmware/firmwareActions'

type Option = { id: string; label: string }
type Props = { componentTypeOptions: Option[] }

export function NewFirmwareForm({ componentTypeOptions }: Props) {
  const router = useRouter()
  const [componentTypeId, setComponentTypeId] = useState(componentTypeOptions[0]?.id ?? '')
  const [fwVersion, setFwVersion] = useState('')
  const [releaseDate, setReleaseDate] = useState('')
  const [changelog, setChangelog] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await createFirmwareAction({
        componentTypeId,
        fwVersion: fwVersion.trim(),
        releaseDate: releaseDate || undefined,
        changelog: changelog.trim() || undefined,
      })
      if (!res.ok) { setError(res.error); toast.error(res.error); return }
      toast.success('Firmware release created')
      router.push(`/engineering/firmware/${res.data.id}`)
    } finally {
      setSubmitting(false)
    }
  }

  const noTypes = componentTypeOptions.length === 0

  return (
    <form onSubmit={handleSubmit} className="max-w-2xl space-y-4">
      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      )}
      {noTypes && (
        <p className="rounded-md bg-yellow-100 px-3 py-2 text-sm text-yellow-800">
          No component types exist yet. Add one in Manufacturing → Components first.
        </p>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="componentType" className="mb-1.5 block">Component type (required)</Label>
          <Select value={componentTypeId} onValueChange={setComponentTypeId} disabled={noTypes}>
            <SelectTrigger id="componentType"><SelectValue placeholder="Select…" /></SelectTrigger>
            <SelectContent>
              {componentTypeOptions.map((c) => <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="fwVersion" className="mb-1.5 block">Version (required)</Label>
          <Input id="fwVersion" value={fwVersion} onChange={(e) => setFwVersion(e.target.value)} placeholder="e.g. 1.4.2" required />
        </div>
        <div>
          <Label htmlFor="releaseDate" className="mb-1.5 block">Release date</Label>
          <Input id="releaseDate" type="date" value={releaseDate} onChange={(e) => setReleaseDate(e.target.value)} />
        </div>
      </div>
      <div>
        <Label htmlFor="changelog" className="mb-1.5 block">Changelog / notes</Label>
        <Textarea id="changelog" value={changelog} onChange={(e) => setChangelog(e.target.value)} />
      </div>
      <p className="text-xs text-muted-foreground">
        New releases start as a draft. Release and withdraw them from the release page.
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => router.push('/engineering/firmware')} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting || noTypes || !componentTypeId || !fwVersion.trim()}>
          {submitting ? 'Creating…' : 'Create release'}
        </Button>
      </div>
    </form>
  )
}
