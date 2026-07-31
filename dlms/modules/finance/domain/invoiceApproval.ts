import {
  snapshotsAgree, describeSnapshotDrift, type ApprovalStatus,
} from '@/modules/shared/approvals/domain/approvalDecision'

/**
 * Finance's half of the approvals engine (spec BR-4): an invoice at or above
 * `app_setting.finance_approval_threshold_sgd` may not move draft → issued
 * without an approved, non-drifted approval.
 *
 * Pure — no I/O, no clock. The service loads the invoice, reads the threshold and
 * fetches the approval; everything that DECIDES lives here, the way
 * invoiceStatus.ts and approvalDecision.ts already split it.
 *
 * WHAT THE THRESHOLD COMPARISON IS NOT DOING HERE. `requiresApproval` arrives as a
 * boolean the SERVICE computed, in SQL, as `total_sgd >= threshold::numeric`.
 * Postgres numeric owns the money comparison for the same reason createInvoice
 * computes the totals in SQL: a JS float comparison of a numeric(12,2) against an
 * admin-set knob is a rounding bug waiting for the one invoice that sits on the
 * boundary. This module never sees a number, only the answer and the threshold's
 * text (for the message).
 */

export const INVOICE_APPROVAL_ENTITY_TYPE = 'sales_invoice'
export const INVOICE_APPROVAL_KIND = 'invoice'

/**
 * WHAT AN APPROVER IS ACTUALLY AGREEING TO, and why it is exactly these five fields.
 *
 * The migration's header is blunt about the stakes: "an approval authorises a
 * specific STATE, not an entity id", and a snapshot of only the id would make the
 * re-check pass vacuously while wearing the column's name. So the snapshot has to
 * hold every value a reviewer weighed, and nothing whose movement is not a change
 * of what they agreed to.
 *
 *   totalSgd  — THE amount under approval; the whole reason a threshold exists.
 *               Carried as the DRIVER'S OWN STRING, digit for digit. node-postgres
 *               returns numeric as text to avoid float truncation, and both sides
 *               of the re-check read the same numeric(12,2) column through the same
 *               query, so the stored "12000.00" and the re-read "12000.00" compare
 *               as equal TEXT. Number()-ing it here would be the one transformation
 *               that could lose a digit numeric holds exactly.
 *   currency  — an amount without its unit authorises nothing. CHECKed to 'SGD'
 *               today, which is exactly why it is cheap to carry and why the day
 *               that CHECK is relaxed the old approvals do not silently apply.
 *   buyerId   — WHO is billed, by identity rather than by display text.
 *   buyerName — and who they were CALLED when the approver read the request. Both,
 *               deliberately: the id is what the invoice points at, the name is what
 *               a human actually reviewed, and a buyer renamed between approval and
 *               issue is a cheap re-request but an expensive silent surprise. Fail
 *               closed — the same posture evaluateDecision takes.
 *   invoiceNo — the human reference. It is also what approvalService derives
 *               `ApprovalRecord.label` from and what the queued task is titled with,
 *               so leaving it out would put "sales invoice 3f2a…" in an approver's
 *               queue.
 *
 * LINES ARE DELIBERATELY ABSENT. This build has no line-edit path at all (see
 * updateInvoice's UPDATE_COLUMNS: "lines are deliberately absent"), so the only
 * thing that can move an invoice's money after creation is `tax_sgd`, and that
 * moves `total_sgd` with it. Carrying every line would inflate the snapshot, the
 * drift message and the jsonb column to re-detect exactly what the total already
 * detects. The day a line-edit path lands, add a line digest here — the re-check is
 * the thing that has to change, not the storage.
 */
export type InvoiceApprovalSnapshot = {
  invoiceNo: string
  buyerId: string
  buyerName: string
  currency: string
  totalSgd: string
}

export type InvoiceApprovalFacts = {
  invoiceNo: string
  buyerId: string
  buyerName: string
  currency: string
  totalSgd: string
}

/**
 * ONE builder, used to store the snapshot AND to build the projection it is
 * re-checked against. Two builders that agree today are two builders that report
 * "added"/"removed" drift on every approval the morning one of them gains a field.
 */
export function buildInvoiceApprovalSnapshot(facts: InvoiceApprovalFacts): InvoiceApprovalSnapshot {
  return {
    invoiceNo: facts.invoiceNo,
    buyerId: facts.buyerId,
    buyerName: facts.buyerName,
    currency: facts.currency,
    totalSgd: facts.totalSgd,
  }
}

export const INVOICE_APPROVAL_ERROR_CODES = [
  'approval_missing', 'approval_pending', 'approval_rejected', 'approval_drifted',
  'below_threshold', 'not_draft',
] as const
export type InvoiceApprovalErrorCode = (typeof INVOICE_APPROVAL_ERROR_CODES)[number]

export class InvoiceApprovalError extends Error {
  readonly code: InvoiceApprovalErrorCode
  constructor(code: InvoiceApprovalErrorCode, message: string) {
    super(message)
    this.name = 'InvoiceApprovalError'
    this.code = code
  }
}

/** The two refusals that belong to REQUESTING rather than to issuing. */
export function messageForInvoiceApprovalError(
  code: 'below_threshold' | 'not_draft', thresholdSgd: string,
): string {
  return code === 'below_threshold'
    ? `This invoice is below the S$${thresholdSgd} approval threshold, so it can be issued `
      + 'without one. Requesting an approval nobody needs would put a decision in someone’s '
      + 'queue that changes nothing.'
    : 'Only a draft invoice can be sent for approval — the approval gates the move from draft '
      + 'to issued, and this invoice has already left draft.'
}

export type InvoiceIssueDecision =
  | { ok: true }
  | { ok: false; code: InvoiceApprovalErrorCode; message: string }

/** Just enough of an ApprovalRecord to decide; keeps this module free of the service. */
export type InvoiceApprovalFactsForIssue = {
  status: ApprovalStatus
  snapshot: unknown
  decisionNote: string | null
}

/**
 * May this invoice move draft → issued?
 *
 * The order is the answer:
 *
 *   1. BELOW THE THRESHOLD, nothing applies. Not "approve it anyway", not "check the
 *      snapshot if one happens to exist" — the gate is simply not this invoice's
 *      rule, so a stale approval left over from a higher total can never block it.
 *   2. NO REQUEST, then a PENDING one, then a REJECTED one, each with a different
 *      thing for the user to do next (request / wait / fix and re-request). One
 *      "not approved" message would be true and useless in all three.
 *   3. DRIFT LAST, and only for an approval that is actually `approved`, because
 *      the snapshot question only means something once someone has agreed to it.
 *      This is the check that makes the engine real rather than decorative: without
 *      it, "invoice X is approved" survives someone editing invoice X's total, and
 *      the second pair of eyes agreed to numbers nobody is issuing.
 *
 * The refusal NAMES what moved (describeSnapshotDrift: "totalSgd: 12000.00 →
 * 18500.00"), because "this invoice changed" is a dead end while the field and both
 * values tell the requester precisely what to put back or re-request at.
 */
export function evaluateInvoiceIssue(facts: {
  requiresApproval: boolean
  thresholdSgd: string
  current: InvoiceApprovalSnapshot
  approval: InvoiceApprovalFactsForIssue | null
}): InvoiceIssueDecision {
  if (!facts.requiresApproval) return { ok: true }

  const { approval } = facts
  if (!approval) {
    return {
      ok: false,
      code: 'approval_missing',
      message: `This invoice is at or above the S$${facts.thresholdSgd} approval threshold, so it `
        + 'needs a second pair of eyes before it can be issued. Request approval first.',
    }
  }

  if (approval.status === 'pending') {
    return {
      ok: false,
      code: 'approval_pending',
      message: 'This invoice is waiting on an approval decision. It can be issued as soon as '
        + 'someone approves the request — and nobody may decide their own.',
    }
  }

  if (approval.status === 'rejected') {
    const note = approval.decisionNote?.trim()
    return {
      ok: false,
      code: 'approval_rejected',
      message: `The approval request for this invoice was rejected${note ? `: ${note}` : ''}. `
        + 'A rejected request is never reopened — change what was asked for and request approval '
        + 'again.',
    }
  }

  const drift = describeSnapshotDrift(approval.snapshot, facts.current)
  if (drift.length > 0 || !snapshotsAgree(approval.snapshot, facts.current)) {
    return {
      ok: false,
      code: 'approval_drifted',
      message: 'This invoice changed after it was approved, so issuing it now would ride an '
        + `approval nobody granted: ${drift.join('; ')}. Request a fresh approval for the current `
        + 'numbers.',
    }
  }

  return { ok: true }
}
