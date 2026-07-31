'use client'

import { useEffect, useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus, Repeat } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { Table, TableHeader, TableBody, TableRow, TableHead, TableCell } from '@/components/ui/table'
import {
  replaceComponentAction, installComponentAction, listAvailableUnitsAction, type AvailableUnit,
} from '@/app/(platform)/manufacturing/devices/[id]/componentActions'
import type {
  CurrentComponent, InstallationHistoryItem,
} from '@/modules/manufacturing/services/componentService'
import type { ComponentTypeRow } from '@/modules/manufacturing/services/componentCatalogueService'

/**
 * The maintenance record a replacement made from this surface is attributed to
 * (spec §5.4). Present when the panel is rendered from inside a repair or a
 * modification; absent on the device profile, where a swap stands alone.
 */
export type ReplacementAttribution = {
  repairId?: string
  modificationId?: string
  /** Human label of that record ("REP-2026-0012") for the dialog's confirmation line. */
  label: string
}

type DeviceComponentsPanelProps = {
  deviceId: string
  canEdit: boolean
  current: CurrentComponent[]
  history: InstallationHistoryItem[]
  types: ComponentTypeRow[]
  attribution?: ReplacementAttribution
}

function formatDate(d: Date | string): string {
  return new Date(d).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' })
}

function formatDateTime(d: Date | string): string {
  return new Date(d).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

function serialOrBatch(row: { unit: { serialNo: string } | null; batchNo: string | null }): string {
  return row.unit?.serialNo ?? row.batchNo ?? '—'
}

type HistoryGroup = { key: string; typeName: string; slotNo: number; items: InstallationHistoryItem[] }

/**
 * getDeviceComponents already orders by (type, slot, installed_at DESC), so
 * this grouping only needs to preserve first-seen order — it doesn't re-sort.
 */
function groupHistory(history: InstallationHistoryItem[]): HistoryGroup[] {
  const groups = new Map<string, HistoryGroup>()
  for (const item of history) {
    const key = `${item.componentTypeCode}__${item.slotNo}`
    const existing = groups.get(key)
    if (existing) existing.items.push(item)
    else groups.set(key, { key, typeName: item.componentTypeName, slotNo: item.slotNo, items: [item] })
  }
  return Array.from(groups.values())
}

/**
 * Client panel behind DeviceComponentsTab. Replace/Add controls render only
 * when canEdit; viewing current + history needs nothing beyond the page's
 * existing view_records gate.
 *
 * ONE panel serves both the device profile and the repair detail page — the
 * §5.4 promise is "the engineer performs one action; the system fans out", and
 * a second replacement dialog to keep in step with this one would be exactly
 * the double entry that rule exists to remove. The only difference in
 * attributed mode is which extra ids ride along on the replace call, plus:
 * Add-component is hidden, because installComponent takes no repair/
 * modification id, so an install started from a repair would silently lose the
 * attribution the technician came here to record.
 */
export function DeviceComponentsPanel({
  deviceId, canEdit, current, history, types, attribution,
}: DeviceComponentsPanelProps) {
  const router = useRouter()
  const [replaceTarget, setReplaceTarget] = useState<CurrentComponent | null>(null)
  const [addOpen, setAddOpen] = useState(false)

  const typeByCode = new Map(types.map((t) => [t.code, t]))
  const activeTypes = types.filter((t) => t.active)
  const historyGroups = groupHistory(history)

  function handleDone(message: string) {
    toast.success(message)
    setReplaceTarget(null)
    setAddOpen(false)
    router.refresh()
  }

  return (
    <div className="space-y-6">
      <section className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold text-slate-900">Current components</h3>
          {canEdit && !attribution && (
            <Button size="sm" onClick={() => setAddOpen(true)}>
              <Plus className="mr-1.5 h-4 w-4" />
              Add component
            </Button>
          )}
        </div>
        <div className="rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Type</TableHead>
                <TableHead>Slot</TableHead>
                <TableHead>Serial / batch</TableHead>
                <TableHead>Installed</TableHead>
                <TableHead>By</TableHead>
                {canEdit && <TableHead className="text-right">Actions</TableHead>}
              </TableRow>
            </TableHeader>
            <TableBody>
              {current.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={canEdit ? 6 : 5} className="py-8 text-center text-muted-foreground">
                    No components recorded yet.
                  </TableCell>
                </TableRow>
              ) : (
                current.map((c) => (
                  <TableRow key={c.installationId}>
                    <TableCell className="font-medium text-slate-900">{c.componentTypeName}</TableCell>
                    <TableCell>{c.slotNo}</TableCell>
                    <TableCell className="font-mono text-xs">{serialOrBatch(c)}</TableCell>
                    <TableCell>{formatDate(c.installedAt)}</TableCell>
                    <TableCell>{c.installedByName}</TableCell>
                    {canEdit && (
                      <TableCell>
                        <div className="flex justify-end">
                          <Button size="sm" variant="outline" onClick={() => setReplaceTarget(c)}>
                            <Repeat className="mr-1.5 h-3.5 w-3.5" />
                            Replace
                          </Button>
                        </div>
                      </TableCell>
                    )}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>
      </section>

      <section className="space-y-2">
        <h3 className="text-sm font-semibold text-slate-900">Installation history</h3>
        {historyGroups.length === 0 ? (
          <p className="rounded-md border p-4 text-sm text-muted-foreground">
            No components recorded yet.
          </p>
        ) : (
          <div className="space-y-4">
            {historyGroups.map((g) => (
              <div key={g.key} className="rounded-md border p-4">
                <p className="text-sm font-medium text-slate-900">{g.typeName} · slot {g.slotNo}</p>
                <ol className="mt-2 space-y-3 border-l pl-4">
                  {g.items.map((item) => (
                    <li key={item.installationId}>
                      <p className="text-sm text-slate-900">
                        Installed {formatDateTime(item.installedAt)} · {item.installedByName}
                      </p>
                      <p className="text-xs text-muted-foreground">{serialOrBatch(item)}</p>
                      {item.removedAt ? (
                        <p className="mt-1 text-sm text-slate-700">
                          Removed {formatDateTime(item.removedAt)} · {item.removedByName}
                          {item.removalReason ? ` — ${item.removalReason}` : ''}
                        </p>
                      ) : (
                        <Badge variant="success" className="mt-1">Currently installed</Badge>
                      )}
                    </li>
                  ))}
                </ol>
              </div>
            ))}
          </div>
        )}
      </section>

      {replaceTarget && (
        <ReplaceDialog
          deviceId={deviceId}
          target={replaceTarget}
          trackingMode={typeByCode.get(replaceTarget.componentTypeCode)?.trackingMode ?? 'serialized'}
          componentTypeId={typeByCode.get(replaceTarget.componentTypeCode)?.id ?? ''}
          attribution={attribution}
          onClose={() => setReplaceTarget(null)}
          onDone={() => handleDone('Component replaced')}
        />
      )}

      {addOpen && (
        <AddDialog
          deviceId={deviceId}
          types={activeTypes}
          onClose={() => setAddOpen(false)}
          onDone={() => handleDone('Component added')}
        />
      )}
    </div>
  )
}

type ReplaceDialogProps = {
  deviceId: string
  target: CurrentComponent
  trackingMode: 'serialized' | 'batch'
  componentTypeId: string
  attribution?: ReplacementAttribution
  onClose: () => void
  onDone: () => void
}

function ReplaceDialog({
  deviceId, target, trackingMode, componentTypeId, attribution, onClose, onDone,
}: ReplaceDialogProps) {
  const [reason, setReason] = useState('')
  const [unitId, setUnitId] = useState('')
  const [batchNo, setBatchNo] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSubmit = reason.trim().length > 0
    && (trackingMode === 'serialized' ? unitId.length > 0 : batchNo.trim().length > 0)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await replaceComponentAction(deviceId, {
        removedInstallationId: target.installationId,
        reason: reason.trim(),
        replacementUnitId: trackingMode === 'serialized' ? unitId : undefined,
        replacementBatchNo: trackingMode === 'batch' ? batchNo.trim() : undefined,
        repairId: attribution?.repairId,
        modificationId: attribution?.modificationId,
      })
      if (!res.ok) {
        setError(res.error)
        toast.error(res.error)
        return
      }
      onDone()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Replace {target.componentTypeName} (slot {target.slotNo})</DialogTitle>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
          )}
          <p className="text-sm text-muted-foreground">
            Removing {serialOrBatch(target)}, installed {formatDate(target.installedAt)}.
          </p>
          {attribution && (
            <p className="rounded-md bg-muted px-3 py-2 text-sm text-slate-700">
              This replacement will be recorded against <strong>{attribution.label}</strong>.
            </p>
          )}

          <UnitOrBatchField
            trackingMode={trackingMode}
            componentTypeId={componentTypeId}
            excludeUnitId={target.unit?.id ?? null}
            unitId={unitId}
            onUnitIdChange={setUnitId}
            batchNo={batchNo}
            onBatchNoChange={setBatchNo}
            idPrefix="replace"
            unitLabel="Replacement unit"
          />

          <div>
            <Label htmlFor="replace-reason" className="mb-1.5 block">Reason (required)</Label>
            <Textarea
              id="replace-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Why is this component being replaced?"
            />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !canSubmit}>
              {submitting ? 'Replacing…' : 'Replace'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

type AddDialogProps = {
  deviceId: string
  types: ComponentTypeRow[]
  onClose: () => void
  onDone: () => void
}

function AddDialog({ deviceId, types, onClose, onDone }: AddDialogProps) {
  const [componentTypeId, setComponentTypeId] = useState(types[0]?.id ?? '')
  const [slotNo, setSlotNo] = useState(1)
  const [unitId, setUnitId] = useState('')
  const [batchNo, setBatchNo] = useState('')
  const [notes, setNotes] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const selectedType = types.find((t) => t.id === componentTypeId) ?? null
  const trackingMode = selectedType?.trackingMode ?? 'serialized'
  const canSubmit = componentTypeId.length > 0 && slotNo >= 1
    && (trackingMode === 'serialized' ? unitId.length > 0 : batchNo.trim().length > 0)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await installComponentAction(deviceId, {
        componentTypeId,
        slotNo,
        unitId: trackingMode === 'serialized' ? unitId : undefined,
        batchNo: trackingMode === 'batch' ? batchNo.trim() : undefined,
        notes: notes.trim() || undefined,
      })
      if (!res.ok) {
        setError(res.error)
        toast.error(res.error)
        return
      }
      onDone()
    } finally {
      setSubmitting(false)
    }
  }

  if (types.length === 0) {
    return (
      <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
        <DialogContent className="max-w-lg">
          <DialogHeader><DialogTitle>Add component</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">
            No active component types are defined yet — add one under Component types first.
          </p>
          <div className="flex justify-end pt-1">
            <Button variant="outline" onClick={onClose}>Close</Button>
          </div>
        </DialogContent>
      </Dialog>
    )
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose() }}>
      <DialogContent className="max-w-lg">
        <DialogHeader><DialogTitle>Add component</DialogTitle></DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
          )}

          <div>
            <Label htmlFor="add-type" className="mb-1.5 block">Component type</Label>
            <Select
              value={componentTypeId}
              onValueChange={(v) => { setComponentTypeId(v); setUnitId(''); setBatchNo('') }}
            >
              <SelectTrigger id="add-type"><SelectValue /></SelectTrigger>
              <SelectContent>
                {types.map((t) => <SelectItem key={t.id} value={t.id}>{t.name}</SelectItem>)}
              </SelectContent>
            </Select>
          </div>

          <div>
            <Label htmlFor="add-slot" className="mb-1.5 block">Slot</Label>
            <Input
              id="add-slot" type="number" min={1} value={slotNo}
              onChange={(e) => setSlotNo(Number(e.target.value))}
            />
          </div>

          <UnitOrBatchField
            trackingMode={trackingMode}
            componentTypeId={componentTypeId}
            excludeUnitId={null}
            unitId={unitId}
            onUnitIdChange={setUnitId}
            batchNo={batchNo}
            onBatchNoChange={setBatchNo}
            idPrefix="add"
            unitLabel="Unit"
          />

          <div>
            <Label htmlFor="add-notes" className="mb-1.5 block">Notes</Label>
            <Textarea id="add-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>

          <div className="flex justify-end gap-2 pt-1">
            <Button type="button" variant="outline" onClick={onClose} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting || !canSubmit}>
              {submitting ? 'Adding…' : 'Add component'}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}

type UnitOrBatchFieldProps = {
  trackingMode: 'serialized' | 'batch'
  componentTypeId: string
  excludeUnitId: string | null
  unitId: string
  onUnitIdChange: (v: string) => void
  batchNo: string
  onBatchNoChange: (v: string) => void
  idPrefix: string
  unitLabel: string
}

/**
 * Serialized types are replaced/installed by picking an in-stock unit
 * (fetched per componentTypeId via listAvailableUnitsAction — there is no
 * unit-creation flow in this task's scope); batch types take a free-typed
 * batch number. excludeUnitId keeps the Replace dialog from offering the very
 * unit being removed (assertReplacementShape rejects that server-side too, so
 * this is a UX nicety, not the enforcement point).
 */
function UnitOrBatchField({
  trackingMode, componentTypeId, excludeUnitId, unitId, onUnitIdChange,
  batchNo, onBatchNoChange, idPrefix, unitLabel,
}: UnitOrBatchFieldProps) {
  const [units, setUnits] = useState<AvailableUnit[]>([])
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    if (trackingMode !== 'serialized' || !componentTypeId) {
      setUnits([])
      return
    }
    let cancelled = false
    setLoading(true)
    listAvailableUnitsAction(componentTypeId)
      .then((res) => {
        if (cancelled) return
        if (res.ok) {
          setUnits(res.units)
        } else {
          setUnits([])
          toast.error(res.error)
        }
      })
      .catch(() => { if (!cancelled) toast.error('Could not load available units') })
      .finally(() => { if (!cancelled) setLoading(false) })
    return () => { cancelled = true }
  }, [trackingMode, componentTypeId])

  if (trackingMode === 'batch') {
    return (
      <div>
        <Label htmlFor={`${idPrefix}-batch`} className="mb-1.5 block">Batch number</Label>
        <Input
          id={`${idPrefix}-batch`}
          value={batchNo}
          onChange={(e) => onBatchNoChange(e.target.value)}
          placeholder="e.g. LOT-2026-014"
        />
      </div>
    )
  }

  const options = units.filter((u) => u.id !== excludeUnitId)

  return (
    <div>
      <Label htmlFor={`${idPrefix}-unit`} className="mb-1.5 block">{unitLabel}</Label>
      <Select value={unitId} onValueChange={onUnitIdChange} disabled={loading || options.length === 0}>
        <SelectTrigger id={`${idPrefix}-unit`}>
          <SelectValue placeholder={loading ? 'Loading…' : 'Select a unit'} />
        </SelectTrigger>
        <SelectContent>
          {options.map((u) => <SelectItem key={u.id} value={u.id}>{u.serialNo}</SelectItem>)}
        </SelectContent>
      </Select>
      {!loading && options.length === 0 && (
        <p className="mt-1 text-xs text-muted-foreground">No in-stock units available for this type.</p>
      )}
    </div>
  )
}
