'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import { createTypeAction, updateTypeAction } from '@/app/(platform)/manufacturing/components/actions'
import type { ComponentTypeRow } from '@/modules/manufacturing/services/componentCatalogueService'
import { Pencil, Plus } from 'lucide-react'

type ComponentCatalogueProps = {
  types: ComponentTypeRow[]
  canManage: boolean
}

type FormValues = {
  code: string
  name: string
  trackingMode: 'serialized' | 'batch'
  requiresFirmware: boolean
  active: boolean
  sort: number
}

const EMPTY: FormValues = {
  code: '', name: '', trackingMode: 'serialized', requiresFirmware: false, active: true, sort: 0,
}

function trackingModeLabel(mode: 'serialized' | 'batch'): string {
  return mode === 'serialized' ? 'Serialized' : 'Batch'
}

/**
 * Admin console for the component-type catalogue (spec §11). tracking_mode is
 * immutable after creation — component_installation rows are already shaped
 * by it (serialized -> a component_unit row, batch -> a batch_no string), so
 * it's only ever selectable in the Add dialog; the edit form shows the
 * existing value read-only for context.
 */
export function ComponentCatalogue({ types, canManage }: ComponentCatalogueProps) {
  const router = useRouter()
  const [addOpen, setAddOpen] = useState(false)
  const [editing, setEditing] = useState<ComponentTypeRow | null>(null)
  const [formError, setFormError] = useState<string | null>(null)
  const [submitting, setSubmitting] = useState(false)

  async function handleCreate(values: FormValues) {
    setSubmitting(true)
    setFormError(null)
    try {
      const res = await createTypeAction({
        code: values.code.trim().toLowerCase(),
        name: values.name.trim(),
        trackingMode: values.trackingMode,
        requiresFirmware: values.requiresFirmware,
      })
      if (!res.ok) {
        setFormError(res.error)
        toast.error(res.error)
        return
      }
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
      const res = await updateTypeAction(
        editing.id,
        {
          name: values.name.trim(),
          requiresFirmware: values.requiresFirmware,
          active: values.active,
          sort: values.sort,
        },
        editing.version,
      )
      if (!res.ok) {
        setFormError(res.error)
        toast.error(res.error)
        return
      }
      toast.success('Component type updated')
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
            Add type
          </Button>
        </div>
      )}

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Code</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Tracking mode</TableHead>
              <TableHead>Firmware</TableHead>
              <TableHead>Active</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {types.length === 0 ? (
              <TableRow>
                <TableCell colSpan={6} className="py-8 text-center text-muted-foreground">
                  No component types yet.
                </TableCell>
              </TableRow>
            ) : (
              types.map((t) => (
                <TableRow key={t.id}>
                  <TableCell className="font-mono text-xs">{t.code}</TableCell>
                  <TableCell className="font-medium text-slate-900">{t.name}</TableCell>
                  <TableCell>
                    <Badge variant={t.trackingMode === 'serialized' ? 'info' : 'gray'}>
                      {trackingModeLabel(t.trackingMode)}
                    </Badge>
                  </TableCell>
                  <TableCell>
                    {t.requiresFirmware
                      ? <Badge variant="warning">Requires firmware</Badge>
                      : <span className="text-xs text-muted-foreground">—</span>}
                  </TableCell>
                  <TableCell>
                    {t.active
                      ? <Badge variant="success">Active</Badge>
                      : <Badge variant="gray">Deactivated</Badge>}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end">
                      <Button
                        size="sm" variant="ghost"
                        title={canManage ? 'Edit' : "You don't have permission to edit component types"}
                        disabled={!canManage}
                        onClick={() => { setFormError(null); setEditing(t) }}
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

      {/* Add dialog */}
      <Dialog open={addOpen} onOpenChange={(open) => { if (!open) setAddOpen(false) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Add component type</DialogTitle>
          </DialogHeader>
          <ComponentTypeForm
            mode="create"
            initial={EMPTY}
            submitting={submitting}
            error={formError}
            onCancel={() => setAddOpen(false)}
            onSubmit={handleCreate}
          />
        </DialogContent>
      </Dialog>

      {/* Edit dialog */}
      <Dialog open={editing !== null} onOpenChange={(open) => { if (!open) setEditing(null) }}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Edit component type — {editing?.name}</DialogTitle>
          </DialogHeader>
          {editing && (
            <ComponentTypeForm
              mode="edit"
              initial={{
                code: editing.code,
                name: editing.name,
                trackingMode: editing.trackingMode,
                requiresFirmware: editing.requiresFirmware,
                active: editing.active,
                sort: editing.sort,
              }}
              submitting={submitting}
              error={formError}
              onCancel={() => setEditing(null)}
              onSubmit={handleUpdate}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  )
}

type ComponentTypeFormProps = {
  mode: 'create' | 'edit'
  initial: FormValues
  submitting: boolean
  error: string | null
  onCancel: () => void
  onSubmit: (values: FormValues) => void
}

const CODE_PATTERN = /^[a-z0-9_]+$/

/**
 * Shared form for creating a component type and editing an existing one.
 * trackingMode is only an active choice in create mode — the select is
 * disabled in edit mode and shows the existing value for context, because
 * changing it would retroactively reinterpret every past installation of
 * this type (serialized <-> unit, batch <-> batch_no).
 */
function ComponentTypeForm({
  mode, initial, submitting, error, onCancel, onSubmit,
}: ComponentTypeFormProps) {
  const [code, setCode] = useState(initial.code)
  const [name, setName] = useState(initial.name)
  const [trackingMode, setTrackingMode] = useState<'serialized' | 'batch'>(initial.trackingMode)
  const [requiresFirmware, setRequiresFirmware] = useState(initial.requiresFirmware)
  const [active, setActive] = useState(initial.active)
  const [sort, setSort] = useState(initial.sort)

  function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    onSubmit({ code, name, trackingMode, requiresFirmware, active, sort })
  }

  const canSubmit = mode === 'create'
    ? CODE_PATTERN.test(code.trim()) && name.trim().length > 0
    : name.trim().length > 0

  return (
    <form onSubmit={handleSubmit} className="space-y-4">
      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      )}

      <div>
        <Label htmlFor="ct-code" className="mb-1.5 block">Code</Label>
        <Input
          id="ct-code"
          value={code}
          disabled={mode === 'edit'}
          onChange={(e) => setCode(e.target.value)}
          placeholder="e.g. sensor_board"
        />
        <p className="mt-1 text-xs text-muted-foreground">
          Lowercase letters, digits, and underscores only. Cannot be changed after creation.
        </p>
      </div>

      <div>
        <Label htmlFor="ct-name" className="mb-1.5 block">Name</Label>
        <Input id="ct-name" value={name} onChange={(e) => setName(e.target.value)} />
      </div>

      <div>
        <Label htmlFor="ct-tracking-mode" className="mb-1.5 block">Tracking mode</Label>
        <Select
          value={trackingMode}
          disabled={mode === 'edit'}
          onValueChange={(v) => setTrackingMode(v as 'serialized' | 'batch')}
        >
          <SelectTrigger id="ct-tracking-mode"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="serialized">Serialized (one unit per physical part)</SelectItem>
            <SelectItem value="batch">Batch (quantity + batch number)</SelectItem>
          </SelectContent>
        </Select>
        {mode === 'edit' && (
          <p className="mt-1 text-xs text-muted-foreground">
            Read-only after creation — changing it would reinterpret every existing
            installation of this type.
          </p>
        )}
      </div>

      <label htmlFor="ct-requires-firmware" className="flex items-center gap-2 text-sm text-slate-700">
        <input
          id="ct-requires-firmware"
          type="checkbox"
          className="rounded border-gray-300"
          checked={requiresFirmware}
          onChange={(e) => setRequiresFirmware(e.target.checked)}
        />
        Requires firmware
      </label>

      {mode === 'edit' && (
        <>
          <label htmlFor="ct-active" className="flex items-center gap-2 text-sm text-slate-700">
            <input
              id="ct-active"
              type="checkbox"
              className="rounded border-gray-300"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            Active
          </label>

          <div>
            <Label htmlFor="ct-sort" className="mb-1.5 block">Sort order</Label>
            <Input
              id="ct-sort"
              type="number"
              value={sort}
              onChange={(e) => setSort(Number(e.target.value))}
            />
          </div>
        </>
      )}

      <div className="flex justify-end gap-2 pt-1">
        <Button type="button" variant="outline" onClick={onCancel} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting || !canSubmit}>
          {submitting ? 'Saving…' : mode === 'create' ? 'Add type' : 'Save changes'}
        </Button>
      </div>
    </form>
  )
}
