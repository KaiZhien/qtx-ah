import { z } from 'zod'
import { withTransaction, OptimisticLockError, type Tx } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'
import {
  requestApprovalInTx, getGoverningApprovalInTx, getApprovalForInTx,
  type ApprovalRecord,
} from '@/modules/shared/approvals/services/approvalService'
import { describeSnapshotDrift } from '@/modules/shared/approvals/domain/approvalDecision'
import {
  evaluateApprovalGate, ApprovalGateError,
} from '@/modules/shared/approvals/domain/approvalGate'
import {
  ECO_APPROVAL_ENTITY_TYPE, ECO_APPROVAL_KIND, ECO_APPROVAL_SUBJECT,
  buildEcoApprovalSnapshot, ecoApprovalRequestable, ecoScopeLockedByApproval,
  EcoScopeLockedError,
  type EcoAffectedItemSnapshot, type EcoApprovalSnapshot,
} from '@/modules/shared/approvals/domain/ecoApproval'

/**
 * ECO approvals ON THE ENGINE (spec §4/§6.3) — the Engineering consumer of the
 * shared approvals engine, and nothing else.
 *
 * WHY THIS IS A SEPARATE FILE FROM engineeringWriteService.ts. The ECO status
 * flow, its optimistic lock and its transition graph already live there and work;
 * this slice is a refactor with regression risk and no new capability, so the
 * engine wiring is added ALONGSIDE rather than folded into a function that ships
 * today. `engineeringWriteService.changeEcoStatus` gains exactly one call —
 * `assertEcoApprovalInTx`, inside the transaction it already opens — and keeps
 * everything else, including its own `approve_requests` gate.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * BOTH GATES HOLD, AND THEY ANSWER DIFFERENT QUESTIONS.
 *
 *   authorize(actor, 'approve_requests', 'engineering')  — MAY THIS PERSON do it?
 *     Unchanged, still in changeEcoStatus, still ahead of the connection. The
 *     engine does not replace it: an approvals record says a specific change was
 *     agreed to, not that the person applying it is allowed to.
 *
 *   assertEcoApprovalInTx                                — IS THIS THE CHANGE
 *     that was agreed to? Only meaningful once someone has raised a request, and
 *     it re-checks the snapshot against the ECO as locked, refusing on drift with
 *     the field and both values named.
 *
 * Deleting either one is a regression, and they fail for different people with
 * different fixes — hence two distinct errors rather than one merged "not
 * allowed".
 * ─────────────────────────────────────────────────────────────────────────────
 */

/** Raised when an approval exists and does not authorise the move being made. */
export class EcoApprovalError extends ApprovalGateError {}

/** Raised when an approval cannot be REQUESTED for this ECO right now. */
export class EcoApprovalRequestError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'EcoApprovalRequestError'
  }
}

/**
 * Re-exported so a caller that already imports this service does not need a second
 * import path for the error it throws. The class itself lives with its rule in the
 * pure domain — see ecoApproval.ts for why.
 */
export { EcoScopeLockedError }

export class EcoNotFoundError extends Error {
  constructor(id: string) {
    super(`ECO ${id} not found`)
    this.name = 'EcoNotFoundError'
  }
}

type EcoProjectionRow = {
  eco_no: string
  title: string
  description: string | null
  ecr_id: string | null
  ecr_no: string | null
  effectivity_date: string | null
  effectivity_serial: string | null
  effectivity_notes: string | null
  status: string
  version: number
}

/**
 * The projection an approval is granted for, read from the ECO as it stands.
 *
 * `effectivity_date` is selected as TEXT rather than as a `date`. node-postgres
 * would otherwise hand back a JS `Date` constructed in the HOST's timezone, which
 * on a non-UTC host renders as the previous day — the exact latent bug already
 * recorded against `DeviceEditDialog.dateInput` and fixed in the Logistics
 * `delivered_date` read. Here it would be worse than cosmetic: the stored
 * snapshot holds the jsonb string "2026-09-01" while a re-read produced a Date,
 * and the comparison would report drift on an ECO nobody touched.
 */
const ECO_PROJECTION_SQL = `
  SELECT o.eco_no, o.title, o.description, o.ecr_id, e.ecr_no,
         to_char(o.effectivity_date, 'YYYY-MM-DD') AS effectivity_date,
         o.effectivity_serial, o.effectivity_notes, o.status, o.version
    FROM eco o
    LEFT JOIN ecr e ON e.id = o.ecr_id
   WHERE o.id = $1 AND o.deleted_at IS NULL`

type AffectedItemProjectionRow = {
  variant_id: string
  component_type_id: string
  disposition: string
  quantity: number | null
  notes: string | null
}

/**
 * The affected items an approval covers — A DEDICATED QUERY, and reusing either of
 * the two that already read this table is a live bug in both directions.
 *
 * ORDER. Array order is significant to `snapshotsAgree` (jsonb preserves it), so
 * the order IS content and it has to come from a key that cannot move:
 *
 *   NOT `listAffectedItems`' `ORDER BY v.name, ct.sort, ct.name`. Those are the
 *     display query's columns and every one of them is admin-editable. Renaming a
 *     device variant, or re-sorting the component-type vocabulary, would re-order
 *     this array and report drift on an ECO NOBODY TOUCHED. A gate that cries wolf
 *     is a gate people click through, which costs more than not having it.
 *
 *   NOT `applyEcoEffectivityTx`'s order either. That query orders for its own
 *     reasons — the sequence in which it takes row locks — which has nothing to do
 *     with what an approver agreed to. Sharing it would silently redefine the
 *     meaning of every stored snapshot the next time somebody tunes the locking.
 *
 *   `ORDER BY i.id` — a uuid primary key. Arbitrary, immutable, total, and the same
 *     for every reader forever. The id is NOT projected (see EcoAffectedItemSnapshot):
 *     it orders the array, it is not part of what an approver agreed to.
 *
 * SOFT DELETES ARE EXCLUDED, matching every other reader of this table and matching
 * the apply, which is what makes the snapshot comparable to what will actually run.
 *
 * NO `FOR UPDATE` HERE, on purpose. Every writer of `ec_affected_item` — add,
 * remove and the apply itself — takes the parent `eco` row FOR UPDATE first, so the
 * ECO lock the callers of this projection already hold IS the item-list lock. Adding
 * a second lock class in a different order is how deadlocks are introduced.
 */
const ECO_AFFECTED_ITEMS_SQL = `
  SELECT i.variant_id, i.component_type_id, i.disposition, i.quantity, i.notes
    FROM ec_affected_item i
   WHERE i.eco_id = $1 AND i.deleted_at IS NULL
   ORDER BY i.id`

function toSnapshot(
  row: EcoProjectionRow, affectedItems: EcoAffectedItemSnapshot[],
): EcoApprovalSnapshot {
  // The SAME builder that stores the snapshot builds the projection it is later
  // re-checked against — two builders that agree today report "added"/"removed"
  // drift on every approval the morning one of them gains a field.
  return buildEcoApprovalSnapshot({
    ecoNo: row.eco_no,
    title: row.title,
    description: row.description,
    ecrId: row.ecr_id,
    ecrNo: row.ecr_no,
    effectivityDate: row.effectivity_date,
    effectivitySerial: row.effectivity_serial,
    effectivityNotes: row.effectivity_notes,
    affectedItems,
  })
}

async function loadEcoProjection(
  tx: Tx, ecoId: string, lock = false,
): Promise<{ snapshot: EcoApprovalSnapshot; status: string; version: number } | null> {
  // FOR UPDATE is applied to the ECO only — `e` is a LEFT JOINed lookup and
  // locking it would take a row lock on an ECR nobody is changing.
  const sql = lock ? `${ECO_PROJECTION_SQL} FOR UPDATE OF o` : ECO_PROJECTION_SQL
  const { rows } = await tx.query<EcoProjectionRow>(sql, [ecoId])
  const row = rows[0]
  if (!row) return null

  // AFTER the ECO row (and its lock, when one was asked for), so the item list is
  // read under the same serialisation as the ECO itself.
  const { rows: items } = await tx.query<AffectedItemProjectionRow>(
    ECO_AFFECTED_ITEMS_SQL, [ecoId])
  const affectedItems = items.map((i) => ({
    variantId: i.variant_id,
    componentTypeId: i.component_type_id,
    disposition: i.disposition,
    quantity: i.quantity,
    notes: i.notes,
  }))

  return { snapshot: toSnapshot(row, affectedItems), status: row.status, version: row.version }
}

/**
 * THE GATE. Re-checks the immutable snapshot against the ECO as it stands, inside
 * the CALLER's transaction, under the lock the caller already holds.
 *
 * TWO CALL SITES, AND THE SECOND ONE IS THE POINT OF THIS FIX:
 *
 *   changeEcoStatus, on submitted → approved. The edge the approval was requested
 *     for. Runs after the transition check, so an illegal move says it is illegal
 *     rather than blaming an approval.
 *
 *   applyEcoEffectivityTx, immediately before it rewrites a bill of materials.
 *     THE IRREVERSIBLE ACT. The status change is a label; the apply closes BOM
 *     lines and opens new ones with an effectivity point read LIVE off the ECO,
 *     over whatever `ec_affected_item` rows exist at that moment. Gating only the
 *     status change left every consequential step after the last re-check —
 *     approve a one-line change, add four items, implement, apply. A check on the
 *     act itself cannot be routed around by a write path nobody has thought of yet.
 *
 * IN the transaction, deliberately — the same reasoning invoiceService's header
 * gives: a check on one pooled connection and an act on another leaves a window
 * between them, and `withTransaction` acquires a separate connection every call.
 * The snapshot is re-read here rather than passed in so it comes from the same
 * locked row the write will go through.
 *
 * `action` is the gated act phrased as a past participle, and it exists so the two
 * call sites produce refusals that name what the reader was actually trying to do
 * ("cannot be approved" vs "cannot be applied to the BOM"). It is message text
 * only — nothing branches on it.
 *
 * `requiredWithoutRequest: false` is the deliberate posture of this migration and
 * is documented at length in approvalGate.ts: an ECO that nobody raised a request
 * for is governed by `approve_requests` exactly as it is today. What changes is
 * that a request, once raised, BINDS — pending blocks, rejected blocks, and
 * approved-then-edited blocks while naming what moved.
 */
export async function assertEcoApprovalInTx(
  tx: Tx, ecoId: string, action = 'approved',
): Promise<void> {
  const projection = await loadEcoProjection(tx, ecoId)
  // The caller has already established the ECO exists and holds its lock; a null
  // here would mean it vanished mid-transaction, which cannot happen. Nothing to
  // gate either way.
  if (!projection) return

  // The enforcement read: no actor, no view_records demand — see
  // getGoverningApprovalInTx's header for why a gate must not be permission-gated.
  const approval = await getGoverningApprovalInTx(
    tx, ECO_APPROVAL_ENTITY_TYPE, ecoId, ECO_APPROVAL_KIND)

  const decision = evaluateApprovalGate({
    subject: ECO_APPROVAL_SUBJECT,
    action,
    requiredWithoutRequest: false,
    current: projection.snapshot,
    approval: approval && {
      status: approval.status, snapshot: approval.snapshot, decisionNote: approval.decisionNote,
    },
  })
  if (!decision.ok) throw new EcoApprovalError(decision.code, decision.message)
}

/**
 * MAY THIS ECO'S CONTENT STILL BE EDITED? Called by every write that can change
 * what an approval covers — `updateEco`, `addAffectedItem`, `removeAffectedItem` —
 * inside the caller's transaction, under the `eco` row lock the caller has already
 * taken.
 *
 * WHY THIS EXISTS ALONGSIDE THE GATE ABOVE RATHER THAN INSTEAD OF IT. The gate
 * refuses an ACT that would ride a stale approval; this refuses the EDIT that makes
 * it stale. Both are needed and they are not redundant:
 *
 *   - Without this, the failure surfaces at the apply, long after the mistake, to
 *     whoever happens to press the button — and the honest fix at that point is a
 *     brand-new ECO, so the work is lost either way. Refusing at the keystroke is
 *     the same refusal delivered when it is cheap.
 *   - Without the gate, this is the only defence, and it is an application-level
 *     one. Any future writer of `eco` or `ec_affected_item` that does not call this
 *     silently reopens the hole; the gate on the irreversible act does not care how
 *     the rows changed.
 *
 * `status` is passed in rather than re-read: every caller has just SELECTed it
 * under FOR UPDATE, and re-reading it here would be a second read of the same
 * locked row that could only ever agree.
 *
 * NOT permission-gated, for `getGoverningApprovalInTx`'s reason: a caller who
 * cannot read approvals must be STOPPED by this, not sail past it.
 */
export async function assertEcoScopeEditableInTx(
  tx: Tx, ecoId: string, status: string,
): Promise<void> {
  // ecoScopeLockedByApproval short-circuits on `hasApproval: false`, but the read
  // still has to happen to KNOW that — and it is one indexed lookup on a table that
  // is empty for almost every ECO.
  const approval = await getGoverningApprovalInTx(
    tx, ECO_APPROVAL_ENTITY_TYPE, ecoId, ECO_APPROVAL_KIND)
  const decision = ecoScopeLockedByApproval(status, approval !== null)
  if (decision.locked) throw new EcoScopeLockedError(decision.message)
}

// ── Requesting ──────────────────────────────────────────────────────────────

const requestSchema = z.object({
  ecoId: z.string().uuid(),
  version: z.number().int().nonnegative(),
})
export type RequestEcoApprovalInput = z.input<typeof requestSchema>

/**
 * Ask for a second pair of eyes on a submitted ECO.
 *
 * `edit_records` is the REQUESTER's gate, not `approve_requests`: raising a
 * request is part of the engineer's own workflow, and demanding the approver's
 * permission to ask for an approval would mean only people who can decide can
 * request — which is the one combination the engine forbids anyway ("nobody
 * decides their own request").
 *
 * The `version` is not ceremony. The snapshot records what the requester was
 * looking at, so a request raised against a stale screen must fail rather than
 * quietly capture a state the requester never saw.
 *
 * Uses `requestApprovalInTx`, not `requestApproval`, for the reason that function
 * documents: the ECO is read under one connection and the snapshot must be stored
 * on the same one, or the approval records a state that had already moved.
 */
export async function requestEcoApproval(
  actor: Actor, input: RequestEcoApprovalInput,
): Promise<{ approvalId: string }> {
  // Ahead of the connection: authorize is the choke point and a denial must not
  // cost a pooled connection plus a BEGIN/ROLLBACK round trip.
  authorize(actor, 'edit_records', 'engineering')
  const data = requestSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    const projection = await loadEcoProjection(tx, data.ecoId, true)
    if (!projection) throw new EcoNotFoundError(data.ecoId)
    if (projection.version !== data.version) {
      throw new OptimisticLockError('eco', data.ecoId)
    }

    const requestable = ecoApprovalRequestable(projection.status)
    if (!requestable.ok) throw new EcoApprovalRequestError(requestable.message)

    return requestApprovalInTx(tx, actor, {
      entityType: ECO_APPROVAL_ENTITY_TYPE,
      entityId: data.ecoId,
      kind: ECO_APPROVAL_KIND,
      // The REQUESTER's own gate — see approvalService's header.
      permission: 'edit_records',
      label: projection.snapshot.ecoNo,
      snapshot: projection.snapshot,
    })
  })
}

// ── Reading ─────────────────────────────────────────────────────────────────

export type EcoApprovalState = {
  /** Whether a request may be raised right now (status-dependent). */
  requestable: boolean
  requestableReason: string | null
  approval: ApprovalRecord | null
  /** Empty unless an APPROVED snapshot no longer describes the ECO. */
  drift: string[]
  /**
   * True once the ECO's content is frozen by an approval that has already been
   * acted on. Surfaces the same rule `assertEcoScopeEditableInTx` enforces, so a
   * screen can stop OFFERING an edit the write will refuse — the house rule the
   * New Repair form's `canMoveToUnderRepair` established.
   */
  scopeLocked: boolean
  scopeLockedReason: string | null
}

/**
 * Everything an ECO screen needs to say something true about approval, in one
 * read: whether a request can be raised, which request governs, and — the part
 * that has to be visible BEFORE someone clicks Approve — whether an approval
 * already granted has been invalidated by a later edit.
 *
 * This is the DISPLAY path, so it uses `getApprovalForInTx` and pays its
 * `view_records` guard. The enforcement path deliberately does not (see
 * getGoverningApprovalInTx).
 */
export async function getEcoApprovalState(
  actor: Actor, ecoId: string,
): Promise<EcoApprovalState | null> {
  authorize(actor, 'view_records', 'engineering')
  const id = z.string().uuid().safeParse(ecoId)
  if (!id.success) return null

  return withTransaction(actor.id, async (tx) => {
    const projection = await loadEcoProjection(tx, id.data)
    if (!projection) return null

    const approval = await getApprovalForInTx(
      tx, actor, ECO_APPROVAL_ENTITY_TYPE, id.data, ECO_APPROVAL_KIND)
    const drift = approval?.status === 'approved'
      ? describeSnapshotDrift(approval.snapshot, projection.snapshot)
      : []
    const requestable = ecoApprovalRequestable(projection.status)
    // Read from the SAME `approval` the drift line above uses, so the page can
    // never say "frozen" while showing no request, or vice versa.
    const lock = ecoScopeLockedByApproval(projection.status, approval !== null)

    return {
      requestable: requestable.ok,
      requestableReason: requestable.ok ? null : requestable.message,
      approval,
      drift,
      scopeLocked: lock.locked,
      scopeLockedReason: lock.locked ? lock.message : null,
    }
  })
}
