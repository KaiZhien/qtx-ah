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
  buildEcoApprovalSnapshot, ecoApprovalRequestable, type EcoApprovalSnapshot,
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

function toSnapshot(row: EcoProjectionRow): EcoApprovalSnapshot {
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
    version: row.version,
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
  return { snapshot: toSnapshot(row), status: row.status, version: row.version }
}

/**
 * THE GATE. Called by `changeEcoStatus` inside its own transaction, after it has
 * locked the ECO and validated the transition, and only on the edge that needs an
 * approval.
 *
 * IN the transaction, deliberately — the same reasoning invoiceService's header
 * gives: a check on one pooled connection and an act on another leaves a window
 * between them, and `withTransaction` acquires a separate connection every call.
 * The snapshot is re-read here rather than passed in so it comes from the same
 * locked row the UPDATE will write.
 *
 * `requiredWithoutRequest: false` is the deliberate posture of this migration and
 * is documented at length in approvalGate.ts: an ECO that nobody raised a request
 * for is governed by `approve_requests` exactly as it is today. What changes is
 * that a request, once raised, BINDS — pending blocks, rejected blocks, and
 * approved-then-edited blocks while naming what moved.
 */
export async function assertEcoApprovalInTx(tx: Tx, ecoId: string): Promise<void> {
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
    action: 'approved',
    requiredWithoutRequest: false,
    current: projection.snapshot,
    approval: approval && {
      status: approval.status, snapshot: approval.snapshot, decisionNote: approval.decisionNote,
    },
  })
  if (!decision.ok) throw new EcoApprovalError(decision.code, decision.message)
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

    return {
      requestable: requestable.ok,
      requestableReason: requestable.ok ? null : requestable.message,
      approval,
      drift,
    }
  })
}
