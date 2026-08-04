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
 * `ec_affected_item` NOW EXISTS (20260803100001_platform_engineering_bom_effectivity
 * .sql), and this module is where its projection lives — see EcoAffectedItemSnapshot.
 */

export const ECO_APPROVAL_ENTITY_TYPE = 'eco'
export const ECO_APPROVAL_KIND = 'eco'
/** How every gate refusal names the record. */
export const ECO_APPROVAL_SUBJECT = 'this ECO'

/** The ECO status the approval gates the exit from (spec §4: submitted → approved). */
export const ECO_APPROVAL_FROM_STATUS = 'submitted'

/**
 * ONE `ec_affected_item` row as an approver sees it — the four facts that decide
 * what the apply actually does to a bill of materials, plus the notes it copies
 * onto the new line.
 *
 * BY IDENTITY, NEVER BY DISPLAY NAME, and that is the trap this projection exists
 * to avoid. `listAffectedItems` returns `variantName` / `componentTypeName` and
 * orders by them; both are admin-editable text. A snapshot carrying them would
 * report drift the day somebody renames a variant — on an ECO nobody touched —
 * and a warning that cries wolf is worse than no warning, because the real one is
 * then ignored. Ids do not move.
 *
 * `id` and `applied_at` are deliberately absent. The id is the ORDERING key (see
 * the projection query in ecoService.ts) but not content: an approver agrees to
 * "PCBA-A on variant X changes to qty 2", not to a row's uuid. `applied_at` moves
 * DURING the very apply this snapshot gates, so carrying it would make the gate
 * refuse its own second pass.
 */
export type EcoAffectedItemSnapshot = {
  variantId: string
  componentTypeId: string
  disposition: string
  quantity: number | null
  notes: string | null
}

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
 *                  effect. `effectivity_serial` is free text honouring legacy
 *                  ranged serials ("EE-02A-2603-0001 to 0015"), so widening the
 *                  range after approval widens which DEVICES the change touches.
 *                  It is one axis of the scope and it is not the affected-items
 *                  list — see below.
 *   affectedItems — WHAT the change is, per variant. THE SCOPE `effectivity_serial`
 *                  DOES NOT COVER, and the reason this key exists. `applyEco-
 *                  EffectivityTx` loops over `ec_affected_item` and those rows
 *                  ALONE decide which variant's BOM is rewritten, which component
 *                  type, whether it is added / changed / removed, and at what
 *                  quantity. `ec_affected_item.variant_id` is NOT NULL per row, so
 *                  an item added after approval can name a variant the approved
 *                  serial range never contained — an approval granted for a
 *                  one-line change riding a five-line change across three
 *                  variants. An ORDERED ARRAY: array order is significant to
 *                  `snapshotsAgree`, so the projection sorts on an immutable key
 *                  (see ecoService's ECO_AFFECTED_ITEMS_SQL, `ORDER BY i.id`).
 *
 * `version` IS DELIBERATELY NOT HERE, and the reasoning is worth recording
 * because carrying it looks strictly safer. The scalar fields are exactly
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
 * builder and the projection disagree. The SAME obligation now runs one level
 * down: a column added to `ec_affected_item` is not covered until it is added to
 * EcoAffectedItemSnapshot.
 *
 * THE SEAM, CLOSED. Spec §6.3's `ec_affected_item` (component type / variant +
 * disposition) landed in 20260803100001_platform_engineering_bom_effectivity.sql
 * and is projected here as an ordered array, exactly as this comment used to
 * promise it would be. Until it was, the snapshot named `effectivity_serial` as
 * "the affected-items scope"; it never was one. The serial range says which
 * DEVICES a change reaches, `ec_affected_item` says what the change DOES, and an
 * ECO can have its item list rewritten without the range moving a character.
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
  affectedItems: EcoAffectedItemSnapshot[]
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
    // Element-wise, not `[...facts.affectedItems]`: a shallow array copy still
    // aliases every row object, and this value is STORED as the immutable record
    // of what was agreed to. Rebuilding each item also enforces the projection —
    // a caller handing over a full AffectedItem (with variantName, appliedAt and
    // version on it) contributes exactly the five keys below and nothing else.
    affectedItems: facts.affectedItems.map((item) => ({
      variantId: item.variantId,
      componentTypeId: item.componentTypeId,
      disposition: item.disposition,
      quantity: item.quantity,
      notes: item.notes,
    })),
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

export type ScopeLockDecision = { locked: false } | { locked: true; message: string }

/**
 * Raised when an edit would change WHAT an already-acted-on approval covers.
 *
 * Lives HERE, with the rule, and not in ecoService — the same placement
 * `InvalidTransitionError` and `ApprovalGateError` have. An error class in a
 * service is one the action layer cannot name without importing a database
 * module into a unit test that has no database.
 *
 * A different class from `ApprovalGateError` on purpose: that one says "the state
 * moved after it was agreed to, request a fresh approval"; this one says "the
 * state may not move at all any more, raise a new change order". Different
 * moments, different people, different fixes.
 */
export class EcoScopeLockedError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EcoScopeLockedError'
  }
}

/**
 * IS THIS ECO'S SCOPE FROZEN BY AN APPROVAL THAT HAS ALREADY BEEN ACTED ON?
 *
 * The second half of the drift fix, and the one that decides WHERE the failure
 * happens. The snapshot re-check tells you an ECO drifted; this stops it drifting
 * in the first place, at the moment of the mistake rather than three steps later
 * at the apply — which is the difference between "you cannot add this item" and
 * "the change you spent an afternoon on cannot be applied".
 *
 * TWO CONDITIONS, and BOTH are load-bearing:
 *
 *   hasApproval — no request, no lock, in ANY status. This is the "requested ⇒
 *     binding" posture the whole consumer migration was shipped on (approvalGate.ts's
 *     header): an ECO nobody asked for a second pair of eyes on behaves exactly as
 *     it did before, with `edit_records` governing. Locking without a request would
 *     be a new policy invented inside a bug fix, and it would freeze every ECO in
 *     the product the moment it left `submitted`.
 *
 *   status !== submitted — while the ECO is still submitted the gated edge has NOT
 *     been crossed, so every edit is still re-checked at submitted → approved and
 *     nothing can ride an approval it does not match. Locking here would also
 *     destroy a behaviour the gate deliberately has: an edit that is PUT BACK stops
 *     being drift, which is only reachable if editing a submitted ECO under a live
 *     approval is allowed. Once the ECO has LEFT submitted the approval has already
 *     done its work, and there is no later re-check on the ordinary path — that
 *     absence is the hole.
 *
 * Pure and status-shaped rather than "is it approved": `implemented` and `rejected`
 * are past the edge too, and enumerating the frozen statuses would silently admit
 * any status added later.
 */
export function ecoScopeLockedByApproval(status: string, hasApproval: boolean): ScopeLockDecision {
  if (!hasApproval) return { locked: false }
  if (status === ECO_APPROVAL_FROM_STATUS) return { locked: false }
  return {
    locked: true,
    message: 'This change order has an approval request on it and has already moved past '
      + `submitted (it is "${status}"), so what it changes is fixed at what was reviewed. `
      + 'Editing it now would alter a change somebody already agreed to, with nothing left to '
      + 're-check it against. Raise a new change order for further changes.',
  }
}
