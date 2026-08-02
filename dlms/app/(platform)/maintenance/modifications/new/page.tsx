import { notFound } from 'next/navigation'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import {
  listModifiableDevices, listModificationTypeOptions, listEcoOptions,
} from '@/modules/maintenance/services/modificationService'
import { NewModificationForm } from '@/components/maintenance/NewModificationForm'

type PageProps = { searchParams: { deviceId?: string } }

/**
 * Raise a modification (spec §6.3). 404-not-403 so a denial doesn't confirm the
 * route. A `deviceId` search param (passed from a device profile) preselects and
 * locks the device; otherwise a picker lists live devices.
 *
 * THE ECO OPTIONS ARE GATED ON ENGINEERING, not Maintenance. `listEcoOptions`
 * calls authorize(actor, 'view_records', 'engineering') and THROWS on a denial
 * rather than returning empty, so calling it unconditionally would make this
 * page a 500 for every Maintenance-only user. The same shape as the components
 * panel's manufacturing gate on the detail page. An absent ECO link is a valid
 * modification — `eco_id` is nullable — so the field simply does not render.
 */
export default async function NewModificationPage({ searchParams }: PageProps) {
  const actor = await requireActor()
  if (!can(actor, 'create_records', 'maintenance')) notFound()

  const canSeeEcos = can(actor, 'view_records', 'engineering')
  const [devices, types, ecos] = await Promise.all([
    listModifiableDevices(actor),
    listModificationTypeOptions(actor),
    canSeeEcos ? listEcoOptions(actor) : Promise.resolve([]),
  ])

  const presetDeviceId = searchParams.deviceId && devices.some((d) => d.id === searchParams.deviceId)
    ? searchParams.deviceId
    : undefined

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">New modification</h1>
        <p className="mt-1 text-slate-600">
          Record a change to a device already in the field or in the registry.
        </p>
      </div>
      <NewModificationForm
        devices={devices}
        types={types}
        ecos={ecos}
        presetDeviceId={presetDeviceId}
        todayIso={new Date().toISOString().slice(0, 10)}
      />
    </div>
  )
}
