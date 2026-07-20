'use server'

import { requireActor } from '@/modules/shared/auth/session'
import { listInvoices } from '@/modules/finance/services/invoiceService'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { InvoiceFilter, InvoiceListItem } from '@/modules/finance/services/invoiceService'

type LoadMoreResult = { items: InvoiceListItem[]; nextCursor: string | null } | { error: string }

/**
 * Server action behind InvoiceTable's "Load more". The active filters and the
 * keyset cursor travel together on every call — same convention as
 * manufacturing/devices/actions.loadMoreDevicesAction.
 */
export async function loadMoreInvoicesAction(filter: InvoiceFilter): Promise<LoadMoreResult> {
  try {
    const actor = await requireActor()
    return await listInvoices(actor, filter)
  } catch (err) {
    if (err instanceof PermissionError) {
      return { error: "You don't have permission to view these invoices." }
    }
    console.error(JSON.stringify({ level: 'error', msg: 'loadMoreInvoices failed', err: String(err) }))
    return { error: 'Something went wrong loading more invoices. Try again.' }
  }
}
