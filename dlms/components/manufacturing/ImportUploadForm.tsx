'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import { uploadImportAction } from '@/app/(platform)/manufacturing/import/actions'
import type { VocabOption } from '@/modules/manufacturing/services/deviceReadService'
import { MAX_UPLOAD_LABEL } from '@/modules/manufacturing/domain/importLimits'
import { callFailed } from '@/components/manufacturing/importCallFailed'
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
  // An explicit busy flag on top of useTransition's isPending, because the two
  // stop being true at different moments. isPending is held across the async
  // callback and drops when it settles — but on success it settles while
  // router.push is still in flight, with the file still sitting in the input, so
  // Submit would re-enable inside the very window this flag exists to close and
  // a second click would stage the same spreadsheet as a second batch. This flag
  // is therefore cleared only on the failure path; a successful navigation
  // unmounts the form and takes it with it.
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
            if (res.ok) {
              router.push(`/manufacturing/import/${res.data.batchId}`)
              return              // see `uploading` above: deliberately still set
            }
            setError(res.error)
          } catch (err) {
            setError(callFailed('upload', err))
          }
          setUploading(false)
        })
      }}
    >
      <div className="space-y-1">
        <label htmlFor="file" className="text-sm font-medium">Spreadsheet</label>
        <input id="file" name="file" type="file" required
               accept=".xlsx,.csv"
               className="block w-full text-sm" />
        {/* The cap itself lives in importLimits.ts, which uploadImportAction
            enforces — so this text cannot advertise a limit the action does not
            apply. */}
        <p className="text-muted-foreground text-xs">
          .xlsx or .csv, up to {MAX_UPLOAD_LABEL}.
        </p>
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
