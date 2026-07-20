import { notFound } from 'next/navigation'
import Link from 'next/link'
import { requireActor } from '@/modules/shared/auth/session'
import { can } from '@/modules/shared/authz/policy'
import { listBuyerOptions } from '@/modules/finance/services/buyerService'
import { NewInvoiceForm } from '@/components/finance/NewInvoiceForm'

/** Create a sales invoice + lines. 404-not-403 so a denial doesn't confirm the route. */
export default async function NewInvoicePage() {
  const actor = await requireActor()
  if (!can(actor, 'manage_finance', 'finance')) notFound()

  const buyerOptions = await listBuyerOptions(actor)

  if (buyerOptions.length === 0) {
    return (
      <div className="space-y-4">
        <h1 className="text-2xl font-semibold text-slate-900">New invoice</h1>
        <p className="rounded-md border p-4 text-sm text-muted-foreground">
          No buyers yet. <Link href="/finance/buyers/new" className="underline">Create a buyer</Link> before
          raising an invoice.
        </p>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold text-slate-900">New invoice</h1>
        <p className="mt-1 text-slate-600">Raise a sales invoice against a buyer.</p>
      </div>
      <NewInvoiceForm buyerOptions={buyerOptions} />
    </div>
  )
}
