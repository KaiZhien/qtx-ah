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
import { updateInvoiceAction } from '@/app/(platform)/finance/invoices/invoiceWriteActions'
import type { InvoiceDetail } from '@/modules/finance/services/invoiceService'
import type { BuyerOption } from '@/modules/finance/services/buyerService'

type Props = { invoice: InvoiceDetail; buyerOptions: BuyerOption[] }

function dateInput(d: Date | string | null): string {
  return d ? new Date(d).toISOString().slice(0, 10) : ''
}

/**
 * Edit an invoice's header fields (status has its own control —
 * InvoiceStatusChangeControl — and line items are not editable in this basic
 * build; see the sales_invoice_line table comment in the migration). Sends the
 * loaded version for optimistic concurrency, same convention as
 * manufacturing/DeviceEditDialog.tsx.
 */
export function InvoiceEditDialog({ invoice, buyerOptions }: Props) {
  const router = useRouter()
  const [open, setOpen] = useState(false)
  const [invoiceNo, setInvoiceNo] = useState(invoice.invoiceNo)
  const [buyerId, setBuyerId] = useState(invoice.buyerId)
  const [issueDate, setIssueDate] = useState(dateInput(invoice.issueDate))
  const [dueDate, setDueDate] = useState(dateInput(invoice.dueDate))
  const [taxSgd, setTaxSgd] = useState(invoice.taxSgd ?? '')
  const [notes, setNotes] = useState(invoice.notes ?? '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await updateInvoiceAction({
        invoiceId: invoice.id,
        version: invoice.version,
        invoiceNo: invoiceNo.trim(),
        buyerId,
        issueDate: issueDate || null,
        dueDate: dueDate || null,
        taxSgd: taxSgd !== '' ? Number(taxSgd) : null,
        notes: notes.trim() || null,
      })
      if (!res.ok) { setError(res.error); toast.error(res.error); return }
      toast.success('Invoice updated')
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
        <DialogHeader><DialogTitle>Edit invoice</DialogTitle></DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
          )}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="e-invoiceNo" className="mb-1.5 block">Invoice no.</Label>
              <Input id="e-invoiceNo" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} required />
            </div>
            <div>
              <Label htmlFor="e-buyer" className="mb-1.5 block">Buyer</Label>
              <Select value={buyerId} onValueChange={setBuyerId}>
                <SelectTrigger id="e-buyer"><SelectValue /></SelectTrigger>
                <SelectContent>
                  {buyerOptions.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="e-issue" className="mb-1.5 block">Issue date</Label>
              <Input id="e-issue" type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="e-due" className="mb-1.5 block">Due date</Label>
              <Input id="e-due" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="e-tax" className="mb-1.5 block">Tax (SGD)</Label>
              <Input id="e-tax" type="number" min="0" step="0.01" value={taxSgd} onChange={(e) => setTaxSgd(e.target.value)} />
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
