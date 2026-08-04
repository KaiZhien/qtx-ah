'use server'

import {
  requireAal2Actor, MfaRequiredError, UnauthenticatedError, SESSION_EXPIRED_MESSAGE,
} from '@/modules/shared/auth/session'
import { listBuyers } from '@/modules/finance/services/buyerService'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { BuyerFilter, BuyerListItem } from '@/modules/finance/services/buyerService'

type LoadMoreResult = { items: BuyerListItem[]; nextCursor: string | null } | { error: string }

/**
 * Server action behind BuyerTable's "Load more". The active filters and the
 * keyset cursor travel together on every call — same convention as
 * manufacturing/devices/actions.loadMoreDevicesAction.
 */
export async function loadMoreBuyersAction(filter: BuyerFilter): Promise<LoadMoreResult> {
  try {
    const actor = await requireAal2Actor()
    return await listBuyers(actor, filter)
  } catch (err) {
    if (err instanceof MfaRequiredError) {
      return { error: 'Two-factor authentication required — reload the page to finish signing in.' }
    }
    if (err instanceof UnauthenticatedError) return { error: SESSION_EXPIRED_MESSAGE }
    if (err instanceof PermissionError) {
      return { error: "You don't have permission to view these buyers." }
    }
    console.error(JSON.stringify({ level: 'error', msg: 'loadMoreBuyers failed', err: String(err) }))
    return { error: 'Something went wrong loading more buyers. Try again.' }
  }
}
