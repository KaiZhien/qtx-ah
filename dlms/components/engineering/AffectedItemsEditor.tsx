'use client'

import { useState } from 'react'
import { useRouter } from 'next/navigation'
import { toast } from 'sonner'
import { Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select'
import {
  addAffectedItemAction, removeAffectedItemAction,
} from '@/app/(platform)/engineering/bom/effectivityActions'

type Option = { id: string; label: string }
export type EditableItem = {
  id: string; version: number
  variantName: string; componentTypeName: string
  disposition: string; quantity: number | null; notes: string | null
  appliedAt: string | null
}

type Props = {
  ecoId: string
  items: EditableItem[]
  variantOptions: Option[]
  componentTypeOptions: Option[]
  /**
   * False once the list is frozen, for either of two independent reasons: an item
   * has been applied to the BOM, or an approval that has already been acted on
   * covers these rows. The panel decides; this only renders it.
   */
  editable: boolean
}

const DISPOSITION_LABEL: Record<string, string> = {
  add: 'Add to BOM', change: 'Change quantity', remove: 'Remove from BOM',
}

/**
 * Edits the list of component types an ECO affects. Frozen (editable=false) for
 * two independent reasons, and the server enforces BOTH — this only hides the
 * controls:
 *
 *   an item has been APPLIED: an item added afterwards would be picked up by a
 *     later run and silently backdated to this ECO's effectivity point, which is
 *     a BOM history that never happened.
 *   an APPROVAL covers the list: these rows are what a second pair of eyes agreed
 *     to, and they alone decide which BOM the apply rewrites.
 */
export function AffectedItemsEditor({
  ecoId, items, variantOptions, componentTypeOptions, editable,
}: Props) {
  const router = useRouter()
  const [variantId, setVariantId] = useState(variantOptions[0]?.id ?? '')
  const [componentTypeId, setComponentTypeId] = useState(componentTypeOptions[0]?.id ?? '')
  const [disposition, setDisposition] = useState('change')
  const [quantity, setQuantity] = useState('1')
  const [notes, setNotes] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const removing = disposition === 'remove'

  async function add(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    try {
      const res = await addAffectedItemAction({
        ecoId, variantId, componentTypeId,
        disposition: disposition as 'add' | 'change' | 'remove',
        quantity: removing ? undefined : Number(quantity),
        notes: notes.trim() || undefined,
      })
      if (!res.ok) { setError(res.error); toast.error(res.error); return }
      toast.success('Affected item added')
      setNotes('')
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  async function remove(item: EditableItem) {
    setBusy(true)
    try {
      const res = await removeAffectedItemAction({ ecoId, id: item.id, version: item.version })
      if (!res.ok) { toast.error(res.error); return }
      toast.success('Affected item removed')
      router.refresh()
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      {items.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          Nothing listed yet — this change order will not alter any BOM.
        </p>
      ) : (
        <ul className="divide-y rounded-md border">
          {items.map((i) => (
            <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm">
              <span className="font-medium text-slate-900">{i.variantName}</span>
              <span className="text-slate-700">{i.componentTypeName}</span>
              <span className="text-muted-foreground">
                {DISPOSITION_LABEL[i.disposition] ?? i.disposition}
                {i.quantity !== null && ` → qty ${i.quantity}`}
              </span>
              {i.notes && <span className="text-muted-foreground">“{i.notes}”</span>}
              {i.appliedAt && <span className="text-xs text-green-700">applied</span>}
              {editable && !i.appliedAt && (
                <Button
                  type="button" size="sm" variant="ghost" className="ml-auto"
                  aria-label={`Remove ${i.componentTypeName} from this change order`}
                  disabled={busy} onClick={() => remove(i)}
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}

      {editable && (
        <form onSubmit={add} className="space-y-3 rounded-md border border-dashed p-3">
          {error && (
            <p className="rounded-md bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>
          )}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <Label htmlFor="ai-variant" className="mb-1.5 block text-xs">Variant</Label>
              <Select value={variantId} onValueChange={setVariantId}>
                <SelectTrigger id="ai-variant"><SelectValue placeholder="Variant" /></SelectTrigger>
                <SelectContent>
                  {variantOptions.map((v) => (
                    <SelectItem key={v.id} value={v.id}>{v.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="ai-type" className="mb-1.5 block text-xs">Component type</Label>
              <Select value={componentTypeId} onValueChange={setComponentTypeId}>
                <SelectTrigger id="ai-type"><SelectValue placeholder="Component type" /></SelectTrigger>
                <SelectContent>
                  {componentTypeOptions.map((c) => (
                    <SelectItem key={c.id} value={c.id}>{c.label}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label htmlFor="ai-disp" className="mb-1.5 block text-xs">Disposition</Label>
              <Select value={disposition} onValueChange={setDisposition}>
                <SelectTrigger id="ai-disp"><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="add">Add to BOM</SelectItem>
                  <SelectItem value="change">Change quantity</SelectItem>
                  <SelectItem value="remove">Remove from BOM</SelectItem>
                </SelectContent>
              </Select>
            </div>
            {!removing && (
              <div>
                <Label htmlFor="ai-qty" className="mb-1.5 block text-xs">Quantity</Label>
                <Input
                  id="ai-qty" type="number" min={1} value={quantity}
                  onChange={(e) => setQuantity(e.target.value)}
                />
              </div>
            )}
          </div>
          <div>
            <Label htmlFor="ai-notes" className="mb-1.5 block text-xs">Notes</Label>
            <Input id="ai-notes" value={notes} onChange={(e) => setNotes(e.target.value)} />
          </div>
          <div className="flex justify-end">
            <Button
              type="submit" size="sm"
              disabled={busy || !variantId || !componentTypeId || (!removing && Number(quantity) < 1)}
            >
              {busy ? 'Adding…' : 'Add affected item'}
            </Button>
          </div>
        </form>
      )}
    </div>
  )
}
