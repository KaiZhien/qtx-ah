import { notFound } from 'next/navigation'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import {
  listFailureDeviceOptions, listFailureRepairOptions,
} from '@/modules/engineering/services/failureService'
import { NewFailureForm } from '@/components/engineering/NewFailureForm'

/** Open an investigation. 404-not-403 so a denial doesn't confirm the route. */
export default async function NewFailurePage() {
  const actor = await requireActor()
  if (!can(actor, 'create_records', 'engineering')) notFound()

  const [deviceOptions, repairOptions] = await Promise.all([
    listFailureDeviceOptions(actor),
    listFailureRepairOptions(actor),
  ])

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">New failure investigation</h1>
        <p className="mt-1 text-slate-600">Record a failure and start the root-cause analysis.</p>
      </div>
      <NewFailureForm deviceOptions={deviceOptions} repairOptions={repairOptions} />
    </div>
  )
}
