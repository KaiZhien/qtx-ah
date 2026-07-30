'use client'

import { useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { skipRowAction } from '@/app/(platform)/manufacturing/import/actions'
import type { ImportRowView } from '@/modules/manufacturing/services/importCommitService'
import { Button } from '@/components/ui/button'

const TABS = [
  { key: 'valid', label: 'Ready' },
  { key: 'needs_review', label: 'Needs review' },
  { key: 'invalid', label: 'Invalid' },
  { key: 'committed', label: 'Imported' },
  { key: 'skipped', label: 'Skipped' },
  { key: 'failed', label: 'Failed' },
] as const

export function ImportReviewTable(
  { batchId, rows, active, counts }: {
    batchId: string
    rows: ImportRowView[]
    active: string
    counts: Record<string, number>
  },
) {
  const [, startTransition] = useTransition()
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
            {t.label} ({counts[t.key] ?? 0})
          </Link>
        ))}
      </div>
      {/* listImportRows caps at 2000; the counts are exact, so say so rather
          than letting the table quietly look like the whole story. */}
      {counts[active] > shown.length && (
        <p className="text-muted-foreground text-sm">
          Showing the first {shown.length} of {counts[active]} rows.
        </p>
      )}

      <div className="overflow-x-auto rounded-lg border bg-white">
        <table className="w-full text-sm">
          <thead className="bg-muted/50">
            <tr>
              <th className="p-2 text-left">Sheet row</th>
              <th className="p-2 text-left">PCBA-A S/N</th>
              <th className="p-2 text-left">Status</th>
              <th className="p-2 text-left">Notes</th>
              <th className="p-2" />
            </tr>
          </thead>
          <tbody>
            {shown.length === 0 && (
              <tr><td colSpan={5} className="text-muted-foreground p-4 text-center">
                Nothing here.
              </td></tr>
            )}
            {shown.map((r) => (
              <tr key={r.id} className="border-t">
                <td className="p-2">{r.sourceRowNo}{r.unitNo > 1 ? `.${r.unitNo}` : ''}</td>
                <td className="p-2 font-mono text-xs">{r.raw.pcba_a_sn || '—'}</td>
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
                      onClick={() => startTransition(async () => {
                        await skipRowAction({ batchId, rowId: r.id })
                        router.refresh()
                      })}
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
