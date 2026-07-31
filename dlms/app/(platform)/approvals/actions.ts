'use server'

import { z } from 'zod'
import { revalidatePath } from 'next/cache'
import { requireAal2Actor, MfaRequiredError } from '@/modules/shared/auth/session'
import {
  decideApproval, ApprovalNotFoundError, RejectionNeedsNoteError,
} from '@/modules/shared/approvals/services/approvalService'
import {
  ApprovalDecisionError, type ApprovalStatus,
} from '@/modules/shared/approvals/domain/approvalDecision'
import { PermissionError } from '@/modules/shared/authz/authorize'

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string }

/**
 * Single sanitization contract for the approvals queue, mirroring
 * finance/invoices/invoiceWriteActions.toMessage.
 *
 * The three DECISION refusals pass through verbatim: "you cannot decide your own
 * request", "already decided, raise a new one" and "you do not have permission to
 * decide approval requests" are written for the person reading them and each tells
 * them a different next step. A generic line would be true and useless. Everything
 * unrecognised is logged server-side and replaced, so a raw Postgres error can
 * never reach the browser.
 */
function toMessage(err: unknown): string {
  if (err instanceof MfaRequiredError) {
    return 'Two-factor authentication required — reload the page to finish signing in.'
  }
  if (err instanceof ApprovalNotFoundError) return 'That approval request no longer exists.'
  if (err instanceof ApprovalDecisionError) return err.message
  if (err instanceof RejectionNeedsNoteError) return err.message
  if (err instanceof PermissionError) return "You don't have permission to do that."
  console.error(JSON.stringify({ level: 'error', msg: 'approval action failed', err: String(err) }))
  return 'Something went wrong. Try again, and tell Reet if it keeps happening.'
}

const decideSchema = z.object({
  approvalId: z.string().uuid(),
  decision: z.enum(['approved', 'rejected']),
  note: z.string().max(5000).optional(),
}).refine((d) => d.decision !== 'rejected' || !!d.note?.trim(), {
  // The UI collects the note before the click (ApprovalQueue disables Reject until
  // one is typed), but a server action is a public endpoint and the form can be
  // posted without one. Refused here so the answer is a sentence rather than a
  // round trip that ends in the service's own refusal.
  message: 'A rejection needs a note saying what has to change.', path: ['note'],
})
export type DecideApprovalActionInput = z.input<typeof decideSchema>

/**
 * Approve or reject one request.
 *
 * `requireAal2Actor()` is INSIDE the try, deliberately and not incidentally: an
 * AAL1 session must come back as `{ ok: false }` the queue can render, not as a
 * thrown server-action error the user sees as a blank failure.
 * __tests__/actionAalPinning.test.ts scans for the identifier but not for where it
 * sits, so the placement is pinned by this module's own unit test instead.
 */
export async function decideApprovalAction(
  input: DecideApprovalActionInput,
): Promise<ActionResult<{ status: ApprovalStatus }>> {
  try {
    const actor = await requireAal2Actor()
    const data = decideSchema.parse(input)
    const { status } = await decideApproval(actor, {
      approvalId: data.approvalId, decision: data.decision, note: data.note,
    })
    // The queue is the page that visibly changes. The record's own page is
    // server-rendered on demand and re-reads its approval state on the next
    // request, so the only staleness is Next's client Router Cache.
    revalidatePath('/approvals')
    return { ok: true, data: { status } }
  } catch (err) {
    if (err instanceof z.ZodError) {
      return { ok: false, error: err.errors[0]?.message ?? 'That request could not be read.' }
    }
    return { ok: false, error: toMessage(err) }
  }
}
