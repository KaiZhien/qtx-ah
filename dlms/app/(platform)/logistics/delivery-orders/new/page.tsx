import { notFound } from 'next/navigation'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { NewDeliveryOrderForm } from '@/components/logistics/NewDeliveryOrderForm'

/** Create a delivery order. 404-not-403 so a denial doesn't confirm the route. */
export default async function NewDeliveryOrderPage() {
  const actor = await requireActor()
  if (!can(actor, 'create_records', 'logistics')) notFound()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">New delivery order</h1>
        <p className="mt-1 text-slate-600">Create a delivery order with its shipped line items.</p>
      </div>
      <NewDeliveryOrderForm />
    </div>
  )
}
