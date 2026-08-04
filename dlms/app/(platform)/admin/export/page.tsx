import { notFound } from 'next/navigation'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { EXPORT_ENTITIES, DEFERRED_EXPORT_PARTS }
  from '@/modules/shared/export/domain/entities'
import { EXPORT_MFA_MAX_AGE_SECONDS } from '@/modules/shared/export/domain/mfaFreshness'
import { ExportPanel } from '@/components/export/ExportPanel'

/**
 * Full-system export (spec §12, D36).
 *
 * 404-NOT-403, the house rule for a permission-gated page: a denial must not
 * confirm that the section exists. `request_full_export` is held by super_admin
 * alone under today's matrix.
 *
 * The page is a description of the ceremony, not a button on its own — the actual
 * gate runs again in the download route, because a page render proves nothing
 * about the request that follows it.
 */
export default async function FullExportPage() {
  const actor = await requireActor()
  if (!can(actor, 'request_full_export', 'admin')) notFound()

  const csv = EXPORT_ENTITIES.filter((e) => e.format === 'csv').length
  const json = EXPORT_ENTITIES.filter((e) => e.format === 'json').length

  return (
    <div className="max-w-3xl space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Full-system export</h1>
        <p className="mt-1 text-slate-600">
          Every record this platform holds, as one ZIP: {csv} CSV files, {json} JSON
          files, a manifest with a checksum per file, and documentation of how the
          tables join.
        </p>
      </div>

      <section className="rounded-lg border bg-amber-50 p-4">
        <h2 className="text-sm font-semibold text-amber-900">
          This export is not redacted
        </h2>
        <p className="mt-1 text-sm text-amber-900">
          It contains buyer contact details, invoice amounts, user email addresses,
          confidential tasks and the full audit trail. The control on this data is
          the ceremony required to request it, not field-level redaction — so you
          will be asked for your authenticator code, and the request, the build and
          the download are each recorded in the audit log against your name.
        </p>
      </section>

      <ExportPanel maxAgeSeconds={EXPORT_MFA_MAX_AGE_SECONDS} />

      <section>
        <h2 className="text-sm font-semibold text-slate-700">What you get</h2>
        <ul className="mt-2 space-y-1 text-sm text-slate-600">
          <li><code>csv/</code> — one file per entity, RFC 4180, UTF-8 with BOM</li>
          <li><code>json/</code> — nested and history sets, and anything holding JSON</li>
          <li><code>manifest.json</code> — row counts and a sha256 per file</li>
          <li><code>schema.md</code> — every file and its columns</li>
          <li><code>relationships.md</code> — the stable-UUID join map</li>
          <li><code>README.md</code> — how to verify and open the archive</li>
        </ul>
      </section>

      <section>
        <h2 className="text-sm font-semibold text-slate-700">Not included yet</h2>
        <ul className="mt-2 space-y-2 text-sm text-slate-600">
          {DEFERRED_EXPORT_PARTS.map((d) => (
            <li key={d} className="border-l-2 border-slate-200 pl-3">{d}</li>
          ))}
        </ul>
      </section>
    </div>
  )
}
