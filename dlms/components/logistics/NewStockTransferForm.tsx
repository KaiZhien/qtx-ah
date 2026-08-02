'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  createStockTransferAction, loadTransferOptionsAction,
} from '@/app/(platform)/logistics/transfers/actions'
import type { StockLocationRow } from '@/modules/logistics/services/locationService'
import type { TransferOptions } from '@/modules/logistics/services/stockTransferService'

type BatchDraft = { componentTypeId: string; qty: string }

/**
 * Create a stock transfer.
 *
 * The batch/serialized split is presented as TWO separate line lists on
 * purpose. It is not a display preference: a line is either a quantity of a
 * batch-tracked type or one specific serialized unit, enforced by a CHECK
 * constraint, and a single merged editor would invite users to build the
 * half-populated line the constraint rejects. The option lists come from the
 * chosen source location, so a clerk can only pick what is actually there.
 */
export function NewStockTransferForm({ locations }: { locations: StockLocationRow[] }) {
  const router = useRouter()
  const [transferNo, setTransferNo] = useState('')
  const [fromLocationId, setFromLocationId] = useState('')
  const [toLocationId, setToLocationId] = useState('')
  const [carrier, setCarrier] = useState('')
  const [reference, setReference] = useState('')
  const [notes, setNotes] = useState('')
  const [batchLines, setBatchLines] = useState<BatchDraft[]>([])
  const [unitIds, setUnitIds] = useState<string[]>([])
  const [options, setOptions] = useState<TransferOptions | null>(null)
  const [submitting, setSubmitting] = useState(false)
  const [loadingOptions, startLoading] = useTransition()
  const [error, setError] = useState<string | null>(null)

  function chooseSource(id: string) {
    setFromLocationId(id)
    // Lines reference what was at the OLD source; clear them rather than carry
    // over picks that are not at the new one.
    setBatchLines([])
    setUnitIds([])
    setOptions(null)
    startLoading(async () => {
      const res = await loadTransferOptionsAction(id)
      if (!res.ok) { setError(res.error); toast.error(res.error); return }
      setOptions(res.data)
    })
  }

  const destinations = locations.filter((l) => l.id !== fromLocationId)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const cleanBatch = batchLines
        .filter((l) => l.componentTypeId && Number(l.qty) > 0)
        .map((l) => ({ componentTypeId: l.componentTypeId, qty: Number(l.qty) }))
      const res = await createStockTransferAction({
        transferNo: transferNo.trim(),
        fromLocationId, toLocationId,
        carrier: carrier.trim() || undefined,
        reference: reference.trim() || undefined,
        notes: notes.trim() || undefined,
        batchLines: cleanBatch,
        serializedLines: unitIds.map((componentUnitId) => ({ componentUnitId })),
      })
      if (!res.ok) { setError(res.error); toast.error(res.error); return }
      toast.success('Stock transfer created')
      router.push(`/logistics/transfers/${res.data.id}`)
    } finally {
      setSubmitting(false)
    }
  }

  const hasLines = batchLines.some((l) => l.componentTypeId && Number(l.qty) > 0) || unitIds.length > 0
  const canSubmit = Boolean(transferNo.trim() && fromLocationId && toLocationId && hasLines)

  return (
    <form onSubmit={handleSubmit} className="max-w-2xl space-y-5">
      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      )}

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="transferNo" className="mb-1.5 block">Transfer number (required)</Label>
          <Input id="transferNo" value={transferNo} onChange={(e) => setTransferNo(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="carrier" className="mb-1.5 block">Carrier</Label>
          <Input id="carrier" value={carrier} onChange={(e) => setCarrier(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="fromLocation" className="mb-1.5 block">From (required)</Label>
          <Select value={fromLocationId} onValueChange={chooseSource}>
            <SelectTrigger id="fromLocation"><SelectValue placeholder="Source location…" /></SelectTrigger>
            <SelectContent>
              {locations.map((l) => (
                <SelectItem key={l.id} value={l.id}>{l.name} ({l.code})</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="toLocation" className="mb-1.5 block">To (required)</Label>
          <Select value={toLocationId} onValueChange={setToLocationId} disabled={!fromLocationId}>
            <SelectTrigger id="toLocation"><SelectValue placeholder="Destination location…" /></SelectTrigger>
            <SelectContent>
              {destinations.map((l) => (
                <SelectItem key={l.id} value={l.id}>{l.name} ({l.code})</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="sm:col-span-2">
          <Label htmlFor="reference" className="mb-1.5 block">Reference</Label>
          <Input id="reference" value={reference} onChange={(e) => setReference(e.target.value)} />
        </div>
      </div>

      {!fromLocationId && (
        <p className="text-sm text-muted-foreground">
          Choose a source location to see what can be transferred out of it.
        </p>
      )}
      {loadingOptions && <p className="text-sm text-muted-foreground">Loading stock at this location…</p>}

      {options && (
        <>
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label className="block">Batch quantities</Label>
              <Button
                type="button" variant="outline" size="sm"
                onClick={() => setBatchLines((p) => [...p, { componentTypeId: '', qty: '1' }])}
                disabled={options.batchTypes.length === 0}
              >
                <Plus className="mr-1.5 h-3.5 w-3.5" />
                Add quantity line
              </Button>
            </div>
            {options.batchTypes.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No batch-tracked component types in the catalogue.
              </p>
            ) : batchLines.length === 0 ? (
              <p className="text-sm text-muted-foreground">No quantity lines yet.</p>
            ) : (
              batchLines.map((line, i) => (
                <div key={i} className="flex items-start gap-2">
                  <Select
                    value={line.componentTypeId}
                    onValueChange={(v) => setBatchLines((p) =>
                      p.map((l, idx) => (idx === i ? { ...l, componentTypeId: v } : l)))}
                  >
                    <SelectTrigger className="flex-1"><SelectValue placeholder="Component type…" /></SelectTrigger>
                    <SelectContent>
                      {options.batchTypes.map((t) => (
                        <SelectItem key={t.componentTypeId} value={t.componentTypeId}>
                          {t.name} · {t.availableQty} on hand
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                  <Input
                    type="number" min="0.001" step="0.001" className="w-28"
                    value={line.qty}
                    onChange={(e) => setBatchLines((p) =>
                      p.map((l, idx) => (idx === i ? { ...l, qty: e.target.value } : l)))}
                  />
                  <Button
                    type="button" variant="ghost" size="sm"
                    onClick={() => setBatchLines((p) => p.filter((_, idx) => idx !== i))}
                    aria-label="Remove line"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              ))
            )}
          </div>

          <div className="space-y-2">
            <Label className="block">Serialized units</Label>
            {options.units.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No serialized units recorded at this location.
              </p>
            ) : (
              <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-3">
                {options.units.map((u) => (
                  <label key={u.componentUnitId} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="h-4 w-4"
                      checked={unitIds.includes(u.componentUnitId)}
                      onChange={(e) => setUnitIds((prev) => e.target.checked
                        ? [...prev, u.componentUnitId]
                        : prev.filter((id) => id !== u.componentUnitId))}
                    />
                    <span className="font-medium text-slate-900">{u.serialNo}</span>
                    <span className="text-muted-foreground">{u.componentTypeCode}</span>
                    {u.locationId === null && (
                      <span className="text-xs text-muted-foreground">· location not recorded</span>
                    )}
                  </label>
                ))}
              </div>
            )}
          </div>
        </>
      )}

      <div>
        <Label htmlFor="notes" className="mb-1.5 block">Notes</Label>
        <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>

      <p className="text-xs text-muted-foreground">
        New transfers start in Draft and move no stock. Balances change only when the transfer is
        received at its destination.
      </p>
      <div className="flex justify-end gap-2">
        <Button
          type="button" variant="outline"
          onClick={() => router.push('/logistics/transfers')}
          disabled={submitting}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={submitting || !canSubmit}>
          {submitting ? 'Creating…' : 'Create transfer'}
        </Button>
      </div>
    </form>
  )
}
