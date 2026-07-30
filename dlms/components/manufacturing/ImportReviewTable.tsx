'use client'

import { useState, useTransition } from 'react'
import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { skipRowAction } from '@/app/(platform)/manufacturing/import/actions'
import type { ImportRowView } from '@/modules/manufacturing/services/importCommitService'
import {
  IMPORT_ROW_PAGE_LIMIT, type ImportRowStatus,
} from '@/modules/manufacturing/domain/importUi'
import { Button } from '@/components/ui/button'

const TABS = [
  { key: 'valid', label: 'Ready' },
  { key: 'needs_review', label: 'Needs review' },
  { key: 'invalid', label: 'Invalid' },
  { key: 'committed', label: 'Imported' },
  { key: 'skipped', label: 'Skipped' },
  { key: 'failed', label: 'Failed' },
] as const satisfies readonly { key: ImportRowStatus; label: string }[]

/**
 * A rejected action *invocation*: skipRowAction never throws, but the call
 * itself can fail — a dropped connection, a stale action id after a redeploy.
 * Left uncaught, a rejection inside startTransition's async callback is rethrown
 * when the transition unwraps it and escalates to the error boundary, replacing
 * the whole review page. Logged structured and once, the way the actions log.
 */
function callFailed(err: unknown): string {
  console.error(JSON.stringify({
    level: 'error', msg: 'import skip call failed', err: String(err),
  }))
  return 'Something went wrong. Try again, and tell Reet if it keeps happening.'
}

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
                {/* `||`, not `??`: raw cells are strings, and a blank one should
                    render the dash rather than an empty column. */}
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
                      onClick={() => {
                        setError(null)
                        startTransition(async () => {
                          try {
                            const res = await skipRowAction({ batchId, rowId: r.id })
                            if (!res.ok) { setError(res.error); return }
                            router.refresh()
                          } catch (err) {
                            setError(callFailed(err))
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
