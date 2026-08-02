'use server'

import { revalidatePath } from 'next/cache'
import { requireAal2Actor, MfaRequiredError } from '@/modules/shared/auth/session'
import {
  listStockTransfers, createStockTransfer, changeTransferStatus, receiveStockTransfer,
  StockTransferNotFoundError, DuplicateTransferNumberError, InsufficientStockError,
  TrackingModeMismatchError, UnknownReferenceError, SerializedUnitNotAtSourceError,
  StockPostingError,
  type CreateStockTransferInput, type ChangeTransferStatusInput,
  type ReceiveStockTransferInput, type StockTransferFilter, type StockTransferListItem,
} from '@/modules/logistics/services/stockTransferService'
import { InvalidTransferStatusChangeError } from '@/modules/logistics/domain/transferStatus'
import { OptimisticLockError } from '@/lib/db/tx'
import { PermissionError } from '@/modules/shared/authz/authorize'

export type ActionResult<T> = { ok: true; data: T } | { ok: false; error: string }

/**
 * Single sanitization contract for every stock-transfer action (mirrors
 * deliveryOrderWriteActions.toMessage). Known, safe errors surface their own
 * message — InsufficientStockError in particular is written to be shown
 * verbatim, since "not enough PCBA-A at SG-WH" is exactly what the receiving
 * clerk needs to know. Anything else is logged server-side and replaced with a
 * generic line so a raw Postgres error can never reach the browser.
 */
function toMessage(err: unknown): string {
  if (err instanceof MfaRequiredError) {
    return 'Two-factor authentication required — reload the page to finish signing in.'
  }
  if (err instanceof DuplicateTransferNumberError) return err.message
  if (err instanceof InsufficientStockError) return err.message
  if (err instanceof TrackingModeMismatchError) return err.message
  if (err instanceof SerializedUnitNotAtSourceError) return err.message
  if (err instanceof UnknownReferenceError) return err.message
  if (err instanceof StockPostingError) return err.message
  if (err instanceof InvalidTransferStatusChangeError) return err.message
  if (err instanceof StockTransferNotFoundError) {
    return 'That stock transfer no longer exists. Reload and try again.'
  }
  if (err instanceof OptimisticLockError) {
    return 'Someone else changed this transfer. Reload and try again.'
  }
  if (err instanceof PermissionError) return "You don't have permission to do that."
  console.error(JSON.stringify({ level: 'error', msg: 'stock transfer action failed', err: String(err) }))
  return 'Something went wrong. Try again, and tell Reet if it keeps happening.'
}

export async function createStockTransferAction(
  input: CreateStockTransferInput,
): Promise<ActionResult<{ id: string }>> {
  try {
    const actor = await requireAal2Actor()
    const { id } = await createStockTransfer(actor, input)
    revalidatePath('/logistics/transfers')
    revalidatePath('/logistics')
    return { ok: true, data: { id } }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

export async function changeTransferStatusAction(
  input: ChangeTransferStatusInput,
): Promise<ActionResult<{ status: string; version: number }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await changeTransferStatus(actor, input)
    revalidatePath(`/logistics/transfers/${input.stockTransferId}`)
    revalidatePath('/logistics/transfers')
    revalidatePath('/logistics')
    return { ok: true, data: res }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

/**
 * Receiving posts stock. It has its own action (rather than being a target of
 * changeTransferStatusAction) for the same reason it has its own service
 * function: the status flip and the balance movement are one indivisible
 * operation and must not be reachable separately.
 */
export async function receiveStockTransferAction(
  input: ReceiveStockTransferInput,
): Promise<ActionResult<{ status: string; version: number }>> {
  try {
    const actor = await requireAal2Actor()
    const res = await receiveStockTransfer(actor, input)
    revalidatePath(`/logistics/transfers/${input.stockTransferId}`)
    revalidatePath('/logistics/transfers')
    revalidatePath('/logistics/stock')
    revalidatePath('/logistics')
    return { ok: true, data: { status: res.status, version: res.version } }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}

type LoadMoreResult = { items: StockTransferListItem[]; nextCursor: string | null } | { error: string }

/** Server action behind StockTransferTable's "Load more" — filters + cursor travel together. */
export async function loadMoreStockTransfersAction(
  filter: StockTransferFilter,
): Promise<LoadMoreResult> {
  try {
    const actor = await requireAal2Actor()
    return await listStockTransfers(actor, filter)
  } catch (err) {
    if (err instanceof MfaRequiredError) {
      return { error: 'Two-factor authentication required — reload the page to finish signing in.' }
    }
    if (err instanceof PermissionError) {
      return { error: "You don't have permission to view these transfers." }
    }
    console.error(JSON.stringify({ level: 'error', msg: 'loadMoreStockTransfers failed', err: String(err) }))
    return { error: 'Something went wrong loading more transfers. Try again.' }
  }
}
