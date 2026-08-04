'use server'

import { revalidatePath } from 'next/cache'
import { requireAal2Actor, MfaRequiredError } from '@/modules/shared/auth/session'
import {
  recordUsage, UsageDeviceNotFoundError, UsageDateInFutureError,
  type RecordUsageInput, type RecordUsageResult,
} from '@/modules/maintenance/services/usageService'
import { PermissionError } from '@/modules/shared/authz/authorize'

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string }

/**
 * Single sanitization contract for the usage write action (mirrors
 * repairs/actions.ts's toMessage). Known, safe errors surface their own message;
 * anything else is logged server-side and replaced with a generic line so a raw
 * Postgres/internal error can never reach the browser.
 *
 * There is deliberately NO branch for a non-monotonic reading: that is not an
 * error at all (spec §6.3 accepts it with a warning), so it never reaches here —
 * it comes back in the SUCCESS payload as `classification`.
 */
function toMessage(err: unknown): string {
  if (err instanceof MfaRequiredError) {
    return 'Two-factor authentication required — reload the page to finish signing in.'
  }
  // Its own message names the offending date. This IS an error, unlike a
  // non-monotonic reading: a future date is uncorrectable on an append-only
  // table, so it has to be refused rather than warned about.
  if (err instanceof UsageDateInFutureError) return err.message
  if (err instanceof UsageDeviceNotFoundError) {
    return 'That device no longer exists. Reload and try again.'
  }
  if (err instanceof PermissionError) return "You don't have permission to do that."
  console.error(JSON.stringify({ level: 'error', msg: 'usage write action failed', err: String(err) }))
  return 'Something went wrong. Try again, and tell Reet if it keeps happening.'
}

export async function recordUsageAction(
  input: RecordUsageInput,
): Promise<ActionResult<RecordUsageResult>> {
  try {
    // Inside the try, so an escaping MfaRequiredError becomes a mapped message
    // rather than an unhandled server-action rejection.
    const actor = await requireAal2Actor()
    const res = await recordUsage(actor, input)
    revalidatePath('/maintenance')
    revalidatePath('/maintenance/usage')
    revalidatePath(`/manufacturing/devices/${input.deviceId}`)
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}
