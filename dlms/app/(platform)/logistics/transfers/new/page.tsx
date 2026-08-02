import { notFound } from 'next/navigation'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { listLocations } from '@/modules/logistics/services/locationService'
import { NewStockTransferForm } from '@/components/logistics/NewStockTransferForm'

/** Create a stock transfer. 404-not-403 so a denial doesn't confirm the route. */
export default async function NewStockTransferPage() {
  const actor = await requireActor()
  if (!can(actor, 'create_records', 'logistics')) notFound()

  const locations = await listLocations(actor)

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">New stock transfer</h1>
        <p className="mt-1 text-slate-600">
          Move batch quantities and serialized units between two stock locations.
        </p>
      </div>
      {locations.length < 2 ? (
        <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-600">
          A transfer needs two active stock locations. Add another under Stock locations first.
        </p>
      ) : (
        <NewStockTransferForm locations={locations} />
      )}
    </div>
  )
}
