import {
  snapshotsAgree, describeSnapshotDrift, type ApprovalStatus,
} from '@/modules/shared/approvals/domain/approvalDecision'

/**
 * The rule every approval CONSUMER enforces immediately before it acts, factored
 * out of the one Finance already ships (`evaluateInvoiceIssue`).
 *
 * Pure — no I/O, no clock. The service loads the record, projects it, and fetches
 * the governing approval; everything that DECIDES lives here, the same split
 * approvalDecision.ts and repairStatus.ts already use.
 *
 * WHY THIS IS SHARED AND evaluateInvoiceIssue IS NOT (yet). Finance's version
 * carries one extra fact — the THRESHOLD, which decides whether the gate applies
 * at all and which appears in its messages. ECO approval and repair sign-off have
 * no threshold, so their gate is Finance's minus that clause. Rather than copy the
 * missing/pending/rejected/drifted ladder into two more modules — four chances for
 * one of them to forget the drift check, which is the check that makes the engine
 * real — the ladder lives here once. Finance is deliberately left alone: it is
 * shipped, reviewed and correct, and folding it in is a refactor of a working gate
 * for tidiness, which is exactly the trade this slice exists to avoid making.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE POSTURE THAT MATTERS: "REQUESTED ⇒ BINDING".
 *
 * `requiredWithoutRequest` is false for both consumers this slice migrates, and
 * that is a deliberate scope boundary rather than a weak gate.
 *
 * ECO approval and repair sign-off WORK TODAY, governed by their own permissions
 * (`approve_requests`, `sign_off_repairs`). Nothing in the schema says WHEN such a
 * record additionally needs a second pair of eyes — Finance has a threshold knob;
 * these have no equivalent. Making an approval unconditionally mandatory would not
 * be a refactor, it would be a new policy invented here, and it would stop every
 * ECO and every repair in the product until someone raised a request for it.
 *
 * So the rule is: an approval, ONCE REQUESTED, binds the action it was requested
 * for. Pending blocks, rejected blocks, and approved-then-edited blocks while
 * naming what moved. Where no request exists the record's own permission gate
 * governs exactly as it does today — no behaviour difference, no new capability,
 * which is precisely what the deferral asked for.
 *
 * The flag is a real parameter rather than a hardcoded `false` because the day a
 * policy knob lands (an `app_setting` saying ECOs over some scope need approval,
 * say), the consumer passes `true` and every refusal below is already written.
 * ─────────────────────────────────────────────────────────────────────────────
 */

export const APPROVAL_GATE_ERROR_CODES = [
  'approval_missing', 'approval_pending', 'approval_rejected', 'approval_drifted',
] as const
export type ApprovalGateErrorCode = (typeof APPROVAL_GATE_ERROR_CODES)[number]

export class ApprovalGateError extends Error {
  readonly code: ApprovalGateErrorCode
  constructor(code: ApprovalGateErrorCode, message: string) {
    super(message)
    this.name = 'ApprovalGateError'
    this.code = code
  }
}

/** Just enough of an ApprovalRecord to decide; keeps this module free of the service. */
export type GateApprovalFacts = {
  status: ApprovalStatus | string
  snapshot: unknown
  decisionNote: string | null
}

export type ApprovalGateFacts = {
  /** Names the record in every message, e.g. "this ECO", "this repair". */
  subject: string
  /** The gated act, phrased as a past participle: "approved", "signed off". */
  action: string
  /** See the module header — false for both consumers this slice migrates. */
  requiredWithoutRequest: boolean
  /** The record as it stands NOW, built by the SAME builder that stored the snapshot. */
  current: Record<string, unknown>
  /** The governing approval, or null when none was ever requested. */
  approval: GateApprovalFacts | null
}

export type ApprovalGateDecision =
  | { ok: true }
  | { ok: false; code: ApprovalGateErrorCode; message: string }

/**
 * May this gated action proceed?
 *
 * The ORDER is the answer, and it mirrors evaluateInvoiceIssue's for the same
 * reasons:
 *
 *   1. NO REQUEST — permitted or refused by `requiredWithoutRequest` alone. A
 *      stale approval can never reach this branch, so nothing left over from an
 *      earlier state can block a record nobody asked to gate.
 *   2. PENDING, then REJECTED, each with a DIFFERENT next step for the reader
 *      (wait / fix and re-request). One "not approved" line would be true and
 *      useless in both.
 *   3. DRIFT LAST, and only once someone has actually agreed to something —
 *      the snapshot question is meaningless before that. This is the check that
 *      makes the engine real rather than decorative: without it, "this ECO is
 *      approved" survives someone editing the ECO, and the second pair of eyes
 *      agreed to a change nobody is making.
 *
 * `snapshotsAgree` is consulted ALONGSIDE `describeSnapshotDrift` rather than
 * inferred from it. The two are structurally equivalent by construction, and
 * asserting both here is what keeps that equivalence load-bearing: if a future
 * edit ever let the describer come back empty for a pair that does not agree,
 * this refuses rather than waving the action through unexplained.
 */
export function evaluateApprovalGate(facts: ApprovalGateFacts): ApprovalGateDecision {
  const { approval, subject, action } = facts

  if (!approval) {
    if (!facts.requiredWithoutRequest) return { ok: true }
    return {
      ok: false,
      code: 'approval_missing',
      message: `${capitalise(subject)} needs a second pair of eyes before it can be ${action}. `
        + 'Request approval first.',
    }
  }

  if (approval.status === 'pending') {
    return {
      ok: false,
      code: 'approval_pending',
      message: `${capitalise(subject)} is waiting on an approval decision, so it cannot be `
        + `${action} yet. It can be as soon as someone approves the request — and nobody may `
        + 'decide their own.',
    }
  }

  if (approval.status === 'rejected') {
    const note = approval.decisionNote?.trim()
    return {
      ok: false,
      code: 'approval_rejected',
      message: `The approval request for ${subject} was rejected${note ? `: ${note}` : ''}. `
        + 'A rejected request is never reopened — change what was asked for and request approval '
        + 'again.',
    }
  }

  // Anything outside the vocabulary is treated as NOT approved. Fail closed:
  // "unknown status, therefore proceed" is the one reading that could let an
  // undecided request through, and evaluateDecision takes the same posture.
  if (approval.status !== 'approved') {
    return {
      ok: false,
      code: 'approval_pending',
      message: `The approval request for ${subject} has not been approved, so it cannot be `
        + `${action}.`,
    }
  }

  const drift = describeSnapshotDrift(approval.snapshot, facts.current)
  if (drift.length > 0 || !snapshotsAgree(approval.snapshot, facts.current)) {
    return {
      ok: false,
      code: 'approval_drifted',
      message: `${capitalise(subject)} changed after it was approved, so ${action === 'approved'
        ? 'approving it now' : `having it ${action} now`} would ride an approval nobody granted: `
        + `${drift.join('; ')}. Request a fresh approval for the current state.`,
    }
  }

  return { ok: true }
}

/** "this ECO" → "This ECO". Leaves an already-capitalised or empty subject alone. */
function capitalise(text: string): string {
  return text ? `${text[0].toUpperCase()}${text.slice(1)}` : text
}
