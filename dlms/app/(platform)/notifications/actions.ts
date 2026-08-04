'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import {
  requireAal2Actor, MfaRequiredError, UnauthenticatedError, SESSION_EXPIRED_MESSAGE,
} from '@/modules/shared/auth/session'
import {
  markRead, markAllRead, setPreference,
} from '@/modules/shared/notifications/services/notificationService'
import { isNotificationCategory } from '@/modules/shared/notifications/domain/preferences'
import { PermissionError } from '@/modules/shared/authz/authorize'

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string }

/**
 * Single sanitization contract for the notification centre, mirroring
 * approvals/actions.toMessage.
 *
 * Nothing here has a domain refusal worth passing through verbatim — marking your own
 * notification read cannot be denied for an interesting reason — so everything
 * unrecognised is logged server-side and replaced, and a raw Postgres error can never
 * reach the browser.
 */
function toMessage(err: unknown): string {
  if (err instanceof MfaRequiredError) {
    return 'Two-factor authentication required — reload the page to finish signing in.'
  }
  if (err instanceof UnauthenticatedError) return SESSION_EXPIRED_MESSAGE
  if (err instanceof PermissionError) return "You don't have permission to do that."
  console.error(JSON.stringify({
    level: 'error', msg: 'notification action failed', err: String(err),
  }))
  return 'Something went wrong. Try again, and tell Reet if it keeps happening.'
}

/**
 * The bell and the list both change, and neither is the page the user is necessarily on:
 * the bell lives in the shared platform layout, so a read on /notifications has to
 * invalidate the layout as well as the page.
 */
function revalidateNotificationSurfaces(): void {
  revalidatePath('/notifications')
  revalidatePath('/(platform)', 'layout')
}

/**
 * `requireAal2Actor()` is INSIDE the try, deliberately: an AAL1 session must come back as
 * `{ ok: false }` the UI can render, not as a thrown server-action error the user sees as
 * a blank failure. __tests__/actionAalPinning.test.ts scans for the identifier.
 */
export async function markNotificationReadAction(
  notificationId: string,
): Promise<ActionResult<null>> {
  try {
    const actor = await requireAal2Actor()
    await markRead(actor, z.string().uuid().parse(notificationId))
    revalidateNotificationSurfaces()
    return { ok: true, data: null }
  } catch (err) {
    if (err instanceof z.ZodError) return { ok: false, error: 'That notification is not valid.' }
    return { ok: false, error: toMessage(err) }
  }
}

export async function markAllNotificationsReadAction(): Promise<ActionResult<{ marked: number }>> {
  try {
    const actor = await requireAal2Actor()
    const result = await markAllRead(actor)
    revalidateNotificationSurfaces()
    return { ok: true, data: result }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

const preferenceSchema = z.object({
  category: z.string().refine(isNotificationCategory, 'Unknown notification category'),
  inApp: z.boolean(),
  email: z.boolean(),
  digest: z.boolean(),
})
export type SetPreferenceActionInput = z.input<typeof preferenceSchema>

/**
 * Saves ONE category's preferences for the signed-in user.
 *
 * There is no user id in the input, and there must not be: the service cannot express
 * editing somebody else's delivery preferences, because that is a way to silence a
 * person's alerts without their knowledge.
 */
export async function setNotificationPreferenceAction(
  input: SetPreferenceActionInput,
): Promise<ActionResult<null>> {
  try {
    const actor = await requireAal2Actor()
    await setPreference(actor, preferenceSchema.parse(input))
    revalidatePath('/notifications/preferences')
    return { ok: true, data: null }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { ok: false, error: err.errors[0]?.message ?? 'That preference could not be read.' }
    }
    return { ok: false, error: toMessage(err) }
  }
}
