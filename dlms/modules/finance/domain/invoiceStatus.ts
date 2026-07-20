/**
 * Pure decision logic for the basic invoice status flow (finance module, basic
 * portions — NOT the spec §6.3 full draft→pending_approval→final→paid/void
 * lifecycle, which needs the threshold-approval engine this build doesn't
 * include). No I/O — mirrors modules/manufacturing/domain/deviceStatus.ts, but
 * the graph here is a small static map rather than a DB-driven table: four
 * states are simple enough not to need admin-editable vocabulary rows.
 *
 * Fail-closed by construction: ALLOWED_TRANSITIONS enumerates every legal edge;
 * anything not listed (including no-ops and backward moves) is forbidden.
 */
export const INVOICE_STATUSES = ['draft', 'issued', 'paid', 'void'] as const
export type InvoiceStatus = (typeof INVOICE_STATUSES)[number]

const ALLOWED_TRANSITIONS: Record<InvoiceStatus, readonly InvoiceStatus[]> = {
  draft: ['issued', 'void'],
  issued: ['paid', 'void'],
  paid: [],
  void: [],
}

export type InvoiceStatusChangeErrorCode = 'transition_forbidden'

export type InvoiceStatusChangeDecision =
  | { ok: false; error: InvoiceStatusChangeErrorCode }
  | { ok: true }

export function evaluateInvoiceStatusChange(
  from: InvoiceStatus, to: InvoiceStatus,
): InvoiceStatusChangeDecision {
  return ALLOWED_TRANSITIONS[from].includes(to)
    ? { ok: true }
    : { ok: false, error: 'transition_forbidden' }
}

/** The edges out of `from`, for the status-change UI (empty for draft/paid... paid/void terminal). */
export function allowedInvoiceTransitions(from: InvoiceStatus): readonly InvoiceStatus[] {
  return ALLOWED_TRANSITIONS[from]
}

export class InvalidInvoiceStatusChangeError extends Error {
  readonly code: InvoiceStatusChangeErrorCode
  constructor(code: InvoiceStatusChangeErrorCode, message: string) {
    super(message)
    this.name = 'InvalidInvoiceStatusChangeError'
    this.code = code
  }
}

export function messageForInvoiceStatusChangeError(
  code: InvoiceStatusChangeErrorCode, from: InvoiceStatus, to: InvoiceStatus,
): string {
  return `Cannot move an invoice from "${from}" to "${to}".`
}
