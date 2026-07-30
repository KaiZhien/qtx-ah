'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  commitBatchAction, cancelBatchAction, retryFailedRowsAction,
} from '@/app/(platform)/manufacturing/import/actions'
import { Button } from '@/components/ui/button'

export function ImportCommitPanel(
  { batchId, status, pending, failed }: {
    batchId: string; status: string; pending: number; failed: number
  },
) {
  const [message, setMessage] = useState<string | null>(null)
  // React 18's useTransition drops isPending at the callback's first await, so
  // it cannot hold these buttons disabled across a multi-pass commit. An
  // explicit flag can: without it the Import button re-enables one round trip
  // in and a second click starts an overlapping pass, whose interleaved counts
  // would be reported as one confusing total.
  const [inFlight, setInFlight] = useState(false)
  const [transitioning, startTransition] = useTransition()
  const busy = inFlight || transitioning
  const router = useRouter()

  const done = status === 'committed' || status === 'cancelled'

  /** Runs `fn` with the panel's controls disabled for its whole duration. */
  const run = (fn: () => Promise<void>) => {
    setInFlight(true)
    startTransition(async () => {
      try {
        await fn()
      } finally {
        setInFlight(false)
        router.refresh()
      }
    })
  }

  // Commit in pages of 200 and keep going while rows remain: one round trip per
  // page keeps each server action well inside its time budget on a large file.
  const runCommit = () => {
    setMessage(null)
    run(async () => {
      let committed = 0, failedRows = 0, skipped = 0
      for (;;) {
        const res = await commitBatchAction({ batchId, limit: 200 })
        if (!res.ok) { setMessage(res.error); break }
        committed += res.data.committed
        failedRows += res.data.failed
        skipped += res.data.skipped
        if (res.data.remaining === 0 ||
            res.data.committed + res.data.failed + res.data.skipped === 0) {
          setMessage(`Imported ${committed} · skipped ${skipped} · failed ${failedRows}`)
          break
        }
      }
    })
  }

  return (
    <div className="flex flex-wrap items-center gap-3 rounded-lg border bg-white p-4">
      <Button onClick={runCommit} disabled={busy || done || pending === 0}>
        {/* 'Working…' rather than 'Importing…': `busy` covers the retry and
            cancel buttons too, and this is the label they blank out. */}
        {busy ? 'Working…' : `Import ${pending} device${pending === 1 ? '' : 's'}`}
      </Button>
      {/* A row fails for a reason — a missing permission, a status deactivated
          mid-import. Requeueing is explicit so it happens after someone fixes
          that reason, rather than on every pass. */}
      {failed > 0 && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => run(async () => {
            const res = await retryFailedRowsAction({ batchId })
            setMessage(res.ok
              ? `Requeued ${res.data.requeued} failed row${res.data.requeued === 1 ? '' : 's'} — import again to retry.`
              : res.error)
          })}
        >
          Retry {failed} failed row{failed === 1 ? '' : 's'}
        </Button>
      )}
      <Button
        variant="outline"
        disabled={busy || done}
        onClick={() => run(async () => {
          const res = await cancelBatchAction({ batchId })
          if (!res.ok) setMessage(res.error)
        })}
      >
        Cancel batch
      </Button>
      {message && <p className="text-sm">{message}</p>}
    </div>
  )
}
