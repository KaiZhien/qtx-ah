import { notFound } from 'next/navigation'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { NewBuyerForm } from '@/components/finance/NewBuyerForm'

/** Create a buyer. 404-not-403 so a denial doesn't confirm the route. */
export default async function NewBuyerPage() {
  const actor = await requireActor()
  if (!can(actor, 'manage_finance', 'finance')) notFound()

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">New buyer</h1>
        <p className="mt-1 text-slate-600">Register a customer to bill on sales invoices.</p>
      </div>
      <NewBuyerForm />
    </div>
  )
}
