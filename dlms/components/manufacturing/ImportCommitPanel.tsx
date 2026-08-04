'use client'

import { useState, useTransition } from 'react'
import { useRouter } from 'next/navigation'
import {
  commitBatchAction, cancelBatchAction, retryFailedRowsAction,
} from '@/app/(platform)/manufacturing/import/actions'
import {
  advanceCommit, ZERO_COMMIT_TOTALS, MAX_COMMIT_PASSES,
  type CommitTotals, type CommitStop,
} from '@/modules/manufacturing/domain/importUi'
import { callFailed } from '@/components/platform/callFailed'
import { Button } from '@/components/ui/button'

const tally = (t: CommitTotals) =>
  `Imported ${t.committed} · skipped ${t.skipped} · failed ${t.failed}`

/** What the loop says when it finishes on its own terms. */
function stopMessage(stop: CommitStop, totals: CommitTotals): string {
  if (stop === 'complete') return tally(totals)
  if (stop === 'stalled') {
    return `${tally(totals)}. Some rows are still pending — another import may be `
      + 'running on this batch. Refresh and try again.'
  }
  return `${tally(totals)}. Stopped after ${MAX_COMMIT_PASSES} passes with rows still `
    + 'pending — start the import again to continue.'
}

export function ImportCommitPanel(
  { batchId, status, pending, failed }: {
    batchId: string; status: string; pending: number; failed: number
  },
) {
  const [message, setMessage] = useState<string | null>(null)
  // An explicit busy flag on top of useTransition's isPending: isPending is held
  // across an async transition callback, but a multi-pass commit is several
  // sequential action calls and this flag is what keeps all three controls
  // disabled for the whole run rather than per call. Without it a second click
  // starts an overlapping pass, whose interleaved counts get reported as one
  // confusing total.
  const [inFlight, setInFlight] = useState(false)
  const [transitioning, startTransition] = useTransition()
  const busy = inFlight || transitioning
  // Cancelling is a one-way transition on a single click, so it takes two: the
  // first click arms the button, the second fires it.
  const [cancelArmed, setCancelArmed] = useState(false)
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
  // What to accumulate and when to stop is advanceCommit's decision — pure, and
  // unit-tested for the terminate-on-no-progress and pass-cap arms.
  const runCommit = () => {
    setMessage(null)
    setCancelArmed(false)
    run(async () => {
      let totals = ZERO_COMMIT_TOTALS
      for (;;) {
        let res: Awaited<ReturnType<typeof commitBatchAction>>
        try {
          res = await commitBatchAction({ batchId, limit: 200 })
        } catch (err) {
          // Whatever already committed is committed — say so, or 400 imported
          // rows read as "nothing happened".
          setMessage(`${callFailed('import commit', err)} ${tally(totals)} before this.`)
          return
        }
        if (!res.ok) {
          setMessage(`${res.error} ${tally(totals)} before this.`)
          return
        }
        const step = advanceCommit(totals, res.data)
        totals = step.totals
        if (step.stop !== null) {
          setMessage(stopMessage(step.stop, totals))
          return
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
          that reason, rather than on every pass. Gated on status !== 'cancelled'
          specifically, not on `done`: `done` also covers 'committed', and a
          committed batch with failed rows is exactly the case Retry exists to
          rescue. A cancelled batch can never commit, so its failed rows are not
          requeued by the service either — showing Retry here would succeed at
          nothing and mislead the reviewer into thinking the row is retryable. */}
      {failed > 0 && status !== 'cancelled' && (
        <Button
          variant="outline"
          disabled={busy}
          onClick={() => {
            setCancelArmed(false)
            run(async () => {
              try {
                const res = await retryFailedRowsAction({ batchId })
                setMessage(res.ok
                  ? `Requeued ${res.data.requeued} failed row${res.data.requeued === 1 ? '' : 's'} — import again to retry.`
                  : res.error)
              } catch (err) {
                setMessage(callFailed('import retry', err))
              }
            })
          }}
        >
          Retry {failed} failed row{failed === 1 ? '' : 's'}
        </Button>
      )}
      <Button
        variant="destructive"
        disabled={busy || done}
        onClick={() => {
          if (!cancelArmed) {
            setCancelArmed(true)
            setMessage('Cancelling closes this batch for good — click again to confirm.')
            return
          }
          setCancelArmed(false)
          setMessage(null)
          run(async () => {
            try {
              const res = await cancelBatchAction({ batchId })
              if (!res.ok) setMessage(res.error)
            } catch (err) {
              setMessage(callFailed('import cancel', err))
            }
          })
        }}
      >
        {cancelArmed ? 'Confirm cancel' : 'Cancel batch'}
      </Button>
      {message && <p role="alert" className="text-sm">{message}</p>}
    </div>
  )
}
