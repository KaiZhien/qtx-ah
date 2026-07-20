'use server'

import { revalidatePath } from 'next/cache'
import { requireAal2Actor, MfaRequiredError } from '@/modules/shared/auth/session'
import {
  createInvoice, updateInvoice, changeInvoiceStatus,
  InvoiceNotFoundError, DuplicateInvoiceNoError,
  type CreateInvoiceInput, type UpdateInvoiceInput, type ChangeInvoiceStatusInput,
} from '@/modules/finance/services/invoiceService'
import { BuyerNotFoundError } from '@/modules/finance/services/buyerService'
import { InvalidInvoiceStatusChangeError } from '@/modules/finance/domain/invoiceStatus'
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
