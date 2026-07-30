'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { uploadImportAction } from '@/app/(platform)/manufacturing/import/actions'
import type { VocabOption } from '@/modules/manufacturing/services/deviceReadService'
import { Button } from '@/components/ui/button'

/**
 * The upload step. Deliberately a plain <form> posting FormData to a server
 * action: the file bytes are parsed server-side, so the browser never needs a
 * spreadsheet parser and never decides what a row means.
 *
 * `accept` below is a file-picker convenience only — the real extension and
 * size checks live in uploadImportAction.
 */
export function ImportUploadForm({ variants }: { variants: VocabOption[] }) {
  const [error, setError] = useState<string | null>(null)
  // React 18's useTransition drops isPending as soon as the callback's first
  // await yields, so it cannot keep the button disabled while the file is being
  // parsed server-side. An explicit flag can — and must, because a second
  // submit would stage the same spreadsheet as a second batch.
  const [uploading, setUploading] = useState(false)
  const [transitioning, startTransition] = useTransition()
  const pending = uploading || transitioning
  const router = useRouter()

  return (
    <form
      className="space-y-4 rounded-lg border bg-white p-4"
      action={(form) => {
        setError(null)
        setUploading(true)
        startTransition(async () => {
          try {
            const res = await uploadImportAction(form)
            if (res.ok) router.push(`/manufacturing/import/${res.data.batchId}`)
            else setError(res.error)
          } finally {
            setUploading(false)
          }
        })
      }}
    >
      <div className="space-y-1">
        <label htmlFor="file" className="text-sm font-medium">Spreadsheet</label>
        <input id="file" name="file" type="file" required
               accept=".xlsx,.csv"
               className="block w-full text-sm" />
        <p className="text-muted-foreground text-xs">.xlsx or .csv, up to 10 MB.</p>
      </div>

      <div className="space-y-1">
        <label htmlFor="variantCode" className="text-sm font-medium">Device variant</label>
        <select id="variantCode" name="variantCode" required
                className="block w-full rounded-md border px-3 py-2 text-sm">
          {variants.map((v) => <option key={v.code} value={v.code}>{v.label}</option>)}
        </select>
        <p className="text-muted-foreground text-xs">
          Applied to every row unless the sheet has its own Variant column.
        </p>
      </div>

      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}

      <Button type="submit" disabled={pending}>
        {pending ? 'Reading the file…' : 'Upload and review'}
      </Button>
    </form>
  )
}
