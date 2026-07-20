import { notFound } from 'next/navigation'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { listComponentTypes } from '@/modules/manufacturing/services/componentCatalogueService'
import { ComponentCatalogue } from '@/components/manufacturing/ComponentCatalogue'

/**
 * Super Admin screen for the component-type catalogue (spec §11). Every
 * installation across every device references one of these types, so this
 * page includes deactivated types too — an admin needs to see the full
 * history of what has ever been defined, not just what's currently selectable.
 */
export default async function ComponentTypesPage() {
  const actor = await requireActor()
  // 404 rather than 403: a denial must not confirm the section exists (spec §7.3).
  if (!can(actor, 'view_records', 'manufacturing')) notFound()

  const types = await listComponentTypes(actor, { includeInactive: true })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Component types</h1>
        <p className="mt-1 text-slate-600">
          The catalogue every installation across every device references. Tracking mode
          can only be set when a type is created — it cannot be changed afterward.
        </p>
      </div>
      <ComponentCatalogue
        types={types}
        canManage={can(actor, 'manage_vocabularies', 'manufacturing')}
      />
    </div>
  )
}
