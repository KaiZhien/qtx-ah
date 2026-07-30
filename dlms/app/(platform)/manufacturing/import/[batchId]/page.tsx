import { notFound } from 'next/navigation'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import {
  getImportBatch, listImportRows,
} from '@/modules/manufacturing/services/importCommitService'
import { resolveRowStatus } from '@/modules/manufacturing/domain/importUi'
import { ImportReviewTable } from '@/components/manufacturing/ImportReviewTable'
import { ImportCommitPanel } from '@/components/manufacturing/ImportCommitPanel'

export const dynamic = 'force-dynamic'

export default async function ImportBatchPage(
  { params, searchParams }: {
    params: { batchId: string }
    searchParams: { status?: string | string[] }
  },
) {
  const actor = await requireActor()
  if (!can(actor, 'import_data', 'manufacturing')) notFound()

  const batch = await getImportBatch(actor, params.batchId)
  if (!batch) notFound()

  // One status at a time, filtered in SQL. listImportRows caps its page, so
  // loading the whole batch and filtering client-side would silently hide rows
  // on a large file — and the counts the tabs show come from getImportBatch's
  // GROUP BY, which is exact regardless of the cap. resolveRowStatus owns the
  // allowlist-plus-fallback (unit-tested; the parameter is attacker-controlled
  // and Next hands back an array for a repeated key).
  const active = resolveRowStatus(searchParams.status)
  const rows = await listImportRows(actor, params.batchId, active)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">{batch.filename}</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          {batch.counts.valid} ready · {batch.counts.needs_review} need review ·{' '}
          {batch.counts.invalid} invalid · {batch.counts.committed} imported ·{' '}
          {batch.counts.skipped} skipped · {batch.counts.failed} failed
        </p>
        {batch.unmappedHeaders.length > 0 && (
          <p className="text-muted-foreground mt-1 text-xs">
            Ignored columns: {batch.unmappedHeaders.join(', ')}
          </p>
        )}
      </div>

      <ImportCommitPanel
        batchId={batch.batchId}
        status={batch.status}
        pending={batch.counts.valid}
        failed={batch.counts.failed}
      />
      <ImportReviewTable
        batchId={batch.batchId} rows={rows} active={active} counts={batch.counts} />
    </div>
  )
}
