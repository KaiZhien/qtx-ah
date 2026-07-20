import { notFound } from 'next/navigation'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { listRepairableDevices } from '@/modules/maintenance/services/repairService'
import { NewRepairForm } from '@/components/maintenance/NewRepairForm'

type PageProps = { searchParams: { deviceId?: string } }

/**
 * Open a repair (spec §5.3). 404-not-403 so a denial doesn't confirm the route.
 * A `deviceId` search param (passed from a device profile's "New repair" action)
 * preselects and locks the device; otherwise a picker lists repairable devices.
 */
export default async function NewRepairPage({ searchParams }: PageProps) {
  const actor = await requireActor()
  if (!can(actor, 'create_records', 'maintenance')) notFound()

  const devices = await listRepairableDevices(actor)
  const presetDeviceId = searchParams.deviceId && devices.some((d) => d.id === searchParams.deviceId)
    ? searchParams.deviceId
    : undefined
  const canMoveDevice = can(actor, 'change_device_status', 'manufacturing')

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">New repair</h1>
        <p className="mt-1 text-slate-600">Open a repair against a device in the registry.</p>
      </div>
      <NewRepairForm devices={devices} presetDeviceId={presetDeviceId} canMoveDevice={canMoveDevice} />
    </div>
  )
}
