'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { createLocationAction, updateLocationAction } from '@/app/(platform)/logistics/locations/actions'
import type { StockLocationRow } from '@/modules/logistics/services/locationService'
import { Pencil, Plus } from 'lucide-react'

type LocationCatalogueProps = {
  locations: StockLocationRow[]
  canManage: boolean
}

type FormValues = {
  code: string
  name: string
  country: string
  address: string
  notes: string
  active: boolean
}

const EMPTY: FormValues = { code: '', name: '', country: '', address: '', notes: '', active: true }

/**
 * Stock location catalogue (Basic Logistics scope: identity + address/notes,
 * no stock-level accounting). Mirrors
 * components/manufacturing/ComponentCatalogue.tsx's single-page list +
 * add/edit dialog shape — the simplest house pattern for a small admin-
 * managed catalogue table.
 */
export function LocationCatalogue({ locations, canManage }: LocationCatalogueProps) {
  const router = useRouter()
  const [addOpen, setAddOpen] = useState(false)
  const [editing, setEditing] = useState<StockLocationRow | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleCreate(values: FormValues) {
    setSubmitting(true)
    setFormError(null)
    try {
      const res = await createLocationAction({
        code: values.code.trim(),
        name: values.name.trim(),
        country: values.country.trim() || undefined,
        address: values.address.trim() || undefined,
        notes: values.notes.trim() || undefined,
      })
      if (!res.ok) { setFormError(res.error); toast.error(res.error); return }
      toast.success(`Created ${values.name}`)
      setAddOpen(false)
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  async function handleUpdate(values: FormValues) {
    if (!editing) return
    setSubmitting(true)
    setFormError(null)
    try {
      const res = await updateLocationAction(
        editing.id,
        {
          code: values.code.trim(),
          name: values.name.trim(),
          country: values.country.trim() || null,
          address: values.address.trim() || null,
          notes: values.notes.trim() || null,
          active: values.active,
        },
        editing.version,
      )
      if (!res.ok) { setFormError(res.error); toast.error(res.error); return }
      toast.success('Location updated')
      setEditing(null)
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="space-y-4">
      {canManage && (
        <div className="flex justify-end">
          <Button size="sm" onClick={() => { setFormError(null); setAddOpen(true) }}>
            <Plus className="mr-1.5 h-4 w-4" />
            Add location
          </Button>
        </div>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Country</TableHead>
              <TableHead>Active</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {locations.length === 0 ? (
              <TableRow>
                <TableCell colSpan={5} className="py-8 text-center text-muted-foreground">
                  No stock locations yet.
                </TableCell>
              </TableRow>
            ) : (
              locations.map((l) => (
                <TableRow key={l.id}>
                  <TableCell className="font-mono text-xs">{l.code}</TableCell>
                  <TableCell className="font-medium text-slate-900">{l.name}</TableCell>
                  <TableCell>{l.country ?? '—'}</TableCell>
                  <TableCell>
                    {l.active
                      ? <Badge variant="success">Active</Badge>
                      : <Badge variant="gray">Deactivated</Badge>}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end">
                      <Button
                        size="sm" variant="ghost"
                        title={canManage ? 'Edit' : "You don't have permission to edit locations"}
                        disabled={!canManage}
                        onClick={() => { setFormError(null); setEditing(l) }}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog open={addOpen} onOpenChange={(open) => { if (!open) setAddOpen(false) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Add stock location</DialogTitle></DialogHeader>
          <LocationForm
            mode="create" initial={EMPTY} submitting={submitting} error={formError}
            onCancel={() => setAddOpen(false)} onSubmit={handleCreate}
          />
        </DialogContent>
      </Dialog>

      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Edit location — {editing?.name}</DialogTitle></DialogHeader>
          {editing && (
            <LocationForm
              mode="edit"
              initial={{
                code: editing.code, name: editing.name, country: editing.country ?? '',
                address: editing.address ?? '', notes: editing.notes ?? '', active: editing.active,
              }}
              submitting={submitting} error={formError}
              onCancel={() => setEditing(null)} onSubmit={handleUpdate}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

type LocationFormProps = {
  mode: 'create' | 'edit'
  initial: FormValues
  submitting: boolean
  error: string | null
  onCancel: () => void
  onSubmit: (values: FormValues) => void
}

function LocationForm({ mode, initial, submitting, error, onCancel, onSubmit }: LocationFormProps) {
  const [code, setCode] = useState(initial.code)
  const [name, setName] = useState(initial.name)
  const [country, setCountry] = useState(initial.country)
  const [address, setAddress] = useState(initial.address)
  const [notes, setNotes] = useState(initial.notes)
  const [active, setActive] = useState(initial.active)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    onSubmit({ code, name, country, address, notes, active })
  }

  const canSubmit = code.trim().length > 0 && name.trim().length > 0

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      )}

      <div>
        <Label htmlFor="loc-code" className="mb-1.5 block">Code</Label>
        <Input id="loc-code" value={code} onChange={(e) => setCode(e.target.value)} placeholder="e.g. SG-WH1" />
      </div>

      <div>
        <Label htmlFor="loc-name" className="mb-1.5 block">Name</Label>
        <Input id="loc-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div>
        <Label htmlFor="loc-country" className="mb-1.5 block">Country</Label>
        <Input id="loc-country" value={country} onChange={(e) => setCountry(e.target.value)} placeholder="SG / MY" />
      </div>

      <div>
        <Label htmlFor="loc-address" className="mb-1.5 block">Address</Label>
        <Textarea id="loc-address" value={address} onChange={(e) => setAddress(e.target.value)} />
      </div>

      <div>
        <Label htmlFor="loc-notes" className="mb-1.5 block">Notes</Label>
        <Textarea id="loc-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>

      {mode === 'edit' && (
        <label htmlFor="loc-active" className="flex items-center gap-2 text-sm text-slate-700">
          <input
            id="loc-active" type="checkbox" className="rounded border-gray-300"
            checked={active} onChange={(e) => setActive(e.target.checked)}
          />
          Active
        </label>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting || !canSubmit}>
          {submitting ? 'Saving…' : mode === 'create' ? 'Add location' : 'Save changes'}
        </Button>
      </div>
    </form>
  )
}
