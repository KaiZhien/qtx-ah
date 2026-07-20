import { notFound } from 'next/navigation'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { listComponentTypeOptions } from '@/modules/engineering/services/engineeringReadService'
import { NewFirmwareForm } from '@/components/engineering/NewFirmwareForm'

/** Create a firmware release. 404-not-403 so a denial doesn't confirm the route. */
export default async function NewFirmwarePage() {
  const actor = await requireActor()
  if (!can(actor, 'create_records', 'engineering')) notFound()

  const componentTypeOptions = await listComponentTypeOptions(actor)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">New firmware release</h1>
        <p className="mt-1 text-slate-600">Register a firmware build for a component type.</p>
      </div>
      <NewFirmwareForm componentTypeOptions={componentTypeOptions} />
    </div>
  )
}
