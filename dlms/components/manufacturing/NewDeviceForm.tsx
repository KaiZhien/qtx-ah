'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { createDeviceAction } from '@/app/(platform)/manufacturing/devices/deviceWriteActions'
import type { VocabOption } from '@/modules/manufacturing/services/deviceReadService'

type Props = { variantOptions: VocabOption[]; phaseOptions: VocabOption[] }

const NONE = '__none__' // Radix Select cannot hold an empty-string value

export function NewDeviceForm({ variantOptions, phaseOptions }: Props) {
  const router = useRouter()
  const [variantCode, setVariantCode] = useState(variantOptions[0]?.code ?? '')
  const [deviceSn, setDeviceSn] = useState('')
  const [productName, setProductName] = useState('')
  const [modelNo, setModelNo] = useState('')
  const [customer, setCustomer] = useState('')
  const [destination, setDestination] = useState('')
  const [phase, setPhase] = useState(NONE)
  const [buildDate, setBuildDate] = useState('')
  const [remarks, setRemarks] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await createDeviceAction({
        variantCode,
        deviceSn: deviceSn.trim() || undefined,
        productName: productName.trim() || undefined,
        modelNo: modelNo.trim() || undefined,
        customer: customer.trim() || undefined,
        destination: destination.trim() || undefined,
        phase: phase === NONE ? undefined : phase,
        buildDate: buildDate || undefined,
        remarks: remarks.trim() || undefined,
      })
      if (!res.ok) { setError(res.error); toast.error(res.error); return }
      toast.success('Device created')
      router.push(`/manufacturing/devices/${res.data.deviceId}`)
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
          <Label htmlFor="variant" className="mb-1.5 block">Variant (required)</Label>
          <Select value={variantCode} onValueChange={setVariantCode}>
            <SelectTrigger id="variant"><SelectValue /></SelectTrigger>
            <SelectContent>
              {variantOptions.map((v) => <SelectItem key={v.code} value={v.code}>{v.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="deviceSn" className="mb-1.5 block">Serial number</Label>
          <Input id="deviceSn" value={deviceSn} onChange={(e) => setDeviceSn(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="productName" className="mb-1.5 block">Product name</Label>
          <Input id="productName" value={productName} onChange={(e) => setProductName(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="modelNo" className="mb-1.5 block">Model no.</Label>
          <Input id="modelNo" value={modelNo} onChange={(e) => setModelNo(e.target.value)} />
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
          <Label htmlFor="phase" className="mb-1.5 block">Phase</Label>
          <Select value={phase} onValueChange={setPhase}>
            <SelectTrigger id="phase"><SelectValue placeholder="—" /></SelectTrigger>
            <SelectContent>
              <SelectItem value={NONE}>—</SelectItem>
              {phaseOptions.map((p) => <SelectItem key={p.code} value={p.code}>{p.label}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="buildDate" className="mb-1.5 block">Build date</Label>
          <Input id="buildDate" type="date" value={buildDate} onChange={(e) => setBuildDate(e.target.value)} />
        </div>
      </div>
      <div>
        <Label htmlFor="remarks" className="mb-1.5 block">Remarks</Label>
        <Textarea id="remarks" value={remarks} onChange={(e) => setRemarks(e.target.value)} />
      </div>
      <p className="text-xs text-muted-foreground">
        New devices start at the initial lifecycle status. Move them onward from the device page.
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => router.push('/manufacturing/devices')} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting || !variantCode}>
          {submitting ? 'Creating…' : 'Create device'}
        </Button>
      </div>
    </form>
  )
}
