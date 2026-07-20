import { notFound } from 'next/navigation'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { listVariantOptions, listPhaseOptions } from '@/modules/manufacturing/services/deviceReadService'
import { NewDeviceForm } from '@/components/manufacturing/NewDeviceForm'

/** Create a device (spec §5.2). 404-not-403 so a denial doesn't confirm the route. */
export default async function NewDevicePage() {
  const actor = await requireActor()
  if (!can(actor, 'create_records', 'manufacturing')) notFound()

  const [variantOptions, phaseOptions] = await Promise.all([
    listVariantOptions(actor), listPhaseOptions(actor),
  ])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">New device</h1>
        <p className="mt-1 text-slate-600">Register a device in the manufacturing registry.</p>
      </div>
      <NewDeviceForm variantOptions={variantOptions} phaseOptions={phaseOptions} />
    </div>
  )
}
