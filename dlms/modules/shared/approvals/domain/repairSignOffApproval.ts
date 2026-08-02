/**
 * Maintenance's half of the approvals engine: what a repair SIGN-OFF approval
 * authorises.
 *
 * Pure — no I/O, no clock. `repairService.signOffRepair` loads the repair under
 * its row lock, projects it with the builder below and hands the result to
 * approvalGate. Lives under shared/approvals for the reasons ecoApproval.ts's
 * header gives.
 *
 * WHAT THIS DOES **NOT** REPLACE, and must never be read as replacing: the
 * three-fact sign-off PRECONDITION in `repairStatus.evaluateSignOff` —
 * awaiting_sign_off, testing notes present, and (only when the repair CLAIMS
 * parts were replaced) at least one component_installation referencing it,
 * counted INSIDE the sign-off transaction under the repair's lock. That rule is
 * about whether the repair is finishable at all; this one is about whether a
 * second pair of eyes agreed to the state it is being finished in. Both run, in
 * that order, and the approval gate is added ALONGSIDE the precondition rather
 * than in front of it — a repair that fails the precondition must still say so
 * even when an approval exists, because "your approval drifted" would send the
 * technician to the wrong fix.
 */

export const REPAIR_SIGNOFF_ENTITY_TYPE = 'repair'
export const REPAIR_SIGNOFF_KIND = 'repair_signoff'
/** How every gate refusal names the record. */
export const REPAIR_SIGNOFF_SUBJECT = 'this repair'

/** The only status a repair can be signed off from (spec §5.3). */
export const REPAIR_SIGNOFF_FROM_STATUS = 'awaiting_sign_off'

/**
 * WHAT A SIGN-OFF APPROVER IS AGREEING TO.
 *
 * Signing off a repair asserts that a device is fit to return to service. So the
 * snapshot has to hold the claim, the evidence BEHIND the claim, and who made it:
 *
 *   repairNo      — the human reference; also the queue task's title (see
 *                   approvalService's LABEL_KEYS, which reads `repairNo`).
 *   deviceId      — WHICH device is going back into service. The whole point of
 *   deviceSn        the assertion. Carried by identity and by the serial a human
 *                   actually read, for the reason Finance carries buyerId AND
 *                   buyerName.
 *   technicianId  — WHO did the work. A sign-off is one person vouching for
 *   technicianName  another's; reassigning the repair after approval means the
 *                   approver is vouching for work by someone they never reviewed.
 *   partsReplaced — THE CLAIM. An assertion about the physical world (see the
 *                   column's COMMENT): "a board was swapped". Flipping it after
 *                   approval changes what was agreed to in the most material way
 *                   available.
 *   recordedReplacementCount
 *                 — THE BACKING for that claim: how many component_installation
 *                   rows reference this repair. This is the affected-items
 *                   analogue, and the reason it is in the snapshot rather than
 *                   only in the precondition: the precondition asks "is there at
 *                   least one?", which stays true while the answer moves from one
 *                   to four. An approver who reviewed a single board swap has not
 *                   agreed to a sign-off covering four. A §14 replacement stamps
 *                   TWO rows (the one it closes and the one it opens), so this
 *                   number is not a count of parts — it is a fingerprint of the
 *                   component record as reviewed.
 *   testingNotes  — THE EVIDENCE. Literally the thing being signed off; it is
 *                   also the precondition's second fact, so a sign-off approved
 *                   against one test report and executed against another would
 *                   otherwise pass both checks.
 *   correctiveAction
 *                 — what was actually done to fix it. Approving "replaced PCBA-A"
 *                   is not approving "resoldered a connector".
 *
 * DELIBERATELY ABSENT, and this list is the point of the type rather than an
 * apology for it:
 *
 *   status  — pinned to awaiting_sign_off by the precondition on BOTH the request
 *             path and the sign-off path, so it can only ever hold one value at
 *             either end. Carrying it would add noise to the drift message and to
 *             the approver's queue while detecting nothing the precondition does
 *             not already refuse with a better sentence.
 *   cost_sgd, warranty_flag, warranty_justification
 *           — Finance's concern on the invoice that follows, not part of the
 *             assertion that a device is fit to return to service. A warranty
 *             reclassification should not invalidate an engineer's sign-off.
 *   fault_description, diagnosis
 *           — what was BELIEVED at the start. The sign-off vouches for the fix
 *             and its evidence; correcting the original description after the
 *             fact is housekeeping, not a change to what was approved.
 *   version — the optimistic-lock counter, excluded for the reason ecoApproval.ts
 *             sets out at length. Carrying it would silently readmit every field
 *             just excluded, since `updateRepair` bumps it for all of them —
 *             making the exclusions above decorative — and would mean an edit
 *             that is PUT BACK stays drifted forever, which Finance's gate does
 *             not do.
 */
export type RepairSignOffSnapshot = {
  repairNo: string
  deviceId: string
  deviceSn: string | null
  technicianId: string | null
  technicianName: string | null
  partsReplaced: boolean
  recordedReplacementCount: number
  testingNotes: string | null
  correctiveAction: string | null
}

export type RepairSignOffFacts = RepairSignOffSnapshot

/** ONE builder for storing the snapshot and for rebuilding the projection. */
export function buildRepairSignOffSnapshot(facts: RepairSignOffFacts): RepairSignOffSnapshot {
  return {
    repairNo: facts.repairNo,
    deviceId: facts.deviceId,
    deviceSn: facts.deviceSn,
    technicianId: facts.technicianId,
    technicianName: facts.technicianName,
    partsReplaced: facts.partsReplaced,
    recordedReplacementCount: facts.recordedReplacementCount,
    testingNotes: facts.testingNotes,
    correctiveAction: facts.correctiveAction,
  }
}

export type RequestableDecision = { ok: true } | { ok: false; message: string }

/**
 * May a sign-off approval be REQUESTED for a repair in this status?
 *
 * Only from awaiting_sign_off — the state sign-off leaves. Earlier, the work is
 * still moving and an approver would be agreeing to a repair that has not
 * finished testing; later, the repair is closed or cancelled and the decision
 * changes nothing.
 */
export function repairSignOffRequestable(status: string): RequestableDecision {
  if (status === REPAIR_SIGNOFF_FROM_STATUS) return { ok: true }
  return {
    ok: false,
    message: 'Only a repair that is awaiting sign-off can be sent for sign-off approval — the '
      + `approval gates the move to closed, and this repair is "${status}".`,
  }
}
