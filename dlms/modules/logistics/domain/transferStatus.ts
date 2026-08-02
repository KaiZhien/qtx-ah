/**
 * Pure decision logic for a stock-transfer status change. No I/O.
 *
 * Same shape and same fail-closed contract as
 * modules/logistics/domain/doStatus.ts: the graph is fixed in code rather than
 * an admin-editable status_transition table, because a transfer's lifecycle is
 * an accounting primitive — an admin who could add an edge into `received`, or
 * an edge OUT of it, would silently break the posting logic's idempotency (see
 * the note on `received` below), which is a very different risk profile from
 * the admin-editable device-status vocabulary.
 *
 * Fail-closed: any (from, to) pair not present in ALLOWED_TRANSITIONS is
 * forbidden, including an unrecognized `from` — this function does not trust
 * the caller even though the DB CHECK already limits the column.
 */
export const STOCK_TRANSFER_STATUSES = ['draft', 'dispatched', 'received', 'cancelled'] as const
export type StockTransferStatus = (typeof STOCK_TRANSFER_STATUSES)[number]

export type TransferStatusChangeErrorCode = 'transition_forbidden'

export type TransferStatusChangeDecision =
  | { ok: false; error: TransferStatusChangeErrorCode }
  | { ok: true }

/**
 * draft -> dispatched -> received is the happy path. draft and dispatched can
 * both be cancelled; received and cancelled are sinks.
 *
 * ── Why `received` MUST stay a sink ──────────────────────────────────────────
 * Stock is posted exactly once, when a transfer is received. The absence of any
 * outgoing edge from `received` is what makes receiveStockTransfer idempotent:
 * a duplicate receive re-reads status='received' under the row lock, finds no
 * legal edge, and fails before touching stock_level. Adding an edge out of
 * `received` (an "un-receive", a re-open, even received -> cancelled) without
 * also writing a compensating reversal posting would let stock be double-moved.
 * This is not a stylistic constraint — it is the idempotency guarantee.
 *
 * Cancelling from `dispatched` is safe only because dispatch posts nothing;
 * all movement happens at receive. If posting ever moves to dispatch time, that
 * edge needs a reversal too.
 */
const ALLOWED_TRANSITIONS: Record<StockTransferStatus, readonly StockTransferStatus[]> = {
  draft: ['dispatched', 'cancelled'],
  dispatched: ['received', 'cancelled'],
  received: [],
  cancelled: [],
}

/** The edges out of `from`, for the status-change UI. [] for a sink status. */
export function listAllowedTransferTransitions(from: StockTransferStatus): StockTransferStatus[] {
  return [...(ALLOWED_TRANSITIONS[from] ?? [])]
}

export function evaluateTransferStatusChange(
  from: StockTransferStatus, to: StockTransferStatus,
): TransferStatusChangeDecision {
  const allowed = ALLOWED_TRANSITIONS[from]
  if (!allowed || !allowed.includes(to)) return { ok: false, error: 'transition_forbidden' }
  return { ok: true }
}

/**
 * Has this transfer already moved stock? True only for `received`.
 *
 * Used by the UI to hide the receive control and by the service as a readable
 * name for "already posted" — the authoritative guard is still the transition
 * evaluation above, taken under the row lock.
 */
export function isTransferPosted(status: StockTransferStatus): boolean {
  return status === 'received'
}

export class InvalidTransferStatusChangeError extends Error {
  readonly code: TransferStatusChangeErrorCode
  constructor(code: TransferStatusChangeErrorCode, message: string) {
    super(message)
    this.name = 'InvalidTransferStatusChangeError'
    this.code = code
  }
}

export function messageForTransferStatusChangeError(from: string, to: string): string {
  return `Cannot move a stock transfer from "${from}" to "${to}".`
}
