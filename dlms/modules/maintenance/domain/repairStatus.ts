/**
 * Repair lifecycle (spec §5.3 — the 6-state repair workflow) as pure decision
 * logic. No I/O: the service loads the repair's current status + testing notes
 * and hands them here, exactly as componentInstallation / deviceStatus do.
 *
 * Unlike the device-status graph (an admin-editable status_transition TABLE),
 * the repair graph is a hardcoded constant — like task statuses, these are
 * platform mechanics, not business vocabulary an admin should be able to invent.
 * The `status` column merely holds the current state; this module owns which
 * moves are legal.
 *
 * The graph deliberately EXCLUDES the awaiting_sign_off → closed edge: closing a
 * repair from awaiting_sign_off is the *sign-off* action (permission 9), gated on
 * a distinct precondition (evaluateSignOff below) and never reachable through the
 * ordinary changeRepairStatus path. So allowedNextRepairStatuses('awaiting_sign_off')
 * is [] — the generic status control offers nothing there; the Sign-off control
 * takes over. in_diagnosis → closed ("no fault found") IS ordinary, and stays.
 */
export const REPAIR_STATUSES = [
  'reported', 'in_diagnosis', 'in_repair', 'testing', 'awaiting_sign_off', 'closed', 'cancelled',
] as const
export type RepairStatus = (typeof REPAIR_STATUSES)[number]

/** Human labels for the fixed vocabulary (no DB round-trip; statuses are constants). */
export const REPAIR_STATUS_LABELS: Record<RepairStatus, string> = {
  reported: 'Reported',
  in_diagnosis: 'In Diagnosis',
  in_repair: 'In Repair',
  testing: 'Testing',
  awaiting_sign_off: 'Awaiting Sign-off',
  closed: 'Closed',
  cancelled: 'Cancelled',
}

export function repairStatusLabel(status: string): string {
  return REPAIR_STATUS_LABELS[status as RepairStatus] ?? status
}

// The spec §5.3 diagram, minus the gated sign-off edge (see module header):
//   reported          → in_diagnosis (technician assigned) | cancelled
//   in_diagnosis      → in_repair (diagnosis recorded) | closed (no fault found) | cancelled
//   in_repair         → testing (corrective action done)
//   testing           → in_repair (failed test) | awaiting_sign_off (test passed)
//   awaiting_sign_off → (sign-off only — evaluateSignOff)
//   closed / cancelled → terminal
const TRANSITIONS: Record<RepairStatus, readonly RepairStatus[]> = {
  reported: ['in_diagnosis', 'cancelled'],
  in_diagnosis: ['in_repair', 'closed', 'cancelled'],
  in_repair: ['testing'],
  testing: ['in_repair', 'awaiting_sign_off'],
  awaiting_sign_off: [],
  closed: [],
  cancelled: [],
}

/** Fails closed: an unknown source or target is never permitted. */
export function isValidRepairTransition(from: RepairStatus, to: RepairStatus): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false
}

/** The ordinary next moves out of `from`, for the generic status control. */
export function allowedNextRepairStatuses(from: RepairStatus): RepairStatus[] {
  return [...(TRANSITIONS[from] ?? [])]
}

// ── Ordinary transition evaluation (changeRepairStatus) ─────────────────────
export type RepairTransitionErrorCode = 'transition_forbidden' | 'note_required'

export type RepairTransitionDecision =
  | { ok: true }
  | { ok: false; error: RepairTransitionErrorCode }

/**
 * Decides one ordinary repair move. Cancelling requires a note (a requires_reason
 * style rule, mirroring status_transition.requires_reason) so the audit trail
 * explains why work stopped; every other legal edge needs nothing extra.
 */
export function evaluateRepairTransition(
  from: RepairStatus, to: RepairStatus, input: { note: string | null },
): RepairTransitionDecision {
  if (!isValidRepairTransition(from, to)) return { ok: false, error: 'transition_forbidden' }
  if (to === 'cancelled' && !input.note?.trim()) return { ok: false, error: 'note_required' }
  return { ok: true }
}

export function messageForRepairTransitionError(
  code: RepairTransitionErrorCode, fromLabel: string, toLabel: string,
): string {
  return code === 'transition_forbidden'
    ? `Cannot move a repair from "${fromLabel}" to "${toLabel}".`
    : `Cancelling a repair requires a reason.`
}

export class InvalidRepairTransitionError extends Error {
  readonly code: RepairTransitionErrorCode
  constructor(code: RepairTransitionErrorCode, message: string) {
    super(message)
    this.name = 'InvalidRepairTransitionError'
    this.code = code
  }
}

// ── Sign-off precondition (signOffRepair) ───────────────────────────────────
export type SignOffErrorCode = 'not_awaiting_sign_off' | 'testing_notes_required'

export type SignOffDecision = { ok: true } | { ok: false; error: SignOffErrorCode }

/**
 * The sign-off precondition (spec §5.3): a repair may be signed off ONLY from
 * awaiting_sign_off AND only when testing notes are present. Sign-off then closes
 * the repair and returns the device to service — so both facts must hold before
 * any of that runs.
 */
export function evaluateSignOff(
  facts: { status: RepairStatus; testingNotes: string | null },
): SignOffDecision {
  if (facts.status !== 'awaiting_sign_off') return { ok: false, error: 'not_awaiting_sign_off' }
  if (!facts.testingNotes?.trim()) return { ok: false, error: 'testing_notes_required' }
  return { ok: true }
}

export function messageForSignOffError(code: SignOffErrorCode): string {
  return code === 'not_awaiting_sign_off'
    ? 'A repair can only be signed off while it is awaiting sign-off.'
    : 'Sign-off requires testing notes to be recorded first.'
}

export class RepairSignOffError extends Error {
  readonly code: SignOffErrorCode
  constructor(code: SignOffErrorCode, message: string) {
    super(message)
    this.name = 'RepairSignOffError'
    this.code = code
  }
}
