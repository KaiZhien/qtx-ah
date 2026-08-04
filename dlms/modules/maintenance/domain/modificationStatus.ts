/**
 * Modification lifecycle (spec §6.3) as pure decision logic — the sibling of
 * repairStatus.ts, deliberately built to the same shape so the two read as one
 * pattern rather than two inventions. No I/O and no clock: the service loads the
 * modification's current status and hands it here.
 *
 * Like repair's (and unlike the device-status graph, which is an admin-editable
 * status_transition TABLE), this graph is a hardcoded constant. These are
 * platform mechanics, not business vocabulary an admin should be able to invent;
 * the `status` column and its CHECK in 20260801000000_platform_modifications.sql
 * only fence the value, and this module owns which moves are legal.
 *
 * WHY THESE FIVE STATES. The migration's header argues the set at length; the
 * short version is that spec §6.3 gives the record three actor stamps —
 * requested_by, approved_by, completed_by — plus a sign-off, so there is one
 * state per stamp (`requested`/`approved`/`completed`), one terminal for the
 * accepted result (`closed`), and one sink for everything that stops early
 * (`cancelled`). No `rejected` (a request that is not approved is `cancelled`,
 * with the note recording why) and no `in_progress` (nothing in §6.3
 * distinguishes approved-but-not-started — there is no column to stamp).
 *
 * The graph deliberately EXCLUDES the completed → closed edge: closing a
 * modification from completed is the *sign-off* action (permission
 * sign_off_repairs), gated on its own precondition (evaluateModificationSignOff
 * below) and never reachable through the ordinary changeModificationStatus path.
 * So allowedNextModificationStatuses('completed') is [] — the generic status
 * control offers nothing there and the Sign-off control takes over. That is
 * exactly repair's awaiting_sign_off rule; `completed` is this record's
 * awaiting_sign_off, named for the spec's completed_on/completed_by columns.
 */
export const MODIFICATION_STATUSES = [
  'requested', 'approved', 'completed', 'closed', 'cancelled',
] as const
export type ModificationStatus = (typeof MODIFICATION_STATUSES)[number]

/** Human labels for the fixed vocabulary (no DB round-trip; statuses are constants). */
export const MODIFICATION_STATUS_LABELS: Record<ModificationStatus, string> = {
  requested: 'Requested',
  approved: 'Approved',
  completed: 'Completed',
  closed: 'Closed',
  cancelled: 'Cancelled',
}

export function modificationStatusLabel(status: string): string {
  return MODIFICATION_STATUS_LABELS[status as ModificationStatus] ?? status
}

// The spec §6.3 lifecycle, minus the gated sign-off edge (see module header):
//   requested → approved (authorised) | cancelled
//   approved  → completed (work done) | cancelled
//   completed → (sign-off only — evaluateModificationSignOff)
//   closed / cancelled → terminal
// Cancelling from `completed` is absent on purpose: once the work has physically
// been done to a fielded device, "it never happened" is not a state the record
// may claim. Such a record is signed off or left at completed.
const TRANSITIONS: Record<ModificationStatus, readonly ModificationStatus[]> = {
  requested: ['approved', 'cancelled'],
  approved: ['completed', 'cancelled'],
  completed: [],
  closed: [],
  cancelled: [],
}

/** Fails closed: an unknown source or target is never permitted. */
export function isValidModificationTransition(
  from: ModificationStatus, to: ModificationStatus,
): boolean {
  return TRANSITIONS[from]?.includes(to) ?? false
}

/** The ordinary next moves out of `from`, for the generic status control. */
export function allowedNextModificationStatuses(from: ModificationStatus): ModificationStatus[] {
  return [...(TRANSITIONS[from] ?? [])]
}

/**
 * Is this modification finished — closed by sign-off, or abandoned?
 *
 * DELIBERATELY NOT "has no outgoing transitions". `completed` also has an empty
 * TRANSITIONS entry, because its only exit is the gated sign-off rather than an
 * ordinary edge, and a `completed` modification is very much still live: it is
 * waiting to be accepted and its detail fields are exactly what the signer is
 * about to read. Deriving terminality from the graph's shape would freeze the
 * record one step early, at the precise moment editing it matters most.
 *
 * WHAT THIS GATES. `updateModification` refuses to edit a terminal record, and
 * the detail page hides the edit form for one. Without that, a signed-off
 * modification could have its cost or its configuration text rewritten with NO
 * `modification_status_history` row to show it — the history only logs status
 * changes — which would make sign-off decorative: the whole point of a terminal
 * state is that what was accepted is what stays on the record. The sign-off
 * dialog promises the user exactly this ("cannot be reopened or edited
 * afterwards"), and a promise the server does not keep is worse than no promise.
 */
export function isTerminalModificationStatus(status: ModificationStatus): boolean {
  return status === 'closed' || status === 'cancelled'
}

// ── Ordinary transition evaluation (changeModificationStatus) ────────────────
export type ModificationTransitionErrorCode = 'transition_forbidden' | 'note_required'

export type ModificationTransitionDecision =
  | { ok: true }
  | { ok: false; error: ModificationTransitionErrorCode }

/**
 * Decides one ordinary modification move. Cancelling requires a note (repair's
 * requires_reason convention, mirroring status_transition.requires_reason) so the
 * audit trail explains why the change was abandoned — this is precisely where
 * the migration header's "the service requires a note on cancel ... which is
 * where 'why' is recorded" is honoured, and the note lands in
 * modification_status_history.note. `reason` and `description` on the record
 * itself mean different things (why the change was wanted / what is being done)
 * and are not a place to record an abandonment.
 */
export function evaluateModificationTransition(
  from: ModificationStatus, to: ModificationStatus, input: { note: string | null },
): ModificationTransitionDecision {
  if (!isValidModificationTransition(from, to)) return { ok: false, error: 'transition_forbidden' }
  if (to === 'cancelled' && !input.note?.trim()) return { ok: false, error: 'note_required' }
  return { ok: true }
}

export function messageForModificationTransitionError(
  code: ModificationTransitionErrorCode, fromLabel: string, toLabel: string,
): string {
  return code === 'transition_forbidden'
    ? `Cannot move a modification from "${fromLabel}" to "${toLabel}".`
    : `Cancelling a modification requires a reason.`
}

export class InvalidModificationTransitionError extends Error {
  readonly code: ModificationTransitionErrorCode
  constructor(code: ModificationTransitionErrorCode, message: string) {
    super(message)
    this.name = 'InvalidModificationTransitionError'
    this.code = code
  }
}

// ── Sign-off precondition (signOffModification) ─────────────────────────────
export type ModificationSignOffErrorCode = 'not_completed'

export type ModificationSignOffDecision =
  | { ok: true }
  | { ok: false; error: ModificationSignOffErrorCode }

/**
 * The sign-off precondition: a modification may be signed off ONLY from
 * `completed`. This is the single route to `closed` — the transition graph above
 * has no edge into it — so this function is the whole gate.
 *
 * ONE error code, not two, and that is not an oversight. Repair's evaluateSignOff
 * carries a second precondition (testing_notes must be recorded) because spec
 * §5.3 names a concrete artifact that must exist before a repair can be accepted.
 * §6.3 names no equivalent artifact for a modification: the facts a signer would
 * check — what was done, the prev/new configuration — are free text with no rule
 * attached, and inventing "description must be non-empty" here would be a rule
 * the specification does not have. The shape is deliberately identical to
 * repair's (discriminated decision, message function, typed error) so a real
 * precondition can be added later by extending the facts object, exactly as
 * Task 3 extends repair's — see the plan's §5.4 parts-replaced gate.
 */
export function evaluateModificationSignOff(
  facts: { status: ModificationStatus },
): ModificationSignOffDecision {
  if (facts.status !== 'completed') return { ok: false, error: 'not_completed' }
  return { ok: true }
}

// A Record rather than repair's ternary: with a one-member code union a ternary
// has an unreachable branch, while this stays exhaustive by construction — adding
// a code makes the compiler demand its message.
const SIGN_OFF_MESSAGES: Record<ModificationSignOffErrorCode, string> = {
  not_completed: 'A modification can only be signed off once the work is completed.',
}

export function messageForModificationSignOffError(code: ModificationSignOffErrorCode): string {
  return SIGN_OFF_MESSAGES[code]
}

export class ModificationSignOffError extends Error {
  readonly code: ModificationSignOffErrorCode
  constructor(code: ModificationSignOffErrorCode, message: string) {
    super(message)
    this.name = 'ModificationSignOffError'
    this.code = code
  }
}
