/**
 * Pure decision logic for a delivery-order status change (Basic Logistics
 * scope). No I/O. Mirrors modules/manufacturing/domain/deviceStatus.ts's
 * shape, but the graph itself is fixed in code rather than an admin-editable
 * status_transition table — Basic scope's DO flow is five states with no
 * vocabulary management need, unlike the eleven-status device lifecycle.
 *
 * Fail-closed: any (from, to) pair not present in ALLOWED_TRANSITIONS is
 * forbidden, including an unrecognized `from` (defensive — the DB CHECK
 * constraint already limits delivery_order.status to the five known values,
 * but this function does not trust that from the caller).
 */
export const DO_STATUSES = ['draft', 'prepared', 'dispatched', 'delivered', 'cancelled'] as const
export type DoStatus = (typeof DO_STATUSES)[number]

export type DoStatusChangeErrorCode = 'transition_forbidden'

export type DoStatusChangeDecision =
  | { ok: false; error: DoStatusChangeErrorCode }
  | { ok: true }

// draft -> prepared -> dispatched -> delivered (the happy path); draft and
// prepared can additionally be cancelled. delivered and cancelled are sinks.
const ALLOWED_TRANSITIONS: Record<DoStatus, readonly DoStatus[]> = {
  draft: ['prepared', 'cancelled'],
  prepared: ['dispatched', 'cancelled'],
  dispatched: ['delivered'],
  delivered: [],
  cancelled: [],
}

/** The edges out of `from`, for the status-change UI. [] for a sink status. */
export function listAllowedDoTransitions(from: DoStatus): DoStatus[] {
  return [...(ALLOWED_TRANSITIONS[from] ?? [])]
}

export function evaluateDoStatusChange(from: DoStatus, to: DoStatus): DoStatusChangeDecision {
  const allowed = ALLOWED_TRANSITIONS[from]
  if (!allowed || !allowed.includes(to)) return { ok: false, error: 'transition_forbidden' }
  return { ok: true }
}

export class InvalidDoStatusChangeError extends Error {
  readonly code: DoStatusChangeErrorCode
  constructor(code: DoStatusChangeErrorCode, message: string) {
    super(message)
    this.name = 'InvalidDoStatusChangeError'
    this.code = code
  }
}

export function messageForDoStatusChangeError(from: string, to: string): string {
  return `Cannot move a delivery order from "${from}" to "${to}".`
}
