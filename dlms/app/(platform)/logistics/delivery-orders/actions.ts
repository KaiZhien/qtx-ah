'use server'

import { requireActor } from '@/modules/shared/auth/session'
import { listDeliveryOrders } from '@/modules/logistics/services/deliveryOrderService'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type {
  DeliveryOrderFilter, DeliveryOrderListItem,
} from '@/modules/logistics/services/deliveryOrderService'

type LoadMoreResult = { items: DeliveryOrderListItem[]; nextCursor: string | null } | { error: string }

/**
 * Server action behind DeliveryOrderTable's "Load more". Mirrors
 * manufacturing/devices/actions.ts's loadMoreDevicesAction: the active
 * filters and the keyset cursor travel together on every call, so paging
 * can never drift even if DOs are created elsewhere during the session.
 */
export async function loadMoreDeliveryOrdersAction(filter: DeliveryOrderFilter): Promise<LoadMoreResult> {
  try {
    const actor = await requireActor()
    return await listDeliveryOrders(actor, filter)
  } catch (err) {
    if (err instanceof PermissionError) {
      return { error: "You don't have permission to view these delivery orders." }
    }
    console.error(JSON.stringify({ level: 'error', msg: 'loadMoreDeliveryOrders failed', err: String(err) }))
    return { error: 'Something went wrong loading more delivery orders. Try again.' }
  }
}
