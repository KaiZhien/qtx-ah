'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Plus, Pencil, RefreshCw } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogTrigger } from '@/components/ui/dialog'
import {
  createWarrantyAction, updateWarrantyAction, renewWarrantyAction,
} from '@/app/(platform)/finance/warranties/warrantyWriteActions'
import type { WarrantyRecord } from '@/modules/finance/services/warrantyService'

export type WarrantyDialogMode = 'create' | 'edit' | 'renew'

type Props = {
  mode: WarrantyDialogMode
  deviceId: string
  /** Required for 'edit' and 'renew'. */
  warranty?: WarrantyRecord
}

const COPY: Record<WarrantyDialogMode, { trigger: string; title: string; submit: string; hint: string }> = {
  create: {
    trigger: 'Register warranty',
    title: 'Register warranty',
    submit: 'Register',
    hint: 'Both dates are inclusive — cover runs from the start date through the end date.',
  },
  edit: {
    trigger: 'Edit',
    title: 'Correct warranty details',
    submit: 'Save changes',
    // Says out loud what the service enforces, so nobody uses the wrong control.
    hint: 'Use this to fix a mistake. To EXTEND cover, use Renew instead — editing the dates '
      + 'overwrites what was originally promised and the old terms are lost.',
  },
  renew: {
    trigger: 'Renew',
    title: 'Renew warranty',
    submit: 'Renew',
    hint: 'The current warranty is superseded and kept in the history; this creates its successor.',
  },
}

/**
 * Create / correct / renew a device warranty. Sends the loaded version for
 * optimistic concurrency on the two paths that touch an existing row, same
 * convention as InvoiceEditDialog.
 */
export function WarrantyDialog({ mode, deviceId, warranty }: Props) {
  const router = useRouter()
  const copy = COPY[mode]
  const [open, setOpen] = useState(false)
  // 'edit' seeds from the current row; 'renew' starts blank so nobody renews to
  // the dates that just ran out by accident.
  const [startDate, setStartDate] = useState(mode === 'edit' ? warranty?.startDate ?? '' : '')
  const [endDate, setEndDate] = useState(mode === 'edit' ? warranty?.endDate ?? '' : '')
  const [terms, setTerms] = useState(mode === 'edit' ? warranty?.terms ?? '' : '')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const res =
        mode === 'create'
          ? await createWarrantyAction({
              deviceId, startDate, endDate, terms: terms.trim() || undefined })
          : mode === 'renew'
            ? await renewWarrantyAction({
                warrantyId: warranty!.id, version: warranty!.version, deviceId,
                startDate, endDate, terms: terms.trim() || undefined })
            : await updateWarrantyAction({
                warrantyId: warranty!.id, version: warranty!.version, deviceId,
                startDate, endDate, terms: terms.trim() || null })

      if (!res.ok) { setError(res.error); toast.error(res.error); return }
      toast.success(mode === 'renew' ? 'Warranty renewed' : mode === 'edit' ? 'Warranty updated' : 'Warranty registered')
      setOpen(false)
      router.refresh()
    } finally {
      setSubmitting(false)
    }
  }

  const Icon = mode === 'create' ? Plus : mode === 'renew' ? RefreshCw : Pencil

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant={mode === 'create' ? 'default' : 'outline'} size="sm">
          <Icon className="mr-1.5 h-3.5 w-3.5" aria-hidden="true" />
          {copy.trigger}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-h-[85vh] max-w-lg overflow-y-auto">
        <DialogHeader><DialogTitle>{copy.title}</DialogTitle></DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
          )}
          <p className="text-xs text-muted-foreground">{copy.hint}</p>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <Label htmlFor="w-start" className="mb-1.5 block">Start date</Label>
              <Input id="w-start" type="date" required value={startDate}
                     onChange={(e) => setStartDate(e.target.value)} />
            </div>
            <div>
              <Label htmlFor="w-end" className="mb-1.5 block">End date</Label>
              <Input id="w-end" type="date" required value={endDate}
                     onChange={(e) => setEndDate(e.target.value)} />
            </div>
          </div>
          <div>
            <Label htmlFor="w-terms" className="mb-1.5 block">Terms</Label>
            <Textarea id="w-terms" value={terms} onChange={(e) => setTerms(e.target.value)}
                      placeholder="What is covered, exclusions, contract reference…" />
          </div>
          <div className="flex justify-end gap-2">
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? 'Saving…' : copy.submit}
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  )
}
