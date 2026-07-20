'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { createDeliveryOrderAction } from '@/app/(platform)/logistics/delivery-orders/deliveryOrderWriteActions'

type LineDraft = { description: string; quantity: string }

const EMPTY_LINE: LineDraft = { description: '', quantity: '1' }

/**
 * Create a delivery order (Basic scope). Line items here are description +
 * quantity only — linking a line to a specific device.id is supported by the
 * schema/service (delivery_order_line.device_id) but left out of this create
 * form to keep the picker UI out of Basic scope; a line can be pointed at a
 * device later via a direct edit if that need arises.
 */
export function NewDeliveryOrderForm() {
  const router = useRouter()
  const [doNo, setDoNo] = useState('')
  const [customer, setCustomer] = useState('')
  const [destination, setDestination] = useState('')
  const [shipDate, setShipDate] = useState('')
  const [carrier, setCarrier] = useState('')
  const [importExportRef, setImportExportRef] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<LineDraft[]>([{ ...EMPTY_LINE }])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function updateLine(i: number, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  }
  function addLine() {
    setLines((prev) => [...prev, { ...EMPTY_LINE }])
  }
  function removeLine(i: number) {
    setLines((prev) => prev.filter((_, idx) => idx !== i))
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const cleanLines = lines
        .filter((l) => l.description.trim() || Number(l.quantity) > 0)
        .map((l) => ({
          description: l.description.trim() || undefined,
          quantity: Number(l.quantity) > 0 ? Number(l.quantity) : 1,
        }))
      const res = await createDeliveryOrderAction({
        doNo: doNo.trim(),
        customer: customer.trim() || undefined,
        destination: destination.trim() || undefined,
        shipDate: shipDate || undefined,
        carrier: carrier.trim() || undefined,
        importExportRef: importExportRef.trim() || undefined,
        notes: notes.trim() || undefined,
        lines: cleanLines,
      })
      if (!res.ok) { setError(res.error); toast.error(res.error); return }
      toast.success('Delivery order created')
      router.push(`/logistics/delivery-orders/${res.data.id}`)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <form onSubmit={handleSubmit} className="max-w-2xl space-y-4">
      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="doNo" className="mb-1.5 block">DO number (required)</Label>
          <Input id="doNo" value={doNo} onChange={(e) => setDoNo(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="customer" className="mb-1.5 block">Customer</Label>
          <Input id="customer" value={customer} onChange={(e) => setCustomer(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="destination" className="mb-1.5 block">Destination</Label>
          <Input id="destination" value={destination} onChange={(e) => setDestination(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="carrier" className="mb-1.5 block">Carrier</Label>
          <Input id="carrier" value={carrier} onChange={(e) => setCarrier(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="shipDate" className="mb-1.5 block">Ship date</Label>
          <Input id="shipDate" type="date" value={shipDate} onChange={(e) => setShipDate(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="importExportRef" className="mb-1.5 block">Import/export doc ref</Label>
          <Input id="importExportRef" value={importExportRef} onChange={(e) => setImportExportRef(e.target.value)} />
        </div>
      </div>
      <div>
        <Label htmlFor="notes" className="mb-1.5 block">Notes</Label>
        <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label className="block">Lines</Label>
          <Button type="button" variant="outline" size="sm" onClick={addLine}>
            <Plus className="mr-1.5 h-3.5 w-3.5" />
            Add line
          </Button>
        </div>
        <div className="space-y-2">
          {lines.map((line, i) => (
            <div key={i} className="flex items-start gap-2">
              <Input
                value={line.description}
                onChange={(e) => updateLine(i, { description: e.target.value })}
                placeholder="Description"
                className="flex-1"
              />
              <Input
                type="number" min="0.01" step="0.01"
                value={line.quantity}
                onChange={(e) => updateLine(i, { quantity: e.target.value })}
                className="w-24"
              />
              <Button
                type="button" variant="ghost" size="sm"
                onClick={() => removeLine(i)}
                disabled={lines.length === 1}
                aria-label="Remove line"
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      </div>

      <p className="text-xs text-muted-foreground">
        New delivery orders start in Draft. Move them onward from the delivery order page.
      </p>
      <div className="flex justify-end gap-2">
        <Button
          type="button" variant="outline"
          onClick={() => router.push('/logistics/delivery-orders')}
          disabled={submitting}
        >
          Cancel
        </Button>
        <Button type="submit" disabled={submitting || !doNo.trim()}>
          {submitting ? 'Creating…' : 'Create delivery order'}
        </Button>
      </div>
    </form>
  )
}
