'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requireAal2Actor, MfaRequiredError } from '@/modules/shared/auth/session'
import { PermissionError } from '@/modules/shared/authz/authorize'
import { OptimisticLockError } from '@/lib/db/tx'
import {
  updateSetting, SettingNotEditableError,
} from '@/modules/shared/settings/services/settingService'

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string }

/**
 * Single sanitization contract for the settings console, mirroring
 * app/(platform)/approvals/actions.ts's toMessage.
 *
 * `SettingNotEditableError` passes through verbatim: its message is the
 * registry's own explanation of why a value was refused ("must be a plain
 * number…"), written for the administrator who just typed it and shown next to
 * the field. Replacing it with a generic line would leave them guessing at a
 * validation rule the system knows exactly.
 *
 * Everything unrecognised is logged server-side and replaced, so a raw Postgres
 * error can never reach the browser.
 */
function toMessage(err: unknown): string {
  if (err instanceof MfaRequiredError) {
    return 'Two-factor authentication required — reload the page to finish signing in.'
  }
  if (err instanceof SettingNotEditableError) return err.message
  if (err instanceof OptimisticLockError) {
    return 'Someone else changed this setting while you were editing it. Reload the page to see '
      + 'the current value, then apply your change again.'
  }
  if (err instanceof PermissionError) return "You don't have permission to do that."
  console.error(JSON.stringify({
    level: 'error', msg: 'settings action failed', err: String(err),
  }))
  return 'Something went wrong. Try again, and tell Reet if it keeps happening.'
}

const updateActionSchema = z.object({
  key: z.string().min(1).max(100),
  value: z.string().max(10_000),
  version: z.number().int().nonnegative(),
})
export type UpdateSettingActionInput = z.input<typeof updateActionSchema>

/**
 * Change one runtime knob.
 *
 * `requireAal2Actor()` is INSIDE the try, deliberately: an AAL1 session must come
 * back as `{ ok: false }` the form can render, not as a thrown server-action
 * error the administrator sees as a blank failure.
 * __tests__/actionAalPinning.test.ts scans for the identifier.
 */
export async function updateSettingAction(
  input: UpdateSettingActionInput,
): Promise<ActionResult<{ version: number }>> {
  try {
    const actor = await requireAal2Actor()
    const data = updateActionSchema.parse(input)
    const { version } = await updateSetting(actor, data)
    revalidatePath('/admin/settings')
    return { ok: true, data: { version } }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { ok: false, error: err.errors[0]?.message ?? 'That change could not be read.' }
    }
    return { ok: false, error: toMessage(err) }
  }
}
