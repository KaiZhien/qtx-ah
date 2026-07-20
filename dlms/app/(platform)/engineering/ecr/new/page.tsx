import { notFound } from 'next/navigation'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { listVariantOptions } from '@/modules/engineering/services/engineeringReadService'
import { NewEcrForm } from '@/components/engineering/NewEcrForm'

/** Create an ECR. 404-not-403 so a denial doesn't confirm the route (spec §7.3). */
export default async function NewEcrPage() {
  const actor = await requireActor()
  if (!can(actor, 'create_records', 'engineering')) notFound()

  const variantOptions = await listVariantOptions(actor)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">New change request</h1>
        <p className="mt-1 text-slate-600">Raise an engineering change request.</p>
      </div>
      <NewEcrForm variantOptions={variantOptions} />
    </div>
  )
}
