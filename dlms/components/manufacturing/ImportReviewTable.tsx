'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { skipRowAction } from '@/app/(platform)/manufacturing/import/actions'
import type { ImportRowView } from '@/modules/manufacturing/services/importCommitService'
import {
  IMPORT_ROW_PAGE_LIMIT, type ImportRowStatus,
} from '@/modules/manufacturing/domain/importUi'
import { callFailed } from '@/components/manufacturing/importCallFailed'
import { Button } from '@/components/ui/button'

const TABS = [
  { key: 'valid', label: 'Ready' },
  { key: 'needs_review', label: 'Needs review' },
  { key: 'invalid', label: 'Invalid' },
  { key: 'committed', label: 'Imported' },
  { key: 'skipped', label: 'Skipped' },
  { key: 'failed', label: 'Failed' },
] as const satisfies readonly { key: ImportRowStatus; label: string }[]

export function ImportReviewTable(
  { batchId, rows, active, counts }: {
    batchId: string
    rows: ImportRowView[]
    // Typed as the status union rather than string, so a typo'd tab key is a
    // compile error instead of a tab that quietly renders "(0)".
    active: ImportRowStatus
    counts: Record<ImportRowStatus, number>
  },
) {
  const [, startTransition] = useTransition()
  // Skip is the only write this table has, so swallowing its result made an
  // expired MFA session, a revoked permission or a validation refusal all look
  // like "nothing happened".
  const [error, setError] = useState<string | null>(null)
  const router = useRouter()
  const shown = rows

  return (
    <div className="space-y-3">
      {/* Tabs are links, not client state: each status is a separate SQL query,
          so a 5000-row batch never has to reach the browser to be filtered. */}
      <div className="flex flex-wrap gap-2">
        {TABS.map((t) => (
          <Link
            key={t.key}
            href={`/manufacturing/import/${batchId}?status=${t.key}`}
            className={`rounded-md border px-3 py-1 text-sm ${
              active === t.key ? 'bg-muted font-medium' : 'bg-white'}`}
          >
            {t.label} ({counts[t.key]})
          </Link>
        ))}
      </div>
      {/* Keyed off the row count hitting listImportRows' cap, NOT off
          counts[active] > shown.length: the counts and the rows come from two
          separate transactions, so a concurrent skip landing between them makes
          the count larger than the rows on a batch of three and the note fires
          claiming a truncation that never happened. */}
      {shown.length >= IMPORT_ROW_PAGE_LIMIT && (
        <p className="text-muted-foreground text-sm">
          Showing the first {shown.length} of {counts[active]} rows.
        </p>
      )}

      {error && <p role="alert" className="text-destructive text-sm">{error}</p>}

      <div className="overflow-x-auto rounded-lg border bg-white">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="p-2 text-left">Sheet row</th>
              {/* Two serial columns, deliberately. The sheet cell is what the
                  uploader typed — on a fanned row it is the whole range, repeated
                  identically down every unit it produced. The derived one is the
                  serial this unit will actually create, which is the value that
                  becomes permanent and the one worth checking before commit. */}
              <th className="p-2 text-left">PCBA-A S/N in sheet</th>
              <th className="p-2 text-left">Serial to create</th>
              <th className="p-2 text-left">Status</th>
              <th className="p-2 text-left">Notes</th>
              <th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr><td colSpan={6} className="text-muted-foreground p-4 text-center">
                Nothing here.
              </td></tr>
            )}
            {shown.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="p-2">{r.sourceRowNo}{r.unitNo > 1 ? `.${r.unitNo}` : ''}</td>
                {/* `||`, not `??`: raw cells are strings, and a blank one should
                    render the dash rather than an empty column. */}
                <td className="p-2 font-mono text-xs">{r.raw.pcba_a_sn || '—'}</td>
                {/* Null for every row that has no draft to derive it from — an
                    invalid or needs_review row has no parsed serial yet. */}
                <td className="p-2 font-mono text-xs">{r.derivedSerialNo ?? '—'}</td>
                <td className="p-2">{r.raw.status || '—'}</td>
                <td className="p-2">
                  {r.deviceId
                    ? <Link className="underline" href={`/manufacturing/devices/${r.deviceId}`}>
                        View device
                      </Link>
                    : r.errors.join('; ')}
                </td>
                <td className="p-2 text-right">
                  {r.status !== 'committed' && r.status !== 'skipped' && (
                    <Button
                      variant="ghost" size="sm"
                      onClick={() => {
                        setError(null)
                        startTransition(async () => {
                          try {
                            const res = await skipRowAction({ batchId, rowId: r.id })
                            if (!res.ok) { setError(res.error); return }
                            router.refresh()
                          } catch (err) {
                            setError(callFailed('skip', err))
                          }
                        })
                      }}
                    >
                      Skip
                    </Button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  )
}
