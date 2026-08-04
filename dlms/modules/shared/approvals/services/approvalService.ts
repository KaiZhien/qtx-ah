import { z } from 'zod'
import { withTransaction, type Tx } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import { can } from '@/modules/shared/authz/policy'
import { MODULES, PERMISSIONS } from '@/modules/shared/authz/catalog'
import type { Actor, ModuleKey } from '@/modules/shared/authz/catalog'
import {
  APPROVAL_KINDS, APPROVAL_STATUSES, ApprovalDecisionError, evaluateDecision,
  messageForDecisionError, type ApprovalKind, type ApprovalStatus,
} from '@/modules/shared/approvals/domain/approvalDecision'

/**
 * The approvals engine's I/O half (spec §6.3, BR-4): request a second pair of
 * eyes, decide one, and read the queue.
 *
 * Shared across modules on purpose — one engine, many consumers — which shapes
 * three things that would otherwise look arbitrary:
 *
 *   THE REQUESTER'S PERMISSION IS A PARAMETER. Requesting an approval is part of
 *     the requester's own workflow, so the gate is the requester's own module
 *     permission (Finance passes `manage_finance`; a future Engineering consumer
 *     would pass its own). Hardcoding one would either lock the engine to Finance
 *     or force every consumer through a permission it has no other use for.
 *     DECIDING, by contrast, is the engine's own act and is always
 *     `approve_requests` (spec §3.2).
 *
 *   THE MODULE IS DERIVED AND VALIDATED, NEVER TRUSTED. `approval.module` is a
 *     stored column with no CHECK tying it to `kind` — deliberately, because such
 *     a CHECK would make every new kind a schema migration. That leaves exactly
 *     one thing standing between a caller and a row whose module and kind
 *     disagree: this service. A mismatch is refused rather than stored, because
 *     the queue is scoped by module and a misfiled request is one nobody sees.
 *
 *   THE TARGET IS VALIDATED ON THE WAY IN. `entity_type`/`entity_id` carry no
 *     foreign key (the point of a polymorphic engine), so nothing at the database
 *     level stops an approval naming a row that does not exist. The migration's
 *     header assigns that check here; APPROVAL_TARGETS below is where it lives.
 *
 * Every public entry point runs `authorize` and the Zod parse BEFORE
 * `withTransaction` acquires a connection — see prepareRequest's header for why
 * that ordering is load-bearing rather than stylistic.
 */

// ── Errors ──────────────────────────────────────────────────────────────────

export class ApprovalNotFoundError extends Error {
  constructor(approvalId: string) {
    super(`Approval ${approvalId} not found`)
    this.name = 'ApprovalNotFoundError'
  }
}

/**
 * The friendly face of `approval_one_pending_idx` (a partial unique index →
 * Postgres 23505). Reached by the honest double-click as well as by two
 * concurrent requests, so the message says what to do rather than what broke.
 */
export class ApprovalAlreadyPendingError extends Error {
  constructor(entityType: string, kind: ApprovalKind) {
    super(`This ${entityType.replace(/_/g, ' ')} already has a pending ${kind.replace(/_/g, ' ')} `
      + 'approval request. Wait for it to be decided, or withdraw it, before raising another.')
    this.name = 'ApprovalAlreadyPendingError'
  }
}

/**
 * The friendly face of `approval_rejection_needs_note`. That rule is a CHECK as
 * well as a service rule — the CHECK is what makes it unforgettable by a new call
 * site — but a user must never meet it as a raw 23514, and the service is the
 * only layer that can say what to do about it.
 */
export class RejectionNeedsNoteError extends Error {
  constructor() {
    super('A rejection needs a note saying what has to change — otherwise the requester is '
      + 'left guessing, and a rejection nobody can act on is worse than no rejection at all.')
    this.name = 'RejectionNeedsNoteError'
  }
}

/** The friendly face of `approval_snapshot_authorises_something`. */
export class InvalidSnapshotError extends Error {
  constructor(reason: string) {
    super(`This approval request cannot be recorded: ${reason} An approval authorises a specific `
      + 'state, so the request has to carry the values the approver is being asked to agree to.')
    this.name = 'InvalidSnapshotError'
  }
}

/** The target named by (entity_type, entity_id) is not one this kind can attach to. */
export class ApprovalTargetError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ApprovalTargetError'
  }
}

/** A caller-supplied `module` that disagrees with the one the kind belongs to. */
export class ApprovalModuleMismatchError extends Error {
  constructor(kind: ApprovalKind, supplied: ModuleKey, derived: ModuleKey) {
    super(`A "${kind}" approval belongs to ${derived}, not ${supplied}. The module is stored on `
      + 'the request and scopes the approvals queue, so a mismatched pair would file the request '
      + 'where its approvers never look.')
    this.name = 'ApprovalModuleMismatchError'
  }
}

// ── The kind → (module, target) registry ────────────────────────────────────

/**
 * What each kind attaches to, and where it belongs.
 *
 * `table` is used to build SQL and therefore never comes from input — only from
 * this frozen literal, which is what makes the existence check below injection-safe
 * without a quoting dance.
 *
 * One entity type per kind TODAY, and the pair is validated rather than assumed:
 * an `invoice` approval hanging off a device is not a niche case to accommodate,
 * it is a bug in the caller. The day a kind legitimately spans two targets or two
 * modules, this becomes a per-kind allow-set — a code change, not a migration,
 * which is exactly the trade the schema's missing CHECK was buying.
 */
const APPROVAL_TARGETS: Record<ApprovalKind, {
  module: ModuleKey; entityType: string; table: string
}> = {
  eco: { module: 'engineering', entityType: 'eco', table: 'eco' },
  invoice: { module: 'finance', entityType: 'sales_invoice', table: 'sales_invoice' },
  repair_signoff: { module: 'maintenance', entityType: 'repair', table: 'repair' },
}

/** The module a kind's requests belong to — the value stored in `approval.module`. */
export function moduleForKind(kind: ApprovalKind): ModuleKey {
  return APPROVAL_TARGETS[kind].module
}

// ── Shapes ──────────────────────────────────────────────────────────────────

/**
 * A snapshot must be a non-empty JSON OBJECT: `{}` and `null` compare equal to
 * everything, which would make the consumer's `snapshotsAgree` re-check pass
 * vacuously — the exact failure the column exists to prevent. Zod rejects arrays,
 * dates and null here; the emptiness question is settled after serialisation
 * (see serialiseSnapshot), because `{ note: undefined }` has a key and no content.
 */
const snapshotSchema = z.record(z.string(), z.unknown())

const requestSchema = z.object({
  entityType: z.string().min(1).max(50),
  entityId: z.string().uuid(),
  kind: z.enum(APPROVAL_KINDS),
  /** The REQUESTER's own module permission — see this module's header. */
  permission: z.enum(PERMISSIONS),
  snapshot: snapshotSchema,
  /** Optional, and validated against the kind rather than trusted. */
  module: z.enum(MODULES).optional(),
  /** Human reference for the record, e.g. an invoice number, used in the queued task. */
  label: z.string().max(200).nullish(),
})
export type RequestApprovalInput = z.input<typeof requestSchema>

const decideSchema = z.object({
  approvalId: z.string().uuid(),
  decision: z.enum(['approved', 'rejected']),
  note: z.string().max(5000).nullish(),
})
export type DecideApprovalInput = z.input<typeof decideSchema>

export type ApprovalRecord = {
  id: string
  entityType: string
  entityId: string
  module: ModuleKey
  kind: ApprovalKind
  status: ApprovalStatus
  snapshot: Record<string, unknown>
  label: string | null
  requestedBy: string
  requestedByName: string | null
  requestedAt: Date
  decidedBy: string | null
  decidedByName: string | null
  decidedAt: Date | null
  decisionNote: string | null
  version: number
}

type ApprovalRow = {
  id: string
  entity_type: string
  entity_id: string
  module: ModuleKey
  kind: ApprovalKind
  status: ApprovalStatus
  snapshot: Record<string, unknown>
  requested_by: string
  requested_by_name: string | null
  created_at: Date
  /** `created_at` at microsecond precision, for the keyset cursor only. */
  created_at_cursor: string
  decided_by: string | null
  decided_by_name: string | null
  decided_at: Date | null
  decision_note: string | null
  version: number
}

/**
 * `label` is not a column: it is carried on the outbox event so the queued task
 * can name the record, and re-derived for a read from the snapshot when the
 * snapshot happens to hold an obvious reference. Nothing depends on it being
 * present, which is why it is not stored — a denormalised copy of a number that
 * lives on the target row is a copy that can go stale.
 */
const LABEL_KEYS = ['invoiceNo', 'invoice_no', 'ecoNo', 'eco_no', 'repairNo', 'repair_no']

function labelFromSnapshot(snapshot: Record<string, unknown>): string | null {
  for (const key of LABEL_KEYS) {
    const value = snapshot[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return null
}

const SELECT_APPROVAL = `
  SELECT a.id, a.entity_type, a.entity_id, a.module, a.kind, a.status, a.snapshot,
         a.requested_by, r.full_name AS requested_by_name, a.created_at,
         -- The keyset cursor's timestamp half, at FULL microsecond precision. See
         -- encodeCursor: a JS Date cannot hold it, so it never becomes one.
         to_char(a.created_at AT TIME ZONE 'UTC',
                 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS created_at_cursor,
         a.decided_by, d.full_name AS decided_by_name, a.decided_at, a.decision_note, a.version
    FROM approval a
    LEFT JOIN app_user r ON r.id = a.requested_by
    LEFT JOIN app_user d ON d.id = a.decided_by`

const toRecord = (row: ApprovalRow): ApprovalRecord => ({
  id: row.id,
  entityType: row.entity_type,
  entityId: row.entity_id,
  module: row.module,
  kind: row.kind,
  status: row.status,
  snapshot: row.snapshot,
  label: labelFromSnapshot(row.snapshot),
  requestedBy: row.requested_by,
  requestedByName: row.requested_by_name,
  requestedAt: row.created_at,
  decidedBy: row.decided_by,
  decidedByName: row.decided_by_name,
  decidedAt: row.decided_at,
  decisionNote: row.decision_note,
  version: row.version,
})

// ── Requesting ──────────────────────────────────────────────────────────────

/**
 * jsonb cannot hold `undefined`, so `{ note: undefined }` has one key on the way
 * in and none on the way out — it would pass a keys-length check and then trip
 * the CHECK as `{}`. Serialise FIRST and judge the result, so the answer here is
 * the answer the database will give.
 *
 * A cyclic object throws a TypeError from JSON.stringify; that is a caller bug,
 * but it must arrive as a sentence rather than as a stack trace from deep inside
 * a service the caller did not know it was in.
 */
function serialiseSnapshot(snapshot: Record<string, unknown>): string {
  let json: string
  try {
    json = JSON.stringify(snapshot)
  } catch {
    throw new InvalidSnapshotError('its snapshot cannot be stored as JSON.')
  }
  if (json === undefined || json === '{}') {
    throw new InvalidSnapshotError('its snapshot is empty.')
  }
  return json
}

/**
 * Everything that must be true BEFORE an approval is requested — the permission
 * check, the shape check, the kind↔module↔entity_type agreement and the snapshot
 * — and nothing that touches the database.
 *
 * Kept out of the transaction on purpose, and taskService.prepare()'s header
 * states the reason in full: authorize.ts calls itself "the choke point. Every
 * service entry point calls this before touching data", and `before touching
 * data` is the load-bearing half. withTransaction acquires a pooled connection
 * and issues BEGIN before its callback runs, so running these checks inside it
 * would make every denied or malformed call burn a connection plus a
 * BEGIN/ROLLBACK round trip, and would turn a denial that happened to coincide
 * with a database blip into a 500 instead of a 403.
 *
 * Both entry points call it FIRST — requestApproval before it opens a
 * transaction, requestApprovalInTx at the top of the caller's. That is a repeated
 * parse, not a repeated round trip, and each is an entry point in its own right:
 * a consumer with its own transaction reaches requestApprovalInTx directly, so it
 * must be guarded by these rules rather than by its caller's diligence.
 *
 * The target's EXISTENCE cannot live here — it is a database fact. It stays
 * inside, where a throw rolls the whole request back.
 */
function prepareRequest(actor: Actor, input: RequestApprovalInput) {
  // Two fields are parsed a beat ahead of the rest, and only these two: the module
  // half of the authorization gate is named BY the kind, and the permission half is
  // the caller's parameter, so neither can be checked without first knowing they are
  // in their vocabularies. Everything else is validated after the gate, as the house
  // order requires.
  const kind = requestSchema.shape.kind.parse(input.kind)
  const target = APPROVAL_TARGETS[kind]
  authorize(actor, requestSchema.shape.permission.parse(input.permission), target.module)

  const data = requestSchema.parse(input)
  if (data.module && data.module !== target.module) {
    throw new ApprovalModuleMismatchError(kind, data.module, target.module)
  }
  if (data.entityType !== target.entityType) {
    throw new ApprovalTargetError(
      `A "${kind}" approval attaches to a ${target.entityType.replace(/_/g, ' ')}, `
      + `not to a ${data.entityType.replace(/_/g, ' ')}.`)
  }
  return { data, target, snapshotJson: serialiseSnapshot(data.snapshot) }
}

/** 23505 on the one-pending index → the friendly refusal; anything else re-thrown. */
function rethrowRequestError(err: unknown, entityType: string, kind: ApprovalKind): never {
  if (err && typeof err === 'object' && 'code' in err
      && (err as { code?: string }).code === '23505') {
    throw new ApprovalAlreadyPendingError(entityType, kind)
  }
  throw err
}

/**
 * Everything "requesting an approval" means — authorization, validation, the
 * target check, the row, and the outbox event that puts it in front of an
 * approver — inside a transaction the CALLER owns.
 *
 * This exists for consumers that must request as part of a larger write (Finance
 * submitting an invoice for approval reads the invoice, builds the snapshot from
 * it, and requests — all of which have to see one consistent state). The reason
 * it cannot simply call requestApproval is the one createTaskInTx and
 * changeDeviceStatusInTx already document: withTransaction acquires a SEPARATE
 * pooled connection every time, so transactions do not nest, and the "same
 * transaction" the outbox event depends on would silently become two.
 */
export async function requestApprovalInTx(
  tx: Tx, actor: Actor, input: RequestApprovalInput,
): Promise<{ approvalId: string }> {
  const { data, target, snapshotJson } = prepareRequest(actor, input)

  // The polymorphic pair carries no FK, so this is the only thing that stops an
  // approval naming a row that does not exist. `target.table` comes from the frozen
  // registry above and never from input.
  const { rows: found } = await tx.query(
    `SELECT 1 FROM ${target.table} WHERE id = $1 AND deleted_at IS NULL`, [data.entityId])
  if (found.length === 0) {
    throw new ApprovalTargetError(
      `The ${target.entityType.replace(/_/g, ' ')} this approval refers to no longer exists.`)
  }

  let approvalId: string
  try {
    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO approval (entity_type, entity_id, module, kind, snapshot,
                             requested_by, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6,$6,$6) RETURNING id`,
      [data.entityType, data.entityId, target.module, data.kind, snapshotJson, actor.id])
    approvalId = rows[0].id
  } catch (err) {
    rethrowRequestError(err, data.entityType, data.kind)
  }

  // Transactional outbox (spec §5.5: "approval flows ride the same mechanism").
  // The request and the intent to tell an approver about it commit together or not
  // at all: a crash between COMMIT and a task-creation call would otherwise leave a
  // pending request nobody is ever notified of, which looks exactly like a request
  // that was never made. The drain retries until the row is processed, so the worst
  // case is a late task, never a missing one.
  //
  // The payload is self-contained by design (see the outbox table's COMMENT): the
  // drain builds the task from it alone and never re-reads an approval that may have
  // been decided since. `approvalId` is deliberately absent — it is the row's own
  // aggregate_id — and the requester's NAME is absent too, resolved from created_by
  // at drain time so the task names them as they are called today.
  //
  // Nothing here can fail a legal request short of a genuine database error: no
  // drain call, no scheduling, no second transaction.
  await tx.query(
    `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload, created_by)
     VALUES ('approval', $1, 'approval_requested', $2::jsonb, $3)`,
    [approvalId!, JSON.stringify({
      kind: data.kind,
      module: target.module,
      entityType: data.entityType,
      entityId: data.entityId,
      label: data.label?.trim() || labelFromSnapshot(data.snapshot),
    }), actor.id])

  return { approvalId: approvalId! }
}

/**
 * Ask for a second pair of eyes on a specific STATE of a record, in a transaction
 * of this function's own.
 *
 * A thin wrapper over requestApprovalInTx — everything the request MEANS lives
 * there, so the two paths can never drift. What is here and not there is the
 * transaction, and the guard that runs before it.
 */
export async function requestApproval(
  actor: Actor, input: RequestApprovalInput,
): Promise<{ approvalId: string }> {
  // NOT redundant, despite the discarded return value: this call is what runs
  // authorize + parse BEFORE withTransaction acquires a connection. Deleting it moves
  // both guards inside the transaction — the regression this project has shipped
  // twice, pinned by "authorizes and validates BEFORE it ever acquires a connection"
  // in __tests__/integration/approvalService.test.ts.
  prepareRequest(actor, input)
  return withTransaction(actor.id, (tx) => requestApprovalInTx(tx, actor, input))
}

// ── Deciding ────────────────────────────────────────────────────────────────

/**
 * The guards that do not depend on a database fact: `approve_requests` in the
 * abstract, the input shape, and the rejection note.
 *
 * The MODULE-scoped half of the permission cannot live here — it depends on the
 * loaded row's own `module`, which is a database fact — so it runs inside the
 * transaction, exactly as changeDeviceStatusInTx's terminal `delete_records` check
 * does. Both halves are real: this one keeps an actor who can approve NOTHING from
 * ever reaching the pool, the inner one keeps an actor who can approve elsewhere
 * from deciding here.
 *
 * The note rule is knowable from the input alone, so it is refused here rather
 * than after a round trip — and, more importantly, before any UPDATE could reach
 * the CHECK and surface as a raw 23514.
 */
function prepareDecision(actor: Actor, input: DecideApprovalInput) {
  authorize(actor, 'approve_requests')
  const data = decideSchema.parse(input)
  const note = data.note?.trim() || null
  if (data.decision === 'rejected' && !note) throw new RejectionNeedsNoteError()
  return { ...data, note }
}

/**
 * Approve or reject a pending request.
 *
 * There is no `version` parameter, and its absence is deliberate rather than an
 * omission of the optimistic-lock convention. Every column that carries meaning on
 * a pending approval is immutable from creation (trg_approval_guard), so the only
 * collision that can occur is two people deciding at once — and that is arbitrated
 * here by `FOR UPDATE` plus the pure `evaluateDecision`, which tells the loser the
 * true and actionable thing ("already decided, raise a new request") rather than the
 * optimistic-lock message's "reload and try again", which would invite them to do
 * exactly that and lose again. The counter is still bumped, per the platform
 * convention that services increment it explicitly.
 */
export async function decideApproval(
  actor: Actor, input: DecideApprovalInput,
): Promise<{ status: ApprovalStatus; version: number }> {
  const data = prepareDecision(actor, input)

  return withTransaction(actor.id, async (tx) => {
    // `kind`, `entity_type` and `entity_id` are read for the outbox event below, not for
    // the decision itself — the drain's payload must be self-contained (see the outbox
    // table's COMMENT) so it never re-reads an approval that has since changed. Taken
    // under the SAME `FOR UPDATE` rather than in a second statement: they are immutable on
    // a pending approval (trg_approval_guard), and reading them here costs nothing.
    // `snapshot` rides along for the same reason and at the same zero cost: it is what
    // NAMES the record in the notification the requester reads. Without it the decided
    // event carried `label: null`, and `recordLabel` fell back to "sales invoice 3f2a1b9c"
    // where the requested-side notification for the very same record says "INV-2026-014".
    // A person being told their request was decided should recognise the thing decided.
    const { rows } = await tx.query<{
      status: ApprovalStatus; requested_by: string; module: ModuleKey
      kind: ApprovalKind; entity_type: string; entity_id: string
      snapshot: Record<string, unknown> | null
    }>(
      `SELECT status, requested_by, module, kind, entity_type, entity_id, snapshot
         FROM approval
        WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [data.approvalId])
    if (rows.length === 0) throw new ApprovalNotFoundError(data.approvalId)
    const current = rows[0]

    // The three refusals — already decided, no permission HERE, and self-approval —
    // in the pure domain, so no call site can reorder or forget one. Note that a
    // decider holding approve_requests is still refused on their own request.
    const decision = evaluateDecision({
      status: current.status,
      requestedBy: current.requested_by,
      deciderId: actor.id,
      deciderCanApprove: can(actor, 'approve_requests', current.module),
    })
    if (!decision.ok) {
      throw new ApprovalDecisionError(decision.error, messageForDecisionError(decision.error))
    }

    const { rows: updated } = await tx.query<{ version: number }>(
      `UPDATE approval
          SET status = $1, decided_by = $2, decided_at = now(), decision_note = $3,
              updated_at = now(), updated_by = $2, version = version + 1
        WHERE id = $4 AND status = 'pending'
        RETURNING version`,
      [data.decision, actor.id, data.note, data.approvalId])
    // Unreachable behind FOR UPDATE, and asserted anyway: silently reporting success
    // for a decision that did not land is the one outcome nothing downstream could
    // detect.
    if (updated.length === 0) {
      throw new ApprovalDecisionError(
        'already_decided', messageForDecisionError('already_decided'))
    }

    // Transactional outbox, the DECIDED half — the mirror of requestApprovalInTx's emit
    // above, and it must stay in THIS transaction for the same reason.
    //
    // The drain's exactly-once property comes from the notification insert and the
    // `processed_at` stamp sharing one transaction (RB-09). An emit that committed
    // separately from the decision it describes would reintroduce precisely the bug the
    // outbox exists to prevent, in one of two directions depending on which commit landed
    // first: a decision nobody is ever told about, or a notification announcing a decision
    // that then rolled back. `withTransaction` takes a fresh pooled connection per call,
    // so "just call a notify service here" is exactly that mistake.
    //
    // NO TASK COMES OF THIS — the drain deliberately creates none, because the decision is
    // the end of the work rather than the start of some — and a requester who has since
    // been deactivated is not an error either: there is simply nobody left to tell, and the
    // event is stamped processed. Both are the consumer's behaviour and are already pinned.
    //
    // `requestedBy` is the one field the other two families do not need. For a request and
    // a handoff the audience IS `created_by`, resolved at drain time; for a decision the
    // causer and the audience are different people, so the recipient must be named.
    //
    // `label` is null: the FOR UPDATE above deliberately does not read `snapshot`, and the
    // consumer's recordLabel already falls back to "<entity type> <short id>" rather than
    // rendering "null". Carrying the snapshot label would be a nicer sentence and a fourth
    // column; RB-09 specifies this shape and the consumer was built against it.
    await tx.query(
      `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload, created_by)
       VALUES ('approval', $1, 'approval_decided', $2::jsonb, $3)`,
      [data.approvalId, JSON.stringify({
        kind: current.kind,
        module: current.module,
        entityType: current.entity_type,
        entityId: current.entity_id,
        // Same derivation as the requested-side event, so one record reads the same in
        // both notifications. Still nullable — labelFromSnapshot returns null for a
        // snapshot with no recognisable name, and recordLabel's id fallback handles it.
        label: labelFromSnapshot(current.snapshot ?? {}),
        decision: data.decision,
        note: data.note,
        requestedBy: current.requested_by,
      }), actor.id])

    return { status: data.decision, version: updated[0].version }
  })
}

// ── Reading ─────────────────────────────────────────────────────────────────

/**
 * Reading an approval is reading metadata about a record, so it is gated on the
 * same `view_records` that governs the record itself, in the module the kind
 * belongs to. Pure — the module comes from the kind, not from the database — so it
 * belongs ahead of the connection like every other guard here.
 */
function prepareRead(actor: Actor, kind: ApprovalKind): void {
  authorize(actor, 'view_records', moduleForKind(kind))
}

/**
 * The approval that GOVERNS this record right now: its live pending request if it
 * has one, otherwise the most recent decision.
 *
 * The ordering is the whole answer. A pending request outranks any decision
 * because it is what is about to change; among decisions the newest wins because a
 * rejected request is re-requested as a NEW row, so the trail accumulates and only
 * its head describes the present.
 */
export async function getApprovalForInTx(
  tx: Tx, actor: Actor, entityType: string, entityId: string, kind: ApprovalKind,
): Promise<ApprovalRecord | null> {
  prepareRead(actor, kind)
  const { rows } = await tx.query<ApprovalRow>(
    `${SELECT_APPROVAL}
      WHERE a.entity_type = $1 AND a.entity_id = $2 AND a.kind = $3 AND a.deleted_at IS NULL
      ORDER BY (a.status = 'pending') DESC, a.created_at DESC, a.id DESC
      LIMIT 1`, [entityType, entityId, kind])
  return rows[0] ? toRecord(rows[0]) : null
}

/**
 * The governing approval, read for ENFORCEMENT rather than for display — and
 * therefore with no `actor` and no `authorize`.
 *
 * That omission is the point, and it is the same argument settingService's header
 * makes about reading a knob: the one caller is a gate, running inside a
 * transaction it already opened and already authorized, that needs to know whether
 * an approval constrains the act it is about to perform. Gating THAT read on
 * `view_records` would mean an actor's own grants decide whether a control applies
 * to them — a caller who cannot read approvals would sail past the gate instead of
 * being stopped by it, which is precisely backwards for a fail-closed check.
 *
 * It also removes a real wart: `getApprovalForInTx` demands `view_records` in the
 * consumer's module, so a gated path asks for a permission its ungated equivalent
 * never needed (recorded as a carried finding against the Finance gate, where it
 * is unreachable under today's role matrix but reachable via a per-user override).
 * New consumers use this and do not inherit it.
 *
 * Nothing here surfaces a value to a user: the caller turns it into a refusal.
 * `getApprovalFor` / `getApprovalForInTx` remain the READ path, where
 * `view_records` is exactly right, and they keep their guard.
 *
 * Ordering matches getApprovalForInTx's, and for the same reason: a live pending
 * request outranks any decision, and among decisions the newest wins.
 */
export async function getGoverningApprovalInTx(
  tx: Tx, entityType: string, entityId: string, kind: ApprovalKind,
): Promise<ApprovalRecord | null> {
  const { rows } = await tx.query<ApprovalRow>(
    `${SELECT_APPROVAL}
      WHERE a.entity_type = $1 AND a.entity_id = $2 AND a.kind = $3 AND a.deleted_at IS NULL
      ORDER BY (a.status = 'pending') DESC, a.created_at DESC, a.id DESC
      LIMIT 1`, [entityType, entityId, kind])
  return rows[0] ? toRecord(rows[0]) : null
}

/**
 * Every consumer calls this immediately before it acts on an approved record, and
 * then re-checks `snapshotsAgree` against current state (spec §6.3). Consumers
 * that are already inside a transaction must use getApprovalForInTx instead: a
 * check on one connection and an act on another leaves a window between them.
 */
export async function getApprovalFor(
  actor: Actor, entityType: string, entityId: string, kind: ApprovalKind,
): Promise<ApprovalRecord | null> {
  prepareRead(actor, kind)
  return withTransaction(actor.id,
    (tx) => getApprovalForInTx(tx, actor, entityType, entityId, kind))
}

export type ApprovalQueueFilter = {
  status?: ApprovalStatus[]
  kind?: ApprovalKind
  module?: ModuleKey
  limit?: number
  /** Opaque keyset cursor from a previous page's `nextCursor`. */
  cursor?: string
}

export type ApprovalQueuePage = {
  items: ApprovalRecord[]
  /** null when this is the last page. */
  nextCursor: string | null
}

/**
 * KEYSET, not OFFSET — the same choice engineeringReadService documents ("OFFSET
 * drifts as rows are inserted mid-session"). It matters more here than on a
 * catalogue: the queue's natural order is newest-first and its whole purpose is
 * that rows arrive while you are reading it, so an OFFSET page 2 would skip
 * exactly the requests that landed while page 1 was on screen.
 *
 * The cursor is `(created_at, id)`, which is the ORDER BY the queue already used
 * and which the `approval_queue_idx` index already serves. `id` is the tiebreaker
 * and is not optional: two requests committed in the same transaction share a
 * `created_at` to the microsecond, and a cursor on the timestamp alone would
 * either repeat or drop one of them.
 *
 * ── THE TIMESTAMP IS A STRING, AND THAT IS THE WHOLE POINT ─────────────────
 * `timestamptz` is MICROSECOND-precision in Postgres; a JS `Date` is MILLISECOND-
 * precision. Reading `a.created_at` into a `Date` and re-emitting it with
 * `toISOString()` — which is what this did — silently truncates the last three
 * digits, and the truncation goes DOWN. So the next page asked for
 * `created_at < 10:34:00.123` when the boundary row was really at
 * `10:34:00.123456`, and every row in that 456-microsecond window was SKIPPED:
 * the boundary row's own tie partner first of all, but in general any request
 * committed in the same millisecond as the last row on the page. The queue simply
 * stopped listing them — no error, no gap on screen, nothing to notice. The `id`
 * tiebreaker above could not save it, because the tuple comparison never got that
 * far: the timestamp component already excluded the row.
 *
 * So the boundary timestamp never becomes a `Date`. `created_at_cursor` is
 * rendered by Postgres at full `.US` precision, carried through the cursor
 * verbatim, and handed back to Postgres as text cast to `timestamptz` — the value
 * makes the whole round trip without passing through a type that cannot hold it.
 * `requestedAt` stays a `Date` because it is for display, where milliseconds are
 * already more than anyone reads.
 */
function encodeCursor(createdAtIso: string, id: string): string {
  return Buffer.from(`${createdAtIso}|${id}`).toString('base64url')
}

/** RFC 4122 hex, case-insensitive — the shape `approval.id` is guaranteed to be. */
const CURSOR_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/**
 * ISO-8601 UTC, with up to six fractional digits — exactly what `created_at_cursor`
 * emits, and still accepting the three-digit form an in-flight cursor from the
 * previous shape carries.
 *
 * Strict on purpose. The timestamp half now reaches Postgres as text cast to
 * `timestamptz`, so "anything `new Date()` happens to accept" is the wrong gate:
 * the two parsers disagree at the edges, and a string one takes and the other
 * refuses would be a 22007 out of a function whose contract is to answer with
 * page one. A regex both agree on is the only shape that fails closed.
 */
const CURSOR_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/

/**
 * Fails closed on anything malformed. The cursor reaches this from a URL query
 * string, so "not a cursor" is an ordinary input, not an exception: an
 * unparseable one would otherwise become `new Date(undefined)` → `Invalid Date` →
 * a raw Postgres error on a page that should simply have shown the first page.
 *
 * BOTH HALVES ARE SHAPE-CHECKED, and the id half is the one that used to be
 * missing. The timestamp was validated but the id only had to be non-empty, so
 * `base64url("2026-01-01T00:00:00.000Z|x")` decoded happily, reached the query as
 * a `uuid` comparison, and came back as Postgres 22P02 — a 500 on `/approvals`,
 * on exactly the hand-edited URL this function's own contract promises to answer
 * with page one. Anything a `uuid` column cannot hold is not a cursor.
 */
function decodeCursor(cursor: string): [string, string] | null {
  let decoded: string
  try {
    decoded = Buffer.from(cursor, 'base64url').toString()
  } catch {
    return null
  }
  const separator = decoded.indexOf('|')
  if (separator < 0) return null
  const timestamp = decoded.slice(0, separator)
  const id = decoded.slice(separator + 1)
  if (!CURSOR_TIMESTAMP.test(timestamp) || !CURSOR_ID.test(id)) return null
  return [timestamp, id]
}

/**
 * THE queue (spec §6.3), and the reason this feature works before any scheduler
 * exists: it reads the `approval` table DIRECTLY rather than waiting for the
 * outbox drain to have turned events into tasks. The drain's task is a
 * notification; this is the record.
 *
 * Scoped twice over, and both scopes matter:
 *   - `approve_requests`, without which an actor sees NOTHING. Empty rather than a
 *     throw, because this is a list surface: a queue that 403s for everyone who
 *     cannot act on it cannot be rendered on a shared dashboard, and "no rows"
 *     is both true and non-disclosing.
 *   - MODULE ACCESS, which is why `approval.module` is a stored column at all. A
 *     manager who can enter Finance but not Engineering must not see ECO requests.
 *     Computed through `can()` per module rather than restated here, so the
 *     super_admin module bypass and the `active` gate cannot drift from the one
 *     policy function.
 *
 * Pending-only by default: this is a work queue, and the decided rows are history.
 *
 * PAGED, because "All" is unbounded. The open backlog is small by construction —
 * a pending request is one somebody is about to clear — but the decided rows only
 * ever accumulate, so the `show=all` view grows without limit. The previous fixed
 * `LIMIT 200` did not fail on a large history, which is worse than failing: it
 * silently truncated it, and a decision trail that quietly stops at 200 rows is
 * indistinguishable from one that ends there.
 */
export async function listApprovals(
  actor: Actor, filter: ApprovalQueueFilter = {},
): Promise<ApprovalQueuePage> {
  const visibleModules = MODULES.filter((m) => can(actor, 'approve_requests', m))
  const modules = filter.module
    ? visibleModules.filter((m) => m === filter.module)
    : visibleModules
  // No connection is acquired for an actor who can see nothing — the same reason
  // every other guard here runs ahead of withTransaction.
  const empty: ApprovalQueuePage = { items: [], nextCursor: null }
  if (modules.length === 0) return empty

  const statuses = filter.status?.length
    ? filter.status.filter((s) => APPROVAL_STATUSES.includes(s))
    : (['pending'] as ApprovalStatus[])
  if (statuses.length === 0) return empty
  const limit = Math.min(Math.max(filter.limit ?? 50, 1), 200)

  return withTransaction(actor.id, async (tx) => {
    const params: unknown[] = []
    const p = (v: unknown) => { params.push(v); return `$${params.length}` }
    const conditions = [
      'a.deleted_at IS NULL',
      `a.module = ANY(${p(modules)})`,
      `a.status = ANY(${p(statuses)})`,
    ]
    if (filter.kind) conditions.push(`a.kind = ${p(filter.kind)}`)
    // A cursor that does not parse is ignored rather than refused: the caller gets
    // the first page, which is the honest answer to a hand-edited URL.
    const cursor = filter.cursor ? decodeCursor(filter.cursor) : null
    if (cursor) {
      conditions.push(
        `(a.created_at, a.id) < (${p(cursor[0])}::timestamptz, ${p(cursor[1])}::uuid)`)
    }

    // limit + 1 answers "is there another page?" without a second COUNT query
    // over a table whose decided half grows forever.
    const { rows } = await tx.query<ApprovalRow>(
      `${SELECT_APPROVAL}
        WHERE ${conditions.join(' AND ')}
        ORDER BY a.created_at DESC, a.id DESC
        LIMIT ${p(limit + 1)}`, params)

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    const last = page[page.length - 1]
    return {
      items: page.map(toRecord),
      nextCursor: hasMore && last ? encodeCursor(last.created_at_cursor, last.id) : null,
    }
  })
}

export type PendingApprovalCountFilter = {
  kind?: ApprovalKind
  module?: ModuleKey
  /**
   * Counts only requests this actor could actually DECIDE, i.e. excluding their
   * own. Off by default so the count matches what `/approvals` renders.
   */
  excludeOwnRequests?: boolean
}

/**
 * How many requests are waiting on this actor — for a dashboard tile, without
 * fetching rows in order to `.length` them.
 *
 * SCOPED IDENTICALLY TO listApprovals, and that is the whole reason this lives
 * here rather than being hand-rolled by each caller. Both scopes are subtle and
 * both are easy to get wrong from outside: `approve_requests` (without which the
 * answer is zero, not a throw — a tile on a shared dashboard must render for
 * everyone) and MODULE ACCESS resolved through `can()` per module, so a manager
 * who can enter Finance but not Engineering is not told there are ECO requests.
 * A COUNT written at a call site would almost certainly miss the second and leak
 * the existence of work in a module the reader cannot open.
 *
 * A tile and the queue it links to MUST agree, so this counts exactly what
 * `listApprovals` would return for the same actor — including, by default, the
 * actor's own pending requests. They are visible in the queue (marked, and with
 * the controls disabled, because nobody decides their own), so omitting them here
 * would make a tile reading "3" link to a page showing four rows. Callers who
 * want the actionable number rather than the visible one pass
 * `excludeOwnRequests: true`.
 */
export async function countPendingApprovals(
  actor: Actor, filter: PendingApprovalCountFilter = {},
): Promise<number> {
  const visibleModules = MODULES.filter((m) => can(actor, 'approve_requests', m))
  const modules = filter.module
    ? visibleModules.filter((m) => m === filter.module)
    : visibleModules
  // No connection acquired for an actor who can see nothing.
  if (modules.length === 0) return 0

  return withTransaction(actor.id, async (tx) => {
    const params: unknown[] = []
    const p = (v: unknown) => { params.push(v); return `$${params.length}` }
    const conditions = [
      'deleted_at IS NULL',
      "status = 'pending'",
      `module = ANY(${p(modules)})`,
    ]
    if (filter.kind) conditions.push(`kind = ${p(filter.kind)}`)
    if (filter.excludeOwnRequests) conditions.push(`requested_by <> ${p(actor.id)}`)

    const { rows } = await tx.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM approval WHERE ${conditions.join(' AND ')}`, params)
    // node-postgres returns bigint as TEXT to avoid float truncation; a queue
    // count is small, but parsing it explicitly beats relying on that.
    return Number(rows[0].count)
  })
}
