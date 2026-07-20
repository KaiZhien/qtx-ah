'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Pencil } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import { updateDeliveryOrderAction } from '@/app/(platform)/logistics/delivery-orders/deliveryOrderWriteActions'
import type { DeliveryOrderDetail } from '@/modules/logistics/services/deliveryOrderService'

type Props = { deliveryOrder: DeliveryOrderDetail }

function dateInput(d: Date | string | null): string {
  return d ? new Date(d).toISOString().slice(0, 10) : ''
}

/**
 * Edit a delivery order's header fields — status has its own control
 * (DoStatusChangeControl) and is never editable here, matching
 * components/manufacturing/DeviceEditDialog.tsx's split. Sends the loaded
 * version for optimistic concurrency.
 */
export function DeliveryOrderEditDialog({ deliveryOrder: d }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [doNo, setDoNo] = useState(d.doNo)
  const [customer, setCustomer] = useState(d.customer ?? '')
  const [destination, setDestination] = useState(d.destination ?? '')
  const [carrier, setCarrier] = useState(d.carrier ?? '')
  const [shipDate, setShipDate] = useState(dateInput(d.shipDate))
  const [deliveredDate, setDeliveredDate] = useState(dateInput(d.deliveredDate))
  const [podReference, setPodReference] = useState(d.podReference ?? '')
  const [importExportRef, setImportExportRef] = useState(d.importExportRef ?? '')
  const [notes, setNotes] = useState(d.notes ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await updateDeliveryOrderAction({
        deliveryOrderId: d.id,
        version: d.version,
        doNo: doNo.trim(),
        customer: customer.trim() || null,
        destination: destination.trim() || null,
        carrier: carrier.trim() || null,
        shipDate: shipDate || null,
        deliveredDate: deliveredDate || null,
        podReference: podReference.trim() || null,
        importExportRef: importExportRef.trim() || null,
        notes: notes.trim() || null,
      })
      if (!res.ok) { setError(res.error); toast.error(res.error); return }
      toast.success('Delivery order updated')
      setOpen(false)
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          <Pencil className="mr-1.5 h-3.5 w-3.5" />
          Edit
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-2xl overflow-y-auto">
        <DialogHeader><DialogTitle>Edit delivery order</DialogTitle></DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="e-do-no" className="mb-1.5 block">DO number</Label>
              <Input id="e-do-no" value={doNo} onChange={(e) => setDoNo(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="e-customer" className="mb-1.5 block">Customer</Label>
              <Input id="e-customer" value={customer} onChange={(e) => setCustomer(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="e-destination" className="mb-1.5 block">Destination</Label>
              <Input id="e-destination" value={destination} onChange={(e) => setDestination(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="e-carrier" className="mb-1.5 block">Carrier</Label>
              <Input id="e-carrier" value={carrier} onChange={(e) => setCarrier(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="e-ship-date" className="mb-1.5 block">Ship date</Label>
              <Input id="e-ship-date" type="date" value={shipDate} onChange={(e) => setShipDate(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="e-delivered-date" className="mb-1.5 block">Delivered date</Label>
              <Input
                id="e-delivered-date" type="date" value={deliveredDate}
                onChange={(e) => setDeliveredDate(e.target.value)}
              />
            </div>
            <div>
              <Label htmlFor="e-pod-ref" className="mb-1.5 block">POD reference</Label>
              <Input id="e-pod-ref" value={podReference} onChange={(e) => setPodReference(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="e-ie-ref" className="mb-1.5 block">Import/export doc ref</Label>
              <Input id="e-ie-ref" value={importExportRef} onChange={(e) => setImportExportRef(e.target.value)} />
            </div>
          </div>
          <div>
            <Label htmlFor="e-notes" className="mb-1.5 block">Notes</Label>
            <Textarea id="e-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>{submitting ? 'Saving…' : 'Save changes'}</Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
