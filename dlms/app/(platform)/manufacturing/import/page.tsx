import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { listVariantOptions } from '@/modules/manufacturing/services/deviceReadService'
import { listImportBatches } from '@/modules/manufacturing/services/importCommitService'
import { ImportUploadForm } from '@/components/manufacturing/ImportUploadForm'

export const dynamic = 'force-dynamic'

function formatDateTime(d: Date | string): string {
  return new Date(d).toLocaleString(undefined, {
    year: 'numeric', month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  })
}

/**
 * The bulk-import entry point (spec §11). 404 rather than 403 on a denial, so
 * the section is not confirmed to exist for someone without import_data
 * (spec §7.3, same as the device pages).
 *
 * view_records is gated here too, because listVariantOptions below authorizes
 * it: every seeded role that carries import_data also carries view_records, but
 * per-user permission overrides are resolved into the actor, so the combination
 * is constructible — and it would pass the gate and then hit an unhandled
 * PermissionError in the error boundary instead of this page's 404.
 */
export default async function ImportPage() {
  const actor = await requireActor()
  if (!can(actor, 'import_data', 'manufacturing')
      || !can(actor, 'view_records', 'manufacturing')) notFound()

  const variants = await listVariantOptions(actor)
  const batches = await listImportBatches(actor)

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Import devices</h1>
        <p className="text-muted-foreground mt-1 text-sm">
          Upload a traceability spreadsheet. Nothing is created until you review the
          rows and confirm — serial ranges like <code>…0001 to 0015</code> are expanded
          into one device each.
        </p>
      </div>
      {/* An empty <select> is unsubmittable in practice: the action would answer
          "Choose the device variant for this file" with nothing to choose. Say
          what is actually wrong instead of rendering a form that cannot be
          completed. */}
      {variants.length === 0 ? (
        <p className="text-muted-foreground rounded-lg border bg-white p-4 text-sm">
          No active device variants are configured, so there is nothing to import
          against. Ask an administrator to add one, then come back.
        </p>
      ) : (
        <ImportUploadForm variants={variants} />
      )}

      {/* Recent batches. Without this a batch is unreachable the moment its URL
          is lost: a tab closed mid-commit leaves it at 'committing' with valid
          rows, and every part of the commit design — retryFailedRows, the pass
          cap, SKIP LOCKED — assumes someone can come back to it. This is also
          what makes uploadImportAction's revalidatePath('/manufacturing/import')
          mean something. */}
      <div className="space-y-2">
        <h2 className="text-sm font-medium text-slate-900">Recent imports</h2>
        {batches.length === 0 ? (
          <p className="text-muted-foreground rounded-lg border bg-white p-4 text-sm">
            Nothing imported yet. An uploaded file appears here until it is committed
            or cancelled.
          </p>
        ) : (
          <ul className="divide-y rounded-lg border bg-white">
            {batches.map((b) => (
              <li key={b.batchId} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 p-3">
                <Link
                  href={`/manufacturing/import/${b.batchId}`}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  {b.filename}
                </Link>
                <span className="bg-muted rounded px-2 py-0.5 text-xs">{b.status}</span>
                <span className="text-muted-foreground text-xs">
                  {b.rowCount} row{b.rowCount === 1 ? '' : 's'} ·{' '}
                  {b.committedCount} imported · {b.pendingCount} ready
                </span>
                <span className="text-muted-foreground ml-auto text-xs">
                  {formatDateTime(b.createdAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
