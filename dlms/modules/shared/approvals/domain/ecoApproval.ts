/**
 * Engineering's half of the approvals engine: what an ECO approval AUTHORISES.
 *
 * Pure — no I/O, no clock. `ecoService` loads the ECO and fetches the governing
 * approval; everything that decides lives here and in approvalGate.ts.
 *
 * WHY THIS LIVES UNDER shared/approvals AND NOT UNDER engineering/domain, which
 * is where Finance's equivalent sits. Two reasons, in this order:
 *   1. The ECO approval rules are the engine's rules applied to an ECO — the
 *      snapshot shape and the gate are meaningless without approvalGate.ts and
 *      approvalDecision.ts, which are here.
 *   2. `modules/engineering/**` is owned by the Engineering slice building
 *      failure/RCA and BOM effectivity in the same wave. A snapshot projection is
 *      the last thing that should collide mid-merge with a module's own schema
 *      work. The consumer SERVICE (ecoService.ts) sits in Engineering where it
 *      belongs; only the pure projection is here.
 * If Engineering later grows an `ec_affected_item` table this module is the right
 * place to move from, not to grow around.
 */

export const ECO_APPROVAL_ENTITY_TYPE = 'eco'
export const ECO_APPROVAL_KIND = 'eco'
/** How every gate refusal names the record. */
export const ECO_APPROVAL_SUBJECT = 'this ECO'

/** The ECO status the approval gates the exit from (spec §4: submitted → approved). */
export const ECO_APPROVAL_FROM_STATUS = 'submitted'

/**
 * WHAT AN APPROVER IS ACTUALLY AGREEING TO, and why it is exactly these fields.
 *
 * The rule the migration states bluntly — "an approval authorises a specific
 * STATE, not an entity id" — means the snapshot must hold every value a reviewer
 * weighed and nothing whose movement is not a change of what they agreed to.
 *
 *   ecoNo        — the human reference. Also what approvalService derives
 *                  `ApprovalRecord.label` from and what the queued task is titled
 *                  with, so omitting it puts "eco 3f2a…" in an approver's queue.
 *   title        — WHAT the change is, in one line. The single field a reviewer
 *                  reads first.
 *   description  — and the reasoning behind it. Carried in full: an engineering
 *                  change approved on the strength of "thermal margin too small"
 *                  is not the same change once that justification is rewritten.
 *   ecrId/ecrNo  — WHICH request this order realises, by identity and by the
 *                  reference a human actually read. Both, for the reason Finance
 *                  carries buyerId AND buyerName: the id is what the row points
 *                  at, the text is what was reviewed, and an order re-pointed at
 *                  a different ECR between approval and approval-in-force is a
 *                  cheap re-request but an expensive silent surprise.
 *   effectivity* — date, serial and notes: WHEN and WHERE the change takes
 *                  effect. In today's schema this IS the affected-items scope.
 *                  `effectivity_serial` is free text honouring legacy ranged
 *                  serials ("EE-02A-2603-0001 to 0015"), so widening the range
 *                  after approval widens which devices the change touches —
 *                  precisely the "approved, then added an affected item" failure,
 *                  and it is caught here as ordinary field drift.
 *
 * `version` IS DELIBERATELY NOT HERE, and the reasoning is worth recording
 * because carrying it looks strictly safer. These eight fields are exactly
 * `ECO_UPDATE_COLUMNS` plus the two identifiers, so today `version` would detect
 * nothing the content does not already detect — while costing the one behaviour
 * Finance's gate has and this one would lose: an edit that is PUT BACK stops
 * being drift. With `version` in the snapshot the counter never returns, so a
 * mistaken keystroke and its correction would permanently invalidate an approval
 * that describes the ECO perfectly. It would also quietly override the judgement
 * this list represents — a snapshot that says "these fields are what an approver
 * agreed to" but drifts on any column at all is not making that claim.
 *
 * The cost is the one Finance already documents and accepts: a column added to
 * `eco` LATER is not covered until it is added here. That is a real obligation on
 * whoever adds it, not a silent hole — pinned by a test that fails the moment the
 * builder and the projection disagree.
 *
 * THE SEAM. Spec §6.3 describes an `ec_affected_item` table (component type /
 * variant + disposition) that does NOT exist in the schema today — Engineering's
 * BOM-effectivity work is where it lands. When it does, it belongs here as an
 * ORDERED ARRAY key, canonically sorted by id: array order is significant to
 * `snapshotsAgree`, so an unordered projection would report drift every time
 * Postgres returned the rows in a different order. Adding an item then shows up
 * as an added element and is refused — the behaviour is already pinned by
 * approvalGate.test.ts's added-key case.
 */
export type EcoApprovalSnapshot = {
  ecoNo: string
  title: string
  description: string | null
  ecrId: string | null
  ecrNo: string | null
  effectivityDate: string | null
  effectivitySerial: string | null
  effectivityNotes: string | null
}

export type EcoApprovalFacts = EcoApprovalSnapshot

/**
 * ONE builder, used to store the snapshot AND to build the projection it is later
 * re-checked against. Two builders that agree today are two builders that report
 * "added"/"removed" drift on every approval the morning one of them gains a field.
 */
export function buildEcoApprovalSnapshot(facts: EcoApprovalFacts): EcoApprovalSnapshot {
  return {
    ecoNo: facts.ecoNo,
    title: facts.title,
    description: facts.description,
    ecrId: facts.ecrId,
    ecrNo: facts.ecrNo,
    effectivityDate: facts.effectivityDate,
    effectivitySerial: facts.effectivitySerial,
    effectivityNotes: facts.effectivityNotes,
  }
}

export type RequestableDecision = { ok: true } | { ok: false; message: string }

/**
 * May an approval be REQUESTED for an ECO in this status?
 *
 * Only from `submitted`, the state the gated edge leaves. A draft ECO is still
 * being written, so an approval granted against it authorises a moving target; an
 * ECO already approved, implemented or rejected has passed the edge the approval
 * gates, and a decision that changes nothing is noise in a real person's queue.
 */
export function ecoApprovalRequestable(status: string): RequestableDecision {
  if (status === ECO_APPROVAL_FROM_STATUS) return { ok: true }
  return {
    ok: false,
    message: 'Only a submitted ECO can be sent for approval — the approval gates the move from '
      + `submitted to approved, and this ECO is "${status}".`,
  }
}
