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
 */
export default async function ImportPage() {
  const actor = await requireActor()
  if (!can(actor, 'import_data', 'manufacturing')) notFound()

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
      <ImportUploadForm variants={variants} />
    </div>
  )
}
