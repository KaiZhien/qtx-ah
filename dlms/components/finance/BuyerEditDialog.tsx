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
import { updateBuyerAction } from '@/app/(platform)/finance/buyers/buyerWriteActions'
import type { BuyerDetail } from '@/modules/finance/services/buyerService'

type Props = { buyer: BuyerDetail }

/**
 * Edit a buyer's fields. Sends the loaded version for optimistic concurrency;
 * a conflict surfaces the reload message from the action's toMessage — same
 * convention as manufacturing/DeviceEditDialog.tsx.
 */
export function BuyerEditDialog({ buyer }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(buyer.name)
  const [country, setCountry] = useState(buyer.country ?? '')
  const [contactName, setContactName] = useState(buyer.contactName ?? '')
  const [contactEmail, setContactEmail] = useState(buyer.contactEmail ?? '')
  const [contactPhone, setContactPhone] = useState(buyer.contactPhone ?? '')
  const [billingAddress, setBillingAddress] = useState(buyer.billingAddress ?? '')
  const [notes, setNotes] = useState(buyer.notes ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await updateBuyerAction({
        buyerId: buyer.id,
        version: buyer.version,
        name: name.trim(),
        country: country.trim() || null,
        contactName: contactName.trim() || null,
        contactEmail: contactEmail.trim() || null,
        contactPhone: contactPhone.trim() || null,
        billingAddress: billingAddress.trim() || null,
        notes: notes.trim() || null,
      })
      if (!res.ok) { setError(res.error); toast.error(res.error); return }
      toast.success('Buyer updated')
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
        <DialogHeader><DialogTitle>Edit buyer</DialogTitle></DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="e-name" className="mb-1.5 block">Name</Label>
              <Input id="e-name" value={name} onChange={(e) => setName(e.target.value)} required />
            </div>
            <div>
              <Label htmlFor="e-country" className="mb-1.5 block">Country</Label>
              <Input id="e-country" value={country} onChange={(e) => setCountry(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="e-contact" className="mb-1.5 block">Contact name</Label>
              <Input id="e-contact" value={contactName} onChange={(e) => setContactName(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="e-email" className="mb-1.5 block">Contact email</Label>
              <Input id="e-email" type="email" value={contactEmail} onChange={(e) => setContactEmail(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="e-phone" className="mb-1.5 block">Contact phone</Label>
              <Input id="e-phone" value={contactPhone} onChange={(e) => setContactPhone(e.target.value)} />
            </div>
          </div>
          <div>
            <Label htmlFor="e-billing" className="mb-1.5 block">Billing address</Label>
            <Textarea id="e-billing" value={billingAddress} onChange={(e) => setBillingAddress(e.target.value)} />
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
