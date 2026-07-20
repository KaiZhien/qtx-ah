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
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { updateDeviceAction } from '@/app/(platform)/manufacturing/devices/deviceWriteActions'
import type { DeviceDetail, VocabOption } from '@/modules/manufacturing/services/deviceReadService'

type Props = { device: DeviceDetail; variantOptions: VocabOption[]; phaseOptions: VocabOption[] }

const NONE = '__none__'
function dateInput(d: Date | string | null): string {
  return d ? new Date(d).toISOString().slice(0, 10) : ''
}

/**
 * Edit a device's non-status fields (status has its own control). Sends the
 * loaded version for optimistic concurrency; a conflict surfaces the reload
 * message from the action's toMessage. Only edits fields this form exposes.
 */
export function DeviceEditDialog({ device, variantOptions, phaseOptions }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [variantCode, setVariantCode] = useState(device.variantCode)
  const [deviceSn, setDeviceSn] = useState(device.deviceSn ?? '')
  const [productName, setProductName] = useState(device.productName ?? '')
  const [modelNo, setModelNo] = useState(device.modelNo ?? '')
  const [customer, setCustomer] = useState(device.customer ?? '')
  const [destination, setDestination] = useState(device.destination ?? '')
  const [phase, setPhase] = useState(device.phase ?? NONE)
  const [buildDate, setBuildDate] = useState(dateInput(device.buildDate))
  const [shipDate, setShipDate] = useState(dateInput(device.shipDate))
  const [deliveredDate, setDeliveredDate] = useState(dateInput(device.deliveredDate))
  const [remarks, setRemarks] = useState(device.remarks ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await updateDeviceAction({
        deviceId: device.id,
        version: device.version,
        variantCode,
        deviceSn: deviceSn.trim() || null,
        productName: productName.trim() || null,
        modelNo: modelNo.trim() || null,
        customer: customer.trim() || null,
        destination: destination.trim() || null,
        phase: phase === NONE ? null : phase,
        buildDate: buildDate || null,
        shipDate: shipDate || null,
        deliveredDate: deliveredDate || null,
        remarks: remarks.trim() || null,
      })
      if (!res.ok) { setError(res.error); toast.error(res.error); return }
      toast.success('Device updated')
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
        <DialogHeader><DialogTitle>Edit device</DialogTitle></DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="e-variant" className="mb-1.5 block">Variant</Label>
              <Select value={variantCode} onValueChange={setVariantCode}>
                <SelectTrigger id="e-variant"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {variantOptions.map((v) => <SelectItem key={v.code} value={v.code}>{v.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="e-sn" className="mb-1.5 block">Serial number</Label>
              <Input id="e-sn" value={deviceSn} onChange={(e) => setDeviceSn(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="e-product" className="mb-1.5 block">Product name</Label>
              <Input id="e-product" value={productName} onChange={(e) => setProductName(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="e-model" className="mb-1.5 block">Model no.</Label>
              <Input id="e-model" value={modelNo} onChange={(e) => setModelNo(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="e-customer" className="mb-1.5 block">Customer</Label>
              <Input id="e-customer" value={customer} onChange={(e) => setCustomer(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="e-dest" className="mb-1.5 block">Destination</Label>
              <Input id="e-dest" value={destination} onChange={(e) => setDestination(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="e-phase" className="mb-1.5 block">Phase</Label>
              <Select value={phase} onValueChange={setPhase}>
                <SelectTrigger id="e-phase"><SelectValue placeholder="—" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value={NONE}>—</SelectItem>
                  {phaseOptions.map((p) => <SelectItem key={p.code} value={p.code}>{p.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="e-build" className="mb-1.5 block">Build date</Label>
              <Input id="e-build" type="date" value={buildDate} onChange={(e) => setBuildDate(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="e-ship" className="mb-1.5 block">Ship date</Label>
              <Input id="e-ship" type="date" value={shipDate} onChange={(e) => setShipDate(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="e-delivered" className="mb-1.5 block">Delivered date</Label>
              <Input id="e-delivered" type="date" value={deliveredDate} onChange={(e) => setDeliveredDate(e.target.value)} />
            </div>
          </div>
          <div>
            <Label htmlFor="e-remarks" className="mb-1.5 block">Remarks</Label>
            <Textarea id="e-remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
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
