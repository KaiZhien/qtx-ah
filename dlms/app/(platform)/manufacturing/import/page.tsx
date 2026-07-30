import { notFound } from 'next/navigation'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { listVariantOptions } from '@/modules/manufacturing/services/deviceReadService'
import { ImportUploadForm } from '@/components/manufacturing/ImportUploadForm'

export const dynamic = 'force-dynamic'

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
    </div>
  )
}
