import { notFound } from 'next/navigation'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { listLocations } from '@/modules/logistics/services/locationService'
import { LocationCatalogue } from '@/components/logistics/LocationCatalogue'

/**
 * Stock locations (spec §6.3 "Logistics stock", Basic scope). Includes
 * deactivated locations too — component_unit.location_id and past delivery
 * orders may still reference one, so a full history is more useful here than
 * only what's currently selectable (same rationale as the Component types
 * catalogue).
 */
export default async function LocationsPage() {
  const actor = await requireActor()
  // 404 rather than 403: a denial must not confirm the section exists (spec §7.3).
  if (!can(actor, 'view_records', 'logistics')) notFound()

  const locations = await listLocations(actor, { includeInactive: true })

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">Stock locations</h1>
        <p className="mt-1 text-slate-600">
          Warehouses, shelves, and repair benches that hold stock or component units.
        </p>
      </div>
      <LocationCatalogue
        locations={locations}
        canManage={can(actor, 'edit_records', 'logistics') || can(actor, 'create_records', 'logistics')}
      />
    </div>
  )
}
