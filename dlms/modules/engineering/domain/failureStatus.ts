import { canTransition, isTerminal, nextStates, type TransitionGraph } from './transition'

/**
 * Failure-investigation (FI / RCA) lifecycle — spec §6.3 `failure_investigation`.
 *
 * Pure decision logic, no I/O: the service loads the row's current status plus
 * the two facts the lifecycle asserts (the root-cause CLASSIFICATION and the
 * corrective action) and hands them here, exactly as
 * maintenance/domain/repairStatus.ts does.
 *
 * ── Why these six states ────────────────────────────────────────────────────
 * The record carries the 8D narrative compressed to what this business actually
 * writes down — description, containment, root cause, corrective action. The
 * status is therefore just "how far down that list have we got", and each state
 * that ASSERTS a fact must have that fact on record before it can be entered:
 *
 *   open                  a failure was reported; nobody has picked it up
 *   investigating         someone owns it; containment/analysis under way
 *   root_cause_identified requires a CLASSIFIED cause (root_cause_id)
 *   corrective_action     requires a non-empty corrective_action
 *   closed                requires BOTH still on record (terminal)
 *   cancelled             not a real failure / duplicate (terminal)
 *
 * ── Why the CLASSIFICATION and not the prose ────────────────────────────────
 * The precondition is `root_cause_id IS NOT NULL` (a row in the admin-editable
 * root_cause_option vocabulary), NOT the free-text root_cause field. Spec §8.5
 * wants a "by root cause" dashboard, and a dashboard built on prose is a
 * dashboard that reports nothing. Gating the lifecycle on the structured value
 * is what makes every closed investigation countable. The prose stays as
 * optional elaboration.
 *
 * This module NEVER branches on a particular cause code — only on whether one
 * is set. Admin-added codes therefore just work, and the vocabulary drift this
 * project has already been bitten by (CLAUDE.md) cannot reach the lifecycle.
 *
 * ── Why the edges are what they are ─────────────────────────────────────────
 * • No jump straight to closed. Closing an investigation with no root cause is
 *   how RCA data becomes worthless; the graph makes it unreachable rather than
 *   relying on a reviewer to notice.
 * • Two back-edges, both from 8D: root_cause_identified → investigating (the
 *   cause didn't hold up) and corrective_action → investigating (verification
 *   failed — the fix did not stop the failure). These mirror the repair graph's
 *   testing → in_repair edge.
 * • Cancelling is only legal from open/investigating. Once a root cause is on
 *   record the investigation produced knowledge; it gets closed, not erased.
 *   Cancelling always requires a note, same rule as cancelling a repair.
 *
 * Fail-closed by construction: the graph is consulted through transition.ts,
 * whose canTransition returns false for any status absent from the map, so an
 * unknown/corrupt status has no legal move out of it at all.
 */
export const FAILURE_STATUSES = [
  'open', 'investigating', 'root_cause_identified', 'corrective_action', 'closed', 'cancelled',
] as const
export type FailureStatus = (typeof FAILURE_STATUSES)[number]

export const FAILURE_INITIAL_STATUS: FailureStatus = 'open'

/**
 * Human labels. Unlike ECR/ECO/firmware — whose codes are all single words, so
 * components/engineering/EngStatusBadge can just capitalize them — two of these
 * codes are underscored, and capitalize-only would render
 * "Root_cause_identified". Anything displaying an FI status must come through
 * here.
 */
export const FAILURE_STATUS_LABELS: Record<FailureStatus, string> = {
  open: 'Open',
  investigating: 'Investigating',
  root_cause_identified: 'Root Cause Identified',
  corrective_action: 'Corrective Action',
  closed: 'Closed',
  cancelled: 'Cancelled',
}

/** Label for display; falls back to the raw code rather than throwing. */
export function failureStatusLabel(status: string): string {
  return FAILURE_STATUS_LABELS[status as FailureStatus] ?? status
}

export const FAILURE_TRANSITIONS: TransitionGraph = {
  open: ['investigating', 'cancelled'],
  investigating: ['root_cause_identified', 'cancelled'],
  root_cause_identified: ['corrective_action', 'investigating'],
  corrective_action: ['closed', 'investigating'],
  closed: [],
  cancelled: [],
}

/** Fail-closed: an unknown source or target is never permitted. */
export function isValidFailureTransition(from: string, to: string): boolean {
  return canTransition(FAILURE_TRANSITIONS, from, to)
}

/** Legal onward statuses; [] for a terminal OR unknown state. */
export function nextFailureStatuses(from: string): FailureStatus[] {
  return nextStates(FAILURE_TRANSITIONS, from) as FailureStatus[]
}

/** A KNOWN state with no outgoing edges. Unknown states are not terminal. */
export function isTerminalFailureStatus(status: string): boolean {
  return isTerminal(FAILURE_TRANSITIONS, status)
}

// ── Transition evaluation (edge + preconditions) ────────────────────────────
export type FailureTransitionErrorCode =
  | 'transition_forbidden'
  | 'root_cause_required'
  | 'corrective_action_required'
  | 'note_required'

export type FailureTransitionDecision =
  | { ok: true }
  | { ok: false; error: FailureTransitionErrorCode }

export type FailureTransitionFacts = {
  /** root_cause_option id — the CLASSIFICATION. Prose is not a substitute. */
  rootCauseId: string | null
  correctiveAction: string | null
  /** The status-change note; required only when cancelling. */
  note: string | null
}

const present = (v: string | null | undefined) => !!v && v.trim().length > 0

/**
 * Decides one FI move: the edge first, then the precondition the TARGET state
 * asserts. Edge-before-precondition matters — an illegal move must report
 * "you cannot go there", not "you're missing a root cause", or the operator
 * fills in a field and is refused anyway.
 *
 * `closed` re-checks both facts rather than trusting that the earlier states
 * verified them: both stay editable while the investigation is live, so either
 * can be cleared after the state that required it was reached.
 */
export function evaluateFailureTransition(
  from: string, to: string, facts: FailureTransitionFacts,
): FailureTransitionDecision {
  if (!isValidFailureTransition(from, to)) return { ok: false, error: 'transition_forbidden' }

  if (to === 'root_cause_identified' && !present(facts.rootCauseId)) {
    return { ok: false, error: 'root_cause_required' }
  }
  if (to === 'corrective_action' && !present(facts.correctiveAction)) {
    return { ok: false, error: 'corrective_action_required' }
  }
  if (to === 'closed') {
    if (!present(facts.rootCauseId)) return { ok: false, error: 'root_cause_required' }
    if (!present(facts.correctiveAction)) return { ok: false, error: 'corrective_action_required' }
  }
  if (to === 'cancelled' && !present(facts.note)) return { ok: false, error: 'note_required' }

  return { ok: true }
}

export function messageForFailureTransitionError(
  code: FailureTransitionErrorCode, fromLabel: string, toLabel: string,
): string {
  switch (code) {
    case 'transition_forbidden':
      return `Cannot move a failure investigation from "${fromLabel}" to "${toLabel}".`
    case 'root_cause_required':
      return 'Classify the root cause before moving the investigation forward.'
    case 'corrective_action_required':
      return 'Record a corrective action before moving the investigation forward.'
    case 'note_required':
      return 'Cancelling an investigation requires a reason.'
  }
}

/**
 * Thrown by the write service when a requested FI move is refused. Carries the
 * structured code so the action layer maps it without string-matching.
 */
export class InvalidFailureTransitionError extends Error {
  readonly code: FailureTransitionErrorCode
  constructor(code: FailureTransitionErrorCode, message: string) {
    super(message)
    this.name = 'InvalidFailureTransitionError'
    this.code = code
  }
}
