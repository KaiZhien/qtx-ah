'use server'

import { revalidatePath } from 'next/cache'
import { requireAal2Actor, MfaRequiredError } from '@/modules/shared/auth/session'
import {
  createInvoice, updateInvoice, changeInvoiceStatus, requestInvoiceApproval,
  InvoiceNotFoundError, DuplicateInvoiceNoError,
  type CreateInvoiceInput, type UpdateInvoiceInput, type ChangeInvoiceStatusInput,
  type RequestInvoiceApprovalInput,
} from '@/modules/finance/services/invoiceService'
import { BuyerNotFoundError } from '@/modules/finance/services/buyerService'
import { InvalidInvoiceStatusChangeError } from '@/modules/finance/domain/invoiceStatus'
import { InvoiceApprovalError } from '@/modules/finance/domain/invoiceApproval'
import { ApprovalAlreadyPendingError } from '@/modules/shared/approvals/services/approvalService'
import { SettingUnavailableError } from '@/modules/shared/settings/services/settingService'
import { OptimisticLockError } from '@/lib/db/tx'
import { PermissionError } from '@/modules/shared/authz/authorize'

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string }

/**
 * Single sanitization contract for every invoice write action (mirrors
 * manufacturing/devices/deviceWriteActions.toMessage). Known, safe errors
 * surface their own message; anything else is logged server-side and replaced
 * with a generic line so a raw Postgres/internal error can never reach the browser.
 */
function toMessage(err: unknown): string {
  if (err instanceof MfaRequiredError) {
    return 'Two-factor authentication required — reload the page to finish signing in.'
  }
  if (err instanceof DuplicateInvoiceNoError) return err.message
  if (err instanceof InvalidInvoiceStatusChangeError) return err.message
  // The approval gate's refusals are written FOR the user — they name the
  // threshold, the rejection note, or exactly which field drifted — so they pass
  // through verbatim rather than being flattened into "something went wrong".
  if (err instanceof InvoiceApprovalError) return err.message
  // Expected traffic, not a bug: the honest double-click and the honest
  // re-submit both produce it (approvalService's header says so).
  if (err instanceof ApprovalAlreadyPendingError) return err.message
  if (err instanceof SettingUnavailableError) return err.message
  if (err instanceof BuyerNotFoundError) return 'That buyer no longer exists. Reload and try again.'
  if (err instanceof InvoiceNotFoundError) return 'That invoice no longer exists. Reload and try again.'
  if (err instanceof OptimisticLockError) return 'Someone else changed this invoice. Reload and try again.'
  if (err instanceof PermissionError) return "You don't have permission to do that."
  console.error(JSON.stringify({ level: 'error', msg: 'invoice write action failed', err: String(err) }))
  return 'Something went wrong. Try again, and tell Reet if it keeps happening.'
}

export async function createInvoiceAction(
  input: CreateInvoiceInput,
): Promise<ActionResult<{ invoiceId: string }>> {
  try {
    const actor = await requireAal2Actor()
    const { invoiceId } = await createInvoice(actor, input)
    revalidatePath('/finance/invoices')
    return { ok: true, data: { invoiceId } }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function updateInvoiceAction(
  input: UpdateInvoiceInput,
): Promise<ActionResult<{ version: number }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await updateInvoice(actor, input)
    revalidatePath(`/finance/invoices/${input.invoiceId}`)
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

/**
 * Send an invoice for a second pair of eyes (spec BR-4). Revalidates the detail
 * page AND the approvals queue, since the request lands in someone else's list
 * the moment it commits — the queue reads `approval` directly and does not wait
 * for the outbox drain.
 */
export async function requestInvoiceApprovalAction(
  input: RequestInvoiceApprovalInput,
): Promise<ActionResult<{ approvalId: string }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await requestInvoiceApproval(actor, input)
    revalidatePath(`/finance/invoices/${input.invoiceId}`)
    revalidatePath('/approvals')
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function changeInvoiceStatusAction(
  input: ChangeInvoiceStatusInput,
): Promise<ActionResult<{ status: string; version: number }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await changeInvoiceStatus(actor, input)
    revalidatePath(`/finance/invoices/${input.invoiceId}`)
    revalidatePath('/finance')
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}
