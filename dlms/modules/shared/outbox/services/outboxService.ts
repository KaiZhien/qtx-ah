import { z } from 'zod'
import { withTransaction, type Tx } from '@/lib/db/tx'
import { getPool } from '@/lib/db/pool'
import { loadSystemActor } from '@/modules/shared/authz/actor'
import { MODULES } from '@/modules/shared/authz/catalog'
import type { Actor } from '@/modules/shared/authz/catalog'
import { buildApprovalTask, buildHandoffTask } from '@/modules/shared/outbox/domain/handoffTemplates'
import { createTaskInTx, type CreateTaskInput } from '@/modules/shared/tasks/services/taskService'

/**
 * The drain (spec §5.5): turns unprocessed `outbox` rows into tasks, EXACTLY ONCE.
 *
 * Two event families ride this one mechanism, which is spec §5.5's own arrangement
 * ("approval flows ride the same mechanism"): a device crossing a department boundary
 * (`device`/`device_status_changed`) and a request for a second pair of eyes
 * (`approval`/`approval_requested`). They differ only in taskForEvent — the claim, the
 * exactly-once transaction, the failure handling and the attribution below are shared,
 * deliberately, because every one of those is a property of draining rather than of what
 * is being drained.
 *
 * "Exactly once" is the entire point, and it rests on one structural decision: the task
 * insert and the `processed_at` stamp happen in the SAME transaction. lib/db/tx.ts's
 * withTransaction takes a separate pooled connection each time it is called, so calling
 * the transaction-owning taskService.createTask() from inside the drain's transaction
 * would NOT nest — it would commit the task independently, and a crash before the stamp
 * would leave a task whose event is still unprocessed for the next drain to hand off
 * again. taskService.createTaskInTx() exists for exactly this, so there remains one
 * definition of what creating a task means (see its header).
 *
 * The other half is failure handling. A bad event is DATA, not an exception: an unknown
 * template key, a payload the producer never wrote, an event shape this version does not
 * handle. Each is recorded on the row (attempts + last_error, processed_at left NULL) and
 * the drain carries on with the rest of the batch. The only thing fatal to a drain is
 * being unable to resolve the principal it runs as, which is a deployment fault.
 */

/**
 * A row that has failed this many times is left alone: a poison event must not consume
 * every drain forever. It is PARKED, not dropped — still unprocessed, still visible in
 * the table and counted in DrainResult, waiting for someone to fix the cause and reset
 * `attempts`.
 */
export const MAX_ATTEMPTS = 5

/** Errors are recorded for a human to read, not to reconstruct a stack from. */
const LAST_ERROR_MAX = 1000

export type DrainResult = {
  /** Rows this drain locked and attempted. Always `processed + failed`. */
  claimed: number
  processed: number
  failed: number
  failures: Array<{ outboxId: string; error: string }>
  /**
   * Unprocessed rows at or beyond MAX_ATTEMPTS, counted AFTER this drain — so a row that
   * hit the cap on this very pass is already included.
   *
   * Not in the original sketch of this type, and deliberately added: the requirement is
   * that a parked row be "visible rather than silently skipped", and the return value is
   * where the route handler and the runbook (Task 5) can actually see it. A non-zero
   * `parked` with `claimed: 0` is the signature of a backlog that will never move on its
   * own.
   *
   * `null` when the count itself failed. Every row above is already committed by the time
   * it runs, so a broken reporting query must not throw away a completed drain's result —
   * but defaulting to 0 would be worse than reporting nothing, because 0 is precisely the
   * reading ("no backlog") a runbook stands down on. null says "unknown", which is true.
   */
  parked: number | null
}

const inputSchema = z.object({
  limit: z.number().int().positive().max(1000).default(100),
})
export type DrainInput = z.input<typeof inputSchema>

/**
 * The producer (deviceWriteService.changeDeviceStatus) writes this shape, and the table
 * COMMENT makes it self-contained on purpose: the drain builds the handoff from the
 * payload alone and never re-reads a device row that has since moved on to another
 * status. Field names match HandoffContext.
 *
 * `deviceId` is absent by design — it is the row's own `aggregate_id`. `changedByName` is
 * absent too, and is resolved from `created_by` at drain time so the task names the person
 * as they are called today rather than as they were called when the status changed.
 * `notifyRoles` is carried for the future notifications work (spec §6.3) and read by
 * nothing here.
 *
 * Validated rather than trusted: `payload` is jsonb with no schema behind it, and a
 * malformed one must become a recorded, retryable failure on ONE row instead of a
 * TypeError that takes down the whole drain.
 */
const nullableText = z.string().nullable().default(null)
const payloadSchema = z.object({
  taskTemplateKey: z.string().min(1),
  fromStatus: z.string().min(1),
  toStatus: z.string().min(1),
  reason: nullableText,
  deviceSn: nullableText,
  pcbaASnLegacy: nullableText,
})

/**
 * The producer for the second event family (approvalService.requestApprovalInTx), validated
 * for the same reason as the first: `payload` is jsonb with no schema behind it, and a
 * malformed one must become a recorded, retryable failure on ONE row instead of a TypeError
 * that takes down the whole drain.
 *
 * `approvalId` is absent by design — it is the row's own `aggregate_id` — and so is the
 * requester's name, resolved from `created_by` at drain time so the task names them as they
 * are called today. `module` is the value STORED on the approval row rather than one
 * re-derived from `kind` here (see the approvals migration's header: the module is a
 * property of the entity, so a kind→module map in code goes stale where the column does not).
 */
const approvalPayloadSchema = z.object({
  kind: z.string().min(1),
  module: z.enum(MODULES),
  entityType: z.string().min(1),
  entityId: z.string().uuid(),
  label: nullableText,
})

/**
 * `aggregate_type` and `event_type` are deliberately unconstrained in the schema so a new
 * kind of event never needs a migration. This drain handles two combinations; anything else
 * is RECORDED as a failure rather than silently skipped. Skipping would leave a row
 * unprocessed and invisible forever, re-claimed by every drain; recording it makes the
 * disagreement legible and self-limiting, because MAX_ATTEMPTS eventually parks it.
 */
export class UnsupportedEventError extends Error {
  constructor(aggregateType: string, eventType: string) {
    super(`The outbox drain does not handle ${aggregateType}/${eventType} events`)
    this.name = 'UnsupportedEventError'
  }
}

type ClaimedRow = {
  id: string
  aggregate_type: string
  aggregate_id: string
  event_type: string
  payload: unknown
  /** `created_by`'s current full name — the human who CAUSED the event, whatever its kind. */
  caused_by_name: string
}

type Outcome =
  | { state: 'processed' }
  | { state: 'skipped' }
  | { state: 'failed'; error: string }

const messageOf = (err: unknown): string =>
  (err instanceof Error ? err.message : String(err)).slice(0, LAST_ERROR_MAX)

/**
 * Locks one row for this transaction, or returns null if another drain already holds it
 * (SKIP LOCKED — never wait) or it stopped being claimable since the candidate scan.
 *
 * The predicate is re-checked HERE, under the lock, not just in the scan: the scan is an
 * unlocked read, so between it and this statement a concurrent drain may have processed
 * the row or pushed it past the cap. `FOR UPDATE OF o` locks only the outbox row — the
 * app_user join is a read, and locking staff rows for the duration of a task insert would
 * be a needless contention point.
 *
 * `outbox` has no `version` and needs none: rows are claimed by lock, not arbitrated by
 * optimistic concurrency, because there is no competing human writer to arbitrate with.
 */
async function claimRow(tx: Tx, outboxId: string): Promise<ClaimedRow | null> {
  const { rows } = await tx.query<ClaimedRow>(
    `SELECT o.id, o.aggregate_type, o.aggregate_id, o.event_type, o.payload,
            u.full_name AS caused_by_name
       FROM outbox o
       JOIN app_user u ON u.id = o.created_by
      WHERE o.id = $1 AND o.processed_at IS NULL AND o.attempts < $2
      FOR UPDATE OF o SKIP LOCKED`, [outboxId, MAX_ATTEMPTS])
  return rows[0] ?? null
}

/**
 * Turns one claimed row into the task it should become, dispatching on the event family.
 *
 * Each branch owns its own payload schema, its own template registry and its own links; what
 * they share is this function's contract — build a task or throw, touch nothing else — so a
 * new event family cannot accidentally acquire different failure or attribution behaviour.
 */
function taskForEvent(row: ClaimedRow): CreateTaskInput {
  if (row.aggregate_type === 'device' && row.event_type === 'device_status_changed') {
    const payload = payloadSchema.parse(row.payload)
    const handoff = buildHandoffTask(payload.taskTemplateKey, {
      deviceId: row.aggregate_id,            // the row's own aggregate id; never in the payload
      deviceSn: payload.deviceSn,
      pcbaASnLegacy: payload.pcbaASnLegacy,
      fromStatus: payload.fromStatus,
      toStatus: payload.toStatus,
      reason: payload.reason,
      changedByName: row.caused_by_name,
    })
    return {
      title: handoff.title,
      description: handoff.description,
      priority: handoff.priority,
      department: handoff.department,
      links: [{ entityType: 'device', entityId: row.aggregate_id, module: handoff.module }],
    }
  }

  if (row.aggregate_type === 'approval' && row.event_type === 'approval_requested') {
    const payload = approvalPayloadSchema.parse(row.payload)
    const handoff = buildApprovalTask(payload.kind, {
      approvalId: row.aggregate_id,          // the row's own aggregate id; never in the payload
      entityType: payload.entityType,
      entityId: payload.entityId,
      module: payload.module,
      label: payload.label,
      requestedByName: row.caused_by_name,
    })
    return {
      title: handoff.title,
      description: handoff.description,
      priority: handoff.priority,
      department: handoff.department,
      // TWO links, because an approval task is about two records at once: the approvals
      // queue and this task have to find each other by the approval's id, and the record
      // panel of the thing under approval has to show that a decision is outstanding.
      links: [
        { entityType: 'approval', entityId: row.aggregate_id, module: handoff.module },
        { entityType: payload.entityType, entityId: payload.entityId, module: handoff.module },
      ],
    }
  }

  throw new UnsupportedEventError(row.aggregate_type, row.event_type)
}

/**
 * One row, one transaction: build the task, create it with its record links, and stamp the
 * row processed. Any throw rolls all three back together, which is what makes a task without
 * its processed marker (and therefore a duplicate on the next drain) impossible.
 */
async function processOne(system: Actor, outboxId: string): Promise<Outcome> {
  try {
    return await withTransaction(system.id, async (tx): Promise<Outcome> => {
      const row = await claimRow(tx, outboxId)
      if (!row) return { state: 'skipped' }

      // No assignee, on purpose. The system principal holds create_records and
      // deliberately NOT assign_tasks (see 20260731000000_platform_outbox.sql), and a
      // handoff belongs to the receiving department's queue rather than to whoever an
      // automation happened to pick.
      await createTaskInTx(tx, system, taskForEvent(row))

      // Same transaction as the insert above. Guarded on processed_at so a row that
      // somehow moved underneath the lock fails loudly instead of silently double-handing.
      const stamped = await tx.query(
        `UPDATE outbox SET processed_at = now() WHERE id = $1 AND processed_at IS NULL`,
        [outboxId])
      if (stamped.rowCount !== 1) {
        throw new Error(`Could not stamp outbox ${outboxId} processed — it changed underneath`)
      }
      return { state: 'processed' }
    })
  } catch (err) {
    return { state: 'failed', error: messageOf(err) }
  }
}

/**
 * Records a failed attempt in its OWN transaction — the row's transaction rolled back, so
 * anything written there is gone. processed_at is left NULL so the next drain retries.
 *
 * Wrapped in withTransaction (rather than a bare pool query) for the audit trail: `outbox`
 * has no updated_by, so with no app.actor_id GUC fn_audit falls back to created_by and
 * would attribute every drain write to the human who caused the event.
 *
 * Guarded on `processed_at IS NULL`, and that guard is not decoration. This write happens
 * AFTER the row's transaction rolled back and released the row, so another drain can claim
 * and successfully process it in between — and an unguarded increment would then land on an
 * already-processed row, leaving a successfully handed-off event carrying attempts and a
 * last_error forever. Exactly-once survives that (the task is created once either way), but
 * anyone triaging this table on attempts/last_error would be reading a permanent false
 * alarm. The guard does not shorten the wait if that other claim is still in flight — an
 * UPDATE still queues on the row lock before it can re-evaluate the predicate, up to the
 * pool's statement_timeout — it only stops the write from being wrong.
 *
 * A failure to record a failure must not abort the drain either — the row simply stays
 * unprocessed with its old attempt count, which is the safe direction.
 */
async function recordFailure(system: Actor, outboxId: string, error: string): Promise<void> {
  try {
    await withTransaction(system.id, async (tx) => {
      await tx.query(
        `UPDATE outbox SET attempts = attempts + 1, last_error = $2
          WHERE id = $1 AND processed_at IS NULL`,
        [outboxId, error])
    })
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error', msg: 'outbox drain could not record a failed attempt',
      outboxId, err: messageOf(err),
    }))
  }
}

/**
 * Drains up to `limit` unprocessed events, oldest first.
 *
 * The candidate scan is an unlocked read that only picks the ids to try; the real claim is
 * the per-row `FOR UPDATE SKIP LOCKED` inside each row's transaction, which is what lets
 * two drains run concurrently without ever contending for — or duplicating — the same
 * event. Rows another drain is already holding are skipped, and counted as neither claimed
 * nor failed by this one.
 */
export async function drainOutbox(input: DrainInput = {}): Promise<DrainResult> {
  const { limit } = inputSchema.parse(input)

  // ONCE per drain, before any row is touched: resolving it per row would be N round
  // trips for a value that cannot change mid-drain, and a drain that cannot resolve its
  // principal must fail before it has half-processed a backlog.
  const system = await loadSystemActor()

  // `id` is a tie-break, not decoration: rows written in one transaction share an identical
  // occurred_at (now() is transaction-scoped), so ordering on occurred_at alone leaves the
  // LIMIT cut between them arbitrary — under sustained load the same row can lose the
  // coin-flip on every pass and be deferred indefinitely. The second key makes the order
  // total, so a row that loses once is ahead of the cut next time.
  const { rows: candidates } = await getPool().query<{ id: string }>(
    `SELECT id FROM outbox
      WHERE processed_at IS NULL AND attempts < $1
      ORDER BY occurred_at, id
      LIMIT $2`, [MAX_ATTEMPTS, limit])

  const result: DrainResult = { claimed: 0, processed: 0, failed: 0, failures: [], parked: null }

  for (const { id } of candidates) {
    const outcome = await processOne(system, id)
    if (outcome.state === 'skipped') continue

    result.claimed++
    if (outcome.state === 'processed') {
      result.processed++
    } else {
      result.failed++
      result.failures.push({ outboxId: id, error: outcome.error })
      await recordFailure(system, id, outcome.error)
    }
  }

  // Reporting, not work — and everything above is already committed row by row, so this
  // must not be able to turn a drain that processed its whole batch into a throw. See
  // DrainResult.parked for why a failure here reads as null rather than 0.
  try {
    const { rows: parked } = await getPool().query<{ n: number }>(
      `SELECT count(*)::int AS n FROM outbox WHERE processed_at IS NULL AND attempts >= $1`,
      [MAX_ATTEMPTS])
    result.parked = parked[0].n
  } catch (err) {
    console.error(JSON.stringify({
      level: 'error', msg: 'outbox drain could not count parked rows', err: messageOf(err),
    }))
  }

  return result
}
