'use server'

import {
  requireAal2Actor, MfaRequiredError, UnauthenticatedError, SESSION_EXPIRED_MESSAGE,
} from '@/modules/shared/auth/session'
import { listDevices } from '@/modules/manufacturing/services/deviceReadService'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { DeviceFilter, DeviceListItem } from '@/modules/manufacturing/services/deviceReadService'

type LoadMoreResult = { items: DeviceListItem[]; nextCursor: string | null } | { error: string }

/**
 * Server action behind DeviceTable's "Load more". The active filters and the
 * keyset cursor travel together on every call, so paging can never drift even
 * if devices are created elsewhere during the session (offset pagination would).
 */
export async function loadMoreDevicesAction(filter: DeviceFilter): Promise<LoadMoreResult> {
  try {
    const actor = await requireAal2Actor()
    return await listDevices(actor, filter)
  } catch (err) {
    if (err instanceof MfaRequiredError) {
      return { error: 'Two-factor authentication required — reload the page to finish signing in.' }
    }
    if (err instanceof UnauthenticatedError) return { error: SESSION_EXPIRED_MESSAGE }
    if (err instanceof PermissionError) {
      return { error: "You don't have permission to view these devices." }
    }
    console.error(JSON.stringify({ level: 'error', msg: 'loadMoreDevices failed', err: String(err) }))
    return { error: 'Something went wrong loading more devices. Try again.' }
  }
}
