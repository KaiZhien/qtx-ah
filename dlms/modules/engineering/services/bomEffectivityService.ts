import { z } from 'zod'
import { withTransaction, OptimisticLockError, type Tx } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'
import {
  resolveBomAt, findBomEffectivityConflicts, isUsableEffectivityPoint,
  type BomLineEffectivity, type BomAt,
} from '@/modules/engineering/domain/bomEffectivity'
import {
  assertEcoApprovalInTx, assertEcoScopeEditableInTx,
} from '@/modules/engineering/services/ecoService'

/**
 * BOM effectivity automation (spec §6.3 ec_affected_item + variant_bom_line).
 *
 * An ECO declares WHAT it changes (ec_affected_item rows) and WHEN/WHERE the
 * change takes effect (eco.effectivity_date / effectivity_serial). Applying it
 * rewrites the variant BOM by closing the outgoing line at the effectivity point
 * and opening the incoming one at the same point — see the migration header
 * 20260803100001_platform_engineering_bom_effectivity.sql and the pure domain
 * modules/engineering/domain/bomEffectivity.ts for the date-vs-serial precedence
 * rule and why the windows are half-open.
 *
 * ── Why applying is its own operation ───────────────────────────────────────
 * The trigger is "the ECO reached `implemented`", but the apply is exposed as an
 * explicit, permissioned, separately-audited step rather than a side effect
 * buried in the status change, for three reasons: it is idempotent so it can be
 * retried; it produces a report (lines opened/closed) an engineer should see;
 * and rewriting a bill of materials deserves its own audit event. The
 * `applyEcoEffectivityTx` variant takes a caller's transaction precisely so the
 * ECO status change CAN fold it in atomically later — one line inside that
 * service's existing withTransaction — without this file changing at all.
 *
 * ── Idempotency ─────────────────────────────────────────────────────────────
 * `ec_affected_item.applied_at` is the token. The apply locks the ECO row and
 * every item row FOR UPDATE, then skips items already stamped. Two concurrent
 * applies therefore serialize on those locks and the second one finds nothing to
 * do; a re-run after a crash resumes exactly where it stopped, because each
 * item's stamp is written in the same transaction as its BOM rows.
 */

export class BomEcoNotFoundError extends Error {
  readonly id: string
  constructor(id: string) {
    super(`Change order ${id} not found`)
    this.name = 'BomEcoNotFoundError'
    this.id = id
  }
}

export type BomApplyErrorCode =
  /** The ECO has not reached `implemented`. */
  | 'not_implemented'
  /** The ECO carries neither an effectivity date nor an effectivity serial. */
  | 'no_effectivity_point'
  /** `add` for a component type the variant BOM already carries. */
  | 'already_on_bom'
  /** `change`/`remove` for a component type the variant BOM does not carry. */
  | 'not_on_bom'

export class BomApplyError extends Error {
  readonly code: BomApplyErrorCode
  constructor(code: BomApplyErrorCode, message: string) {
    super(message)
    this.name = 'BomApplyError'
    this.code = code
  }
}

export class BomVariantNotFoundError extends Error {
  constructor(id: string) {
    super(`Variant ${id} not found`)
    this.name = 'BomVariantNotFoundError'
  }
}

export class AffectedItemNotFoundError extends Error {
  constructor(id: string) {
    super(`Affected item ${id} not found`)
    this.name = 'AffectedItemNotFoundError'
  }
}

export class DuplicateAffectedItemError extends Error {
  constructor() {
    super('That component type is already listed on this change order for that variant')
    this.name = 'DuplicateAffectedItemError'
  }
}

/** An affected item cannot be added to (or removed from) an already-applied ECO. */
export class AffectedItemLockedError extends Error {
  constructor() {
    super('This change order has already been applied to the BOM and can no longer be edited')
    this.name = 'AffectedItemLockedError'
  }
}

function isPgCode(err: unknown, code: string): boolean {
  return !!err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === code
}

const DISPOSITIONS = ['add', 'change', 'remove'] as const
export type Disposition = (typeof DISPOSITIONS)[number]

// ═══════════════════════════ Reads ══════════════════════════════════════════

export type AffectedItem = {
  id: string; ecoId: string
  variantId: string; variantName: string
  componentTypeId: string; componentTypeName: string; componentTypeCode: string
  disposition: Disposition; quantity: number | null; notes: string | null
  appliedAt: Date | null; version: number
}

/** The affected-item list rendered on the ECO detail page. */
export async function listAffectedItems(actor: Actor, ecoId: string): Promise<AffectedItem[]> {
  authorize(actor, 'view_records', 'engineering')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      id: string; eco_id: string; variant_id: string; variant_name: string
      component_type_id: string; component_type_name: string; component_type_code: string
      disposition: Disposition; quantity: number | null; notes: string | null
      applied_at: Date | null; version: number
    }>(
      `SELECT i.id, i.eco_id, i.variant_id, v.name AS variant_name,
              i.component_type_id, ct.name AS component_type_name, ct.code AS component_type_code,
              i.disposition, i.quantity, i.notes, i.applied_at, i.version
         FROM ec_affected_item i
         JOIN device_variant v ON v.id = i.variant_id
         JOIN component_type ct ON ct.id = i.component_type_id
        WHERE i.eco_id = $1 AND i.deleted_at IS NULL
        ORDER BY v.name, ct.sort, ct.name`, [ecoId])
    return rows.map((r) => ({
      id: r.id, ecoId: r.eco_id, variantId: r.variant_id, variantName: r.variant_name,
      componentTypeId: r.component_type_id, componentTypeName: r.component_type_name,
      componentTypeCode: r.component_type_code, disposition: r.disposition,
      quantity: r.quantity, notes: r.notes, appliedAt: r.applied_at, version: r.version,
    }))
  })
}

export type BomLineRow = BomLineEffectivity & {
  componentTypeName: string
  componentTypeCode: string
  notes: string | null
  createdByEcoId: string | null
  createdByEcoNo: string | null
  supersededByEcoId: string | null
  supersededByEcoNo: string | null
}

export type VariantBomView = {
  variantId: string
  variantName: string
  at: BomAt
  /** The effective BOM at `at` — at most one line per component type. */
  lines: BomLineRow[]
  /** Every line ever, newest window first — the "what changed when" table. */
  history: BomLineRow[]
  /** Component types with overlapping effective windows (a data defect). */
  conflicts: { componentTypeId: string; lineIds: string[] }[]
}

const bomQuerySchema = z.object({
  variantId: z.string().uuid(),
  /** Required — the date axis is the floor that always yields an answer. */
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD'),
  serial: z.string().max(200).optional(),
})
export type VariantBomQuery = z.input<typeof bomQuerySchema>

/**
 * "What was the BOM for this variant on date D / at build serial S?"
 *
 * Flat select + JS reduce (house rule: no DB views/RPC) — every line for the
 * variant comes back and the pure resolver decides which ones are effective, so
 * the precedence rule lives in exactly one unit-tested place instead of being
 * re-expressed in SQL where it could quietly drift.
 *
 * DATE COLUMNS ARE READ AS TEXT (`::text`). node-postgres would otherwise
 * hand back a JS Date built at LOCAL midnight, which on a non-UTC host shifts
 * a 'YYYY-MM-DD' effectivity bound by a day — the exact defect already recorded
 * against the logistics delivered_date read.
 */
export async function getVariantBom(actor: Actor, query: VariantBomQuery): Promise<VariantBomView> {
  authorize(actor, 'view_records', 'engineering')
  const q = bomQuerySchema.parse(query)

  return withTransaction(actor.id, async (tx) => {
    const { rows: variantRows } = await tx.query<{ id: string; name: string }>(
      `SELECT id, name FROM device_variant WHERE id = $1`, [q.variantId])
    if (variantRows.length === 0) throw new BomVariantNotFoundError(q.variantId)

    const { rows } = await tx.query<{
      id: string; component_type_id: string; component_type_name: string
      component_type_code: string; quantity: number; notes: string | null
      effective_from_date: string | null; effective_to_date: string | null
      effective_from_serial: string | null; effective_to_serial: string | null
      created_by_eco_id: string | null; created_by_eco_no: string | null
      superseded_by_eco_id: string | null; superseded_by_eco_no: string | null
      created_at: string
    }>(
      `SELECT b.id, b.component_type_id, ct.name AS component_type_name,
              ct.code AS component_type_code, b.quantity, b.notes,
              b.effective_from_date::text   AS effective_from_date,
              b.effective_to_date::text     AS effective_to_date,
              b.effective_from_serial, b.effective_to_serial,
              b.created_by_eco_id, co.eco_no AS created_by_eco_no,
              b.superseded_by_eco_id, so.eco_no AS superseded_by_eco_no,
              b.created_at::text AS created_at
         FROM variant_bom_line b
         JOIN component_type ct ON ct.id = b.component_type_id
         LEFT JOIN eco co ON co.id = b.created_by_eco_id
         LEFT JOIN eco so ON so.id = b.superseded_by_eco_id
        WHERE b.variant_id = $1 AND b.deleted_at IS NULL
        ORDER BY ct.sort, ct.name, b.effective_from_date NULLS FIRST, b.created_at`,
      [q.variantId])

    const all: BomLineRow[] = rows.map((r) => ({
      id: r.id,
      componentTypeId: r.component_type_id,
      componentTypeName: r.component_type_name,
      componentTypeCode: r.component_type_code,
      quantity: r.quantity,
      notes: r.notes,
      effectiveFromDate: r.effective_from_date,
      effectiveToDate: r.effective_to_date,
      effectiveFromSerial: r.effective_from_serial,
      effectiveToSerial: r.effective_to_serial,
      createdByEcoId: r.created_by_eco_id,
      createdByEcoNo: r.created_by_eco_no,
      supersededByEcoId: r.superseded_by_eco_id,
      supersededByEcoNo: r.superseded_by_eco_no,
      createdAt: r.created_at,
    }))

    const at: BomAt = { date: q.date, serial: q.serial ?? null }
    return {
      variantId: q.variantId,
      variantName: variantRows[0].name,
      at,
      lines: resolveBomAt(all, at),
      history: [...all].reverse(),
      conflicts: findBomEffectivityConflicts(all, at),
    }
  })
}

/** Active variants, for the BOM viewer and the affected-item form. */
export async function listBomVariantOptions(actor: Actor): Promise<{ id: string; label: string }[]> {
  authorize(actor, 'view_records', 'engineering')
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ id: string; name: string }>(
      `SELECT id, name FROM device_variant WHERE active ORDER BY name`)
    return rows.map((r) => ({ id: r.id, label: r.name }))
  })
}

// ═══════════════════════════ Affected-item writes ═══════════════════════════

const addItemSchema = z.object({
  ecoId: z.string().uuid(),
  variantId: z.string().uuid(),
  componentTypeId: z.string().uuid(),
  disposition: z.enum(DISPOSITIONS),
  quantity: z.number().int().min(1).optional(),
  notes: z.string().max(2000).optional(),
}).refine((d) => (d.disposition === 'remove') === (d.quantity === undefined), {
  message: 'Give a quantity for add/change, and none for remove',
  path: ['quantity'],
})
export type AddAffectedItemInput = z.input<typeof addItemSchema>

/**
 * List a component type as affected by an ECO.
 *
 * TWO REFUSALS, answering different questions and both necessary:
 *
 *   ALREADY APPLIED — an item added after an apply would be picked up by a later,
 *     unrelated run and silently backdate itself to this ECO's effectivity point,
 *     producing a BOM history that never happened.
 *
 *   SCOPE LOCKED BY AN APPROVAL — these rows ARE what an approval covers. They
 *     alone decide which variant's BOM is rewritten, which component type, add /
 *     change / remove, and at what quantity, so adding one to an ECO somebody has
 *     already approved changes the change itself. The applied check does not cover
 *     this at all: it only ever fires AFTER the BOM was rewritten, and the whole
 *     window between `approved` and the apply sits before it.
 */
export async function addAffectedItem(
  actor: Actor, input: AddAffectedItemInput,
): Promise<{ id: string }> {
  authorize(actor, 'edit_records', 'engineering')
  const data = addItemSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    const { rows: ecoRows } = await tx.query<{ id: string; status: string }>(
      `SELECT id, status FROM eco WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [data.ecoId])
    if (ecoRows.length === 0) throw new BomEcoNotFoundError(data.ecoId)
    await assertEcoScopeEditableInTx(tx, data.ecoId, ecoRows[0].status)

    const { rows: applied } = await tx.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM ec_affected_item
        WHERE eco_id = $1 AND deleted_at IS NULL AND applied_at IS NOT NULL`, [data.ecoId])
    if (Number(applied[0].n) > 0) throw new AffectedItemLockedError()

    try {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO ec_affected_item
           (eco_id, variant_id, component_type_id, disposition, quantity, notes,
            created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$7) RETURNING id`,
        [data.ecoId, data.variantId, data.componentTypeId, data.disposition,
         data.quantity ?? null, data.notes ?? null, actor.id])
      return { id: rows[0].id }
    } catch (err) {
      if (isPgCode(err, '23505')) throw new DuplicateAffectedItemError()
      throw err
    }
  })
}

const removeItemSchema = z.object({
  id: z.string().uuid(), version: z.number().int().nonnegative(),
})
export type RemoveAffectedItemInput = z.input<typeof removeItemSchema>

/**
 * Soft-delete an affected item. Refused once it has been applied, and refused once
 * an approval covers it — REMOVING an item is as much a change of scope as adding
 * one, and it is the half a "nothing new was smuggled in" reading of the gate
 * misses.
 *
 * LOCK ORDER IS ECO → ITEM, matching `addAffectedItem` and `applyEcoEffectivityTx`.
 * The parent id is resolved with an unlocked read first, purely so the ECO can be
 * locked BEFORE the item: taking the item lock first would give this function the
 * reverse order from its two siblings, which is how two of them deadlock against
 * each other on one ECO. It also makes the ECO row lock the item-list lock, which
 * is what lets ecoService's snapshot projection read the items without a lock of
 * its own.
 */
export async function removeAffectedItem(
  actor: Actor, input: RemoveAffectedItemInput,
): Promise<{ version: number }> {
  authorize(actor, 'edit_records', 'engineering')
  const data = removeItemSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    const { rows: parent } = await tx.query<{ eco_id: string }>(
      `SELECT eco_id FROM ec_affected_item WHERE id = $1 AND deleted_at IS NULL`, [data.id])
    if (parent.length === 0) throw new AffectedItemNotFoundError(data.id)

    const { rows: ecoRows } = await tx.query<{ status: string }>(
      `SELECT status FROM eco WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [parent[0].eco_id])
    if (ecoRows.length === 0) throw new BomEcoNotFoundError(parent[0].eco_id)
    await assertEcoScopeEditableInTx(tx, parent[0].eco_id, ecoRows[0].status)

    const { rows } = await tx.query<{ version: number; applied_at: Date | null }>(
      `SELECT version, applied_at FROM ec_affected_item
        WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [data.id])
    // Re-checked after the lock: the unlocked read above resolved the parent, it
    // did not establish that the row survived until we got here.
    if (rows.length === 0) throw new AffectedItemNotFoundError(data.id)
    if (rows[0].version !== data.version) throw new OptimisticLockError('ec_affected_item', data.id)
    if (rows[0].applied_at) throw new AffectedItemLockedError()

    const { rows: updated } = await tx.query<{ version: number }>(
      `UPDATE ec_affected_item
          SET deleted_at = now(), updated_at = now(), updated_by = $1, version = version + 1
        WHERE id = $2 AND version = $3 RETURNING version`, [actor.id, data.id, data.version])
    if (updated.length === 0) throw new OptimisticLockError('ec_affected_item', data.id)
    return { version: updated[0].version }
  })
}

// ═══════════════════════════ The apply step ═════════════════════════════════

export type ApplyEffectivityResult = {
  ecoId: string
  itemsApplied: number
  linesOpened: number
  linesClosed: number
  /** True when there was nothing left to do (every item was already stamped). */
  alreadyApplied: boolean
}

type EcoEffectivity = {
  id: string
  status: string
  /** Read as ::text — never a JS Date, see getVariantBom's note. */
  effectivityDate: string | null
  effectivitySerial: string | null
}

/**
 * The transactional core. Takes the CALLER's transaction so it can either run
 * standalone (applyEcoEffectivity below) or be folded into the ECO status change
 * that makes the order `implemented` — one call, fully atomic with that move.
 *
 * Everything it touches is locked FOR UPDATE in a fixed order (eco → items →
 * BOM lines), so concurrent applies serialize rather than interleave, and the
 * per-item `applied_at` stamp makes the second one a no-op.
 *
 * ── THE APPROVAL RE-CHECK LIVES HERE, ON THE ACT ────────────────────────────
 * This function is where an ECO stops being a document and starts being a bill of
 * materials: it closes lines, opens lines, and reads `effectivity_date` /
 * `effectivity_serial` LIVE off the ECO rather than off any approval. Every fact
 * it uses can be edited after the approval that authorised it, and the ECO status
 * change — the only edge that used to be gated — happens two steps earlier.
 *
 * So the snapshot is re-checked HERE, after the ECO and its items are locked and
 * before a single BOM row is written. Putting it on `approved → implemented`
 * instead would gate a status label while leaving the rewrite ungated, and would
 * split `ecoTransitionRequiresApproval` into two predicates answering different
 * questions ("which edge needs approve_requests" vs "which edge needs a snapshot
 * re-check") — a design change that buys nothing this does not already cover.
 *
 * ORDER. The two BomApplyError preconditions run FIRST, deliberately, the same way
 * repairService runs its sign-off precondition ahead of its approval gate: "this
 * order is not implemented yet" and "this order has no effectivity point" are
 * facts about whether the apply makes sense at all, and answering them with "your
 * approval drifted" sends the reader to the wrong fix.
 */
export async function applyEcoEffectivityTx(
  tx: Tx, actorId: string, ecoId: string,
): Promise<ApplyEffectivityResult> {
  const { rows: ecoRows } = await tx.query<{
    id: string; status: string; effectivity_date: string | null; effectivity_serial: string | null
  }>(
    `SELECT id, status, effectivity_date::text AS effectivity_date, effectivity_serial
       FROM eco WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [ecoId])
  if (ecoRows.length === 0) throw new BomEcoNotFoundError(ecoId)
  const eco: EcoEffectivity = {
    id: ecoRows[0].id, status: ecoRows[0].status,
    effectivityDate: ecoRows[0].effectivity_date,
    effectivitySerial: ecoRows[0].effectivity_serial,
  }

  // Status is compared against the literal the eco CHECK constraint fences, not
  // a seeded vocabulary row — eco.status is a fixed platform vocabulary, unlike
  // device statuses (which are admin-editable and must always be resolved from
  // status_option).
  if (eco.status !== 'implemented') {
    throw new BomApplyError(
      'not_implemented',
      'A change order must be implemented before its BOM changes can be applied.')
  }
  if (!isUsableEffectivityPoint({ date: eco.effectivityDate, serial: eco.effectivitySerial })) {
    throw new BomApplyError(
      'no_effectivity_point',
      'Set an effectivity date or an effectivity serial on the change order first — without one there is no point at which the BOM changes.')
  }

  const { rows: items } = await tx.query<{
    id: string; variant_id: string; component_type_id: string
    disposition: Disposition; quantity: number | null; notes: string | null
    applied_at: Date | null
  }>(
    `SELECT id, variant_id, component_type_id, disposition, quantity, notes, applied_at
       FROM ec_affected_item
      WHERE eco_id = $1 AND deleted_at IS NULL
      ORDER BY created_at, id
        FOR UPDATE`, [eco.id])

  // The snapshot re-check, after both locks and before any write. It runs even
  // when every item is already stamped: `alreadyApplied` is still an answer about
  // this ECO's approved scope, and short-circuiting above it would make the gate's
  // presence depend on how far a previous crashed run happened to get.
  //
  // The projection it compares against is ecoService's, NOT the row set just read
  // here — that one is ordered for its own locking reasons and carries applied_at,
  // neither of which belongs in a snapshot. Two readers of one table, two jobs.
  await assertEcoApprovalInTx(tx, eco.id, 'applied to the BOM')

  const pending = items.filter((i) => i.applied_at === null)
  if (pending.length === 0) {
    return { ecoId: eco.id, itemsApplied: 0, linesOpened: 0, linesClosed: 0, alreadyApplied: true }
  }

  let linesOpened = 0
  let linesClosed = 0

  for (const item of pending) {
    // The still-open line for this (variant, component type), if any. The
    // predicate matches bom_line_open_unique exactly, so at most one row exists.
    const { rows: openLines } = await tx.query<{ id: string }>(
      `SELECT id FROM variant_bom_line
        WHERE variant_id = $1 AND component_type_id = $2 AND deleted_at IS NULL
          AND effective_to_date IS NULL AND effective_to_serial IS NULL
          FOR UPDATE`, [item.variant_id, item.component_type_id])
    const openLine = openLines[0] ?? null

    if (item.disposition === 'add' && openLine) {
      throw new BomApplyError(
        'already_on_bom',
        'This change order adds a component type the variant BOM already carries — use "change" instead.')
    }
    if (item.disposition !== 'add' && !openLine) {
      throw new BomApplyError(
        'not_on_bom',
        'This change order changes or removes a component type the variant BOM does not carry.')
    }

    // Close the outgoing line AT the effectivity point (exclusive upper bound).
    if (openLine) {
      await tx.query(
        `UPDATE variant_bom_line
            SET effective_to_date = $1, effective_to_serial = $2, superseded_by_eco_id = $3,
                updated_at = now(), updated_by = $4, version = version + 1
          WHERE id = $5`,
        [eco.effectivityDate, eco.effectivitySerial, eco.id, actorId, openLine.id])
      linesClosed++
    }

    // Open the incoming line AT the same point (inclusive lower bound). `remove`
    // has no successor — that is the whole point of it.
    if (item.disposition !== 'remove') {
      await tx.query(
        `INSERT INTO variant_bom_line
           (variant_id, component_type_id, quantity, notes,
            effective_from_date, effective_from_serial, created_by_eco_id,
            created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8)`,
        [item.variant_id, item.component_type_id, item.quantity, item.notes,
         eco.effectivityDate, eco.effectivitySerial, eco.id, actorId])
      linesOpened++
    }

    await tx.query(
      `UPDATE ec_affected_item
          SET applied_at = now(), applied_by = $1, updated_at = now(), updated_by = $1,
              version = version + 1
        WHERE id = $2`, [actorId, item.id])
  }

  return {
    ecoId: eco.id, itemsApplied: pending.length, linesOpened, linesClosed, alreadyApplied: false,
  }
}

const applySchema = z.object({ ecoId: z.string().uuid() })
export type ApplyEcoEffectivityInput = z.input<typeof applySchema>

/**
 * Standalone entry point: authorize FIRST (ahead of taking a connection), then
 * run the transactional core in one transaction of its own.
 */
export async function applyEcoEffectivity(
  actor: Actor, input: ApplyEcoEffectivityInput,
): Promise<ApplyEffectivityResult> {
  authorize(actor, 'edit_records', 'engineering')
  const data = applySchema.parse(input)
  return withTransaction(actor.id, (tx) => applyEcoEffectivityTx(tx, actor.id, data.ecoId))
}
