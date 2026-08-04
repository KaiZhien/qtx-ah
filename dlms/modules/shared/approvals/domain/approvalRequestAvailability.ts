import type { ApprovalStatus } from './approvalDecision'

/**
 * MAY A SCREEN OFFER "REQUEST APPROVAL" RIGHT NOW, AND IF NOT, WHY.
 *
 * Pure — no I/O, no clock, no actor. The permission half of the question lives
 * with the caller (an actor without the requester's own `edit_records` gets no
 * panel at all, exactly as InvoiceApprovalPanel hides on `canManage`); this
 * decides the half that depends on the RECORD's state.
 *
 * WHY THIS IS A FUNCTION AND NOT THREE LINES IN EACH PANEL. The house rule is
 * "do not offer a control the write will refuse" — the same rule that made the
 * New Repair form resolve `canMoveToUnderRepair` from `status_transition` rather
 * than hardcoding it. That rule only holds while the offer and the write agree,
 * and a boolean expression copied into three client components is precisely how
 * they stop agreeing. Finance had the only copy; ECO and repair would have been
 * the second and third.
 *
 * THE ORDER OF THE CHECKS IS THE SERVICE'S ORDER, DELIBERATELY.
 * `requestEcoApproval` / `requestRepairSignOffApproval` both run their
 * `*Requestable` status decision and throw BEFORE `requestApprovalInTx` can raise
 * `ApprovalAlreadyPendingError`. So the status reason is reported first here too:
 * a panel that named the pending request while the write would have complained
 * about the status sends the user to fix the wrong thing, which is worse than
 * offering no explanation at all.
 *
 * NOTE WHAT THIS DOES *NOT* DO: it never returns `canRequest: false` because
 * approval is somehow mandatory. Approval is not mandatory for an ECO or a
 * repair, and nothing here makes it so. The posture is "requested ⇒ binding" —
 * this function is only about whether a NEW request may be raised.
 */

export type ApprovalRequestAvailability =
  /** `label` is the button's text; "again" reads differently after a rejection. */
  | { canRequest: true; label: string }
  | { canRequest: false; reason: string }

export type ApprovalRequestAvailabilityInput = {
  /** The record's own status decision — `ecoApprovalRequestable` et al. */
  requestable: boolean
  /** The sentence that decision built, verbatim. */
  requestableReason: string | null
  /** The governing approval's status, or null when none has ever been raised. */
  approvalStatus: ApprovalStatus | null
  /** True only when an APPROVED snapshot no longer describes the record. */
  drifted: boolean
}

/**
 * The line used when a service reports `requestable: false` with no reason. That
 * combination is a service bug rather than a state a user can reach, but a
 * disabled button explaining nothing is a worse way to meet it than a dull
 * sentence.
 */
const UNEXPLAINED =
  'This record cannot be sent for approval in its current state.'

export function approvalRequestAvailability(
  input: ApprovalRequestAvailabilityInput,
): ApprovalRequestAvailability {
  const { requestable, requestableReason, approvalStatus, drifted } = input

  // (1) The record's status. First, because the service checks it first.
  if (!requestable) {
    return { canRequest: false, reason: requestableReason?.trim() || UNEXPLAINED }
  }

  // (2) A live request. `approval_one_pending_idx` is a partial unique index on
  //     status='pending', so a second request is a 23505 — the button must not
  //     offer what the database is about to refuse.
  if (approvalStatus === 'pending') {
    return {
      canRequest: false,
      reason: 'A request is already pending. Nobody may decide their own request, so this is '
        + 'waiting on someone else — wait for the decision, or withdraw it, before raising another.',
    }
  }

  // (3) A live approval that still describes the record. The database WOULD
  //     accept a second request here (only pending rows are unique), which is
  //     exactly why the refusal has to be made deliberately: a duplicate would
  //     land in a real person's queue asking them to agree to what they have
  //     already agreed to.
  if (approvalStatus === 'approved' && !drifted) {
    return {
      canRequest: false,
      reason: 'This is already approved, and the approval still describes it. There is nothing '
        + 'new to decide.',
    }
  }

  // (4) Everything that remains is a genuine re-request: never asked, rejected,
  //     or approved-then-changed. The drifted case is the one that matters most —
  //     the record is blocked and a fresh request is the ONLY way forward, so the
  //     control has to be live here even though an approval exists.
  return {
    canRequest: true,
    label: approvalStatus === null ? 'Request approval' : 'Request approval again',
  }
}
