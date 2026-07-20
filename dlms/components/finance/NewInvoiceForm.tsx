'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import { createInvoiceAction } from '@/app/(platform)/finance/invoices/invoiceWriteActions'
import type { BuyerOption } from '@/modules/finance/services/buyerService'

type Props = { buyerOptions: BuyerOption[] }

type LineDraft = { description: string; quantity: string; unitPriceSgd: string }
const emptyLine = (): LineDraft => ({ description: '', quantity: '1', unitPriceSgd: '' })

/**
 * Create an invoice + its lines in one submit. Lines are gathered client-side
 * and sent as a single createInvoiceAction call — the service computes
 * amount_sgd and the header totals server-side (invoiceService.createInvoice),
 * this form never does money math itself. device_id per line is out of this
 * basic form's UI (the schema/service still accept it) — a scope cut, not a
 * data-model gap.
 */
export function NewInvoiceForm({ buyerOptions }: Props) {
  const router = useRouter()
  const [invoiceNo, setInvoiceNo] = useState('')
  const [buyerId, setBuyerId] = useState(buyerOptions[0]?.id ?? '')
  const [issueDate, setIssueDate] = useState('')
  const [dueDate, setDueDate] = useState('')
  const [taxSgd, setTaxSgd] = useState('')
  const [notes, setNotes] = useState('')
  const [lines, setLines] = useState<LineDraft[]>([emptyLine()])
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  function updateLine(i: number, patch: Partial<LineDraft>) {
    setLines((prev) => prev.map((l, idx) => (idx === i ? { ...l, ...patch } : l)))
  }
  function addLine() { setLines((prev) => [...prev, emptyLine()]) }
  function removeLine(i: number) { setLines((prev) => (prev.length > 1 ? prev.filter((_, idx) => idx !== i) : prev)) }

  const subtotal = lines.reduce((sum, l) => {
    const qty = Number(l.quantity) || 0
    const price = Number(l.unitPriceSgd) || 0
    return sum + qty * price
  }, 0)
  const tax = Number(taxSgd) || 0

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res = await createInvoiceAction({
        invoiceNo: invoiceNo.trim(),
        buyerId,
        issueDate: issueDate || undefined,
        dueDate: dueDate || undefined,
        taxSgd: taxSgd ? Number(taxSgd) : undefined,
        notes: notes.trim() || undefined,
        lines: lines
          .filter((l) => l.description.trim() && l.unitPriceSgd)
          .map((l) => ({
            description: l.description.trim(),
            quantity: Number(l.quantity) || 1,
            unitPriceSgd: Number(l.unitPriceSgd),
          })),
      })
      if (!res.ok) { setError(res.error); toast.error(res.error); return }
      toast.success('Invoice created')
      router.push(`/finance/invoices/${res.data.invoiceId}`)
    } finally {
      setSubmitting(false)
    }
  }

  const canSubmit = invoiceNo.trim() && buyerId
    && lines.some((l) => l.description.trim() && l.unitPriceSgd)

  return (
    <form onSubmit={handleSubmit} className="max-w-3xl space-y-6">
      {error && (
        <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
      )}
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="invoiceNo" className="mb-1.5 block">Invoice no. (required)</Label>
          <Input id="invoiceNo" value={invoiceNo} onChange={(e) => setInvoiceNo(e.target.value)} required />
        </div>
        <div>
          <Label htmlFor="buyer" className="mb-1.5 block">Buyer (required)</Label>
          <Select value={buyerId} onValueChange={setBuyerId}>
            <SelectTrigger id="buyer"><SelectValue placeholder="Select a buyer" /></SelectTrigger>
            <SelectContent>
              {buyerOptions.map((b) => <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div>
          <Label htmlFor="issueDate" className="mb-1.5 block">Issue date</Label>
          <Input id="issueDate" type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} />
        </div>
        <div>
          <Label htmlFor="dueDate" className="mb-1.5 block">Due date</Label>
          <Input id="dueDate" type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} />
        </div>
      </div>

      <div>
        <div className="mb-2 flex items-center justify-between">
          <Label className="block">Line items</Label>
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
                aria-label={`Line ${i + 1} description`}
              />
              <Input
                type="number" min="0" step="0.01" value={line.quantity}
                onChange={(e) => updateLine(i, { quantity: e.target.value })}
                placeholder="Qty" className="w-24" aria-label={`Line ${i + 1} quantity`}
              />
              <Input
                type="number" min="0" step="0.01" value={line.unitPriceSgd}
                onChange={(e) => updateLine(i, { unitPriceSgd: e.target.value })}
                placeholder="Unit price (SGD)" className="w-36" aria-label={`Line ${i + 1} unit price`}
              />
              <Button
                type="button" variant="ghost" size="sm" onClick={() => removeLine(i)}
                disabled={lines.length === 1} aria-label={`Remove line ${i + 1}`}
              >
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
        </div>
      </div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
        <div>
          <Label htmlFor="taxSgd" className="mb-1.5 block">Tax (SGD)</Label>
          <Input id="taxSgd" type="number" min="0" step="0.01" value={taxSgd} onChange={(e) => setTaxSgd(e.target.value)} />
        </div>
        <div className="flex flex-col justify-end text-sm text-slate-700">
          <p>Subtotal: S${subtotal.toFixed(2)}</p>
          <p className="font-medium">Total: S${(subtotal + tax).toFixed(2)}</p>
        </div>
      </div>

      <div>
        <Label htmlFor="notes" className="mb-1.5 block">Notes</Label>
        <Textarea id="notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
      </div>

      <p className="text-xs text-muted-foreground">
        New invoices start as Draft. Move them onward from the invoice page.
      </p>
      <div className="flex justify-end gap-2">
        <Button type="button" variant="outline" onClick={() => router.push('/finance/invoices')} disabled={submitting}>
          Cancel
        </Button>
        <Button type="submit" disabled={submitting || !canSubmit}>
          {submitting ? 'Creating…' : 'Create invoice'}
        </Button>
      </div>
    </form>
  )
}
