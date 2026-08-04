import { z } from 'zod'
import { withTransaction, OptimisticLockError } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'
import { ECR_INITIAL_STATUS, isValidEcrTransition } from '@/modules/engineering/domain/ecrStatus'
import {
  ECO_INITIAL_STATUS, isValidEcoTransition, ecoTransitionRequiresApproval,
} from '@/modules/engineering/domain/ecoStatus'
import { FIRMWARE_INITIAL_STATUS, isValidFirmwareTransition } from '@/modules/engineering/domain/firmwareStatus'
import { InvalidTransitionError } from '@/modules/engineering/domain/transition'
import {
  assertEcoApprovalInTx, assertEcoScopeEditableInTx,
} from '@/modules/engineering/services/ecoService'

/**
 * Engineering write paths (spec §4/§7.5). Every entry point:
 *   1. authorize(...) on the FIRST line — the choke point (spec §3.2);
 *   2. runs inside ONE withTransaction(actor.id, ...) so fn_audit attributes
 *      the write and a throw rolls everything back;
 *   3. bumps `version` explicitly (optimistic lock) — never a trigger.
 *
 * Status changes are validated through the pure domain (fail-closed). The one
 * approval gate in basic scope is ECO submitted→approved, which additionally
 * requires approve_requests; every other move needs only edit_records.
 */

export class RecordNotFoundError extends Error {
  readonly entity: string
  readonly id: string
  constructor(entity: string, id: string) {
    super(`${entity} ${id} not found`)
    this.name = 'RecordNotFoundError'
    this.entity = entity
    this.id = id
  }
}

export class DuplicateFirmwareError extends Error {
  constructor(fwVersion: string) {
    super(`A firmware release "${fwVersion}" already exists for that component type`)
    this.name = 'DuplicateFirmwareError'
  }
}

function isPgCode(err: unknown, code: string): boolean {
  return !!err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === code
}

// Builds a partial SET clause: only keys present (and not undefined) in `data`
// are written, so omitting a field leaves it untouched while an explicit null
// clears it (matches updateDevice's semantics).
function buildSet(
  data: Record<string, unknown>, columns: Record<string, string>,
  p: (v: unknown) => string,
): string[] {
  const sets: string[] = []
  for (const [key, col] of Object.entries(columns)) {
    if (key in data && data[key] !== undefined) sets.push(`${col} = ${p(data[key])}`)
  }
  return sets
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
const PRIORITY = z.enum(['low', 'normal', 'high', 'urgent'])

// ═══════════════════════════ ECR ═══════════════════════════════════════════
const createEcrSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  reason: z.string().max(2000).optional(),
  priority: PRIORITY.default('normal'),
  deviceId: z.string().uuid().optional(),
  variantId: z.string().uuid().optional(),
})
export type CreateEcrInput = z.input<typeof createEcrSchema>

export async function createEcr(
  actor: Actor, input: CreateEcrInput,
): Promise<{ id: string; ecrNo: string }> {
  authorize(actor, 'create_records', 'engineering')
  const data = createEcrSchema.parse(input)
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ id: string; ecr_no: string }>(
      `INSERT INTO ecr (title, description, reason, priority, status, device_id, variant_id,
                        created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id, ecr_no`,
      [data.title, data.description ?? null, data.reason ?? null, data.priority,
       ECR_INITIAL_STATUS, data.deviceId ?? null, data.variantId ?? null, actor.id])
    return { id: rows[0].id, ecrNo: rows[0].ecr_no }
  })
}

const updateEcrSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().nonnegative(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullish(),
  reason: z.string().max(2000).nullish(),
  priority: PRIORITY.optional(),
  deviceId: z.string().uuid().nullish(),
  variantId: z.string().uuid().nullish(),
})
export type UpdateEcrInput = z.input<typeof updateEcrSchema>

// status is deliberately absent: it moves ONLY through changeEcrStatus so the
// transition graph and audit trail can never be bypassed.
const ECR_UPDATE_COLUMNS = {
  title: 'title', description: 'description', reason: 'reason',
  priority: 'priority', deviceId: 'device_id', variantId: 'variant_id',
} as const

export async function updateEcr(actor: Actor, input: UpdateEcrInput): Promise<{ version: number }> {
  authorize(actor, 'edit_records', 'engineering')
  const data = updateEcrSchema.parse(input)
  return withTransaction(actor.id, async (tx) => {
    const cur = await tx.query<{ version: number }>(
      `SELECT version FROM ecr WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [data.id])
    if (cur.rows.length === 0) throw new RecordNotFoundError('ECR', data.id)
    if (cur.rows[0].version !== data.version) throw new OptimisticLockError('ecr', data.id)

    const params: unknown[] = []
    const p = (v: unknown) => { params.push(v); return `$${params.length}` }
    const sets = buildSet(data as Record<string, unknown>, ECR_UPDATE_COLUMNS, p)
    const setSql = [...sets, `updated_at = now()`, `updated_by = ${p(actor.id)}`,
                    `version = version + 1`].join(', ')
    const { rows } = await tx.query<{ version: number }>(
      `UPDATE ecr SET ${setSql} WHERE id = ${p(data.id)} AND version = ${p(data.version)}
        RETURNING version`, params)
    if (rows.length === 0) throw new OptimisticLockError('ecr', data.id)
    return { version: rows[0].version }
  })
}

const changeEcrStatusSchema = z.object({
  id: z.string().uuid(), version: z.number().int().nonnegative(), toStatus: z.string().min(1).max(50),
})
export type ChangeEcrStatusInput = z.input<typeof changeEcrStatusSchema>

export async function changeEcrStatus(
  actor: Actor, input: ChangeEcrStatusInput,
): Promise<{ status: string; version: number }> {
  authorize(actor, 'edit_records', 'engineering')
  const data = changeEcrStatusSchema.parse(input)
  return withTransaction(actor.id, async (tx) => {
    const cur = await tx.query<{ status: string; version: number }>(
      `SELECT status, version FROM ecr WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [data.id])
    if (cur.rows.length === 0) throw new RecordNotFoundError('ECR', data.id)
    if (cur.rows[0].version !== data.version) throw new OptimisticLockError('ecr', data.id)
    if (!isValidEcrTransition(cur.rows[0].status, data.toStatus)) {
      throw new InvalidTransitionError('ECR', cur.rows[0].status, data.toStatus)
    }
    const { rows } = await tx.query<{ version: number }>(
      `UPDATE ecr SET status=$1, updated_at=now(), updated_by=$2, version=version+1
        WHERE id=$3 AND version=$4 RETURNING version`,
      [data.toStatus, actor.id, data.id, data.version])
    if (rows.length === 0) throw new OptimisticLockError('ecr', data.id)
    return { status: data.toStatus, version: rows[0].version }
  })
}

// ═══════════════════════════ ECO ═══════════════════════════════════════════
const createEcoSchema = z.object({
  title: z.string().min(1).max(200),
  description: z.string().max(5000).optional(),
  ecrId: z.string().uuid().optional(),
  effectivityDate: DATE.optional(),
  effectivitySerial: z.string().max(200).optional(),
  effectivityNotes: z.string().max(5000).optional(),
})
export type CreateEcoInput = z.input<typeof createEcoSchema>

export async function createEco(
  actor: Actor, input: CreateEcoInput,
): Promise<{ id: string; ecoNo: string }> {
  authorize(actor, 'create_records', 'engineering')
  const data = createEcoSchema.parse(input)
  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ id: string; eco_no: string }>(
      `INSERT INTO eco (title, description, ecr_id, status, effectivity_date, effectivity_serial,
                        effectivity_notes, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$8) RETURNING id, eco_no`,
      [data.title, data.description ?? null, data.ecrId ?? null, ECO_INITIAL_STATUS,
       data.effectivityDate ?? null, data.effectivitySerial ?? null,
       data.effectivityNotes ?? null, actor.id])
    return { id: rows[0].id, ecoNo: rows[0].eco_no }
  })
}

const updateEcoSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().nonnegative(),
  title: z.string().min(1).max(200).optional(),
  description: z.string().max(5000).nullish(),
  ecrId: z.string().uuid().nullish(),
  effectivityDate: DATE.nullish(),
  effectivitySerial: z.string().max(200).nullish(),
  effectivityNotes: z.string().max(5000).nullish(),
})
export type UpdateEcoInput = z.input<typeof updateEcoSchema>

const ECO_UPDATE_COLUMNS = {
  title: 'title', description: 'description', ecrId: 'ecr_id',
  effectivityDate: 'effectivity_date', effectivitySerial: 'effectivity_serial',
  effectivityNotes: 'effectivity_notes',
} as const

/**
 * Edit an ECO's content.
 *
 * THE APPROVAL SCOPE LOCK. `effectivity_date` and `effectivity_serial` are read
 * LIVE by `applyEcoEffectivityTx` at the moment it rewrites the BOM — not from the
 * approval, not from the status change — so an ECO approved for
 * "EE-02A-2603-0001 to 0015" and edited to "0001 to 0900" while approved lands the
 * rewrite on the wider range. Every other column here is in the approval snapshot
 * for the same reason. So once an approval has been acted on the content is frozen:
 * `assertEcoScopeEditableInTx` refuses, under the row lock taken just above, so a
 * concurrent approval cannot slip in between the check and the UPDATE.
 *
 * An ECO with NO approval request is untouched by this — "requested ⇒ binding",
 * the posture the whole consumer migration shipped on — and so is a submitted one,
 * whose edits are still re-checked at submitted → approved.
 */
export async function updateEco(actor: Actor, input: UpdateEcoInput): Promise<{ version: number }> {
  authorize(actor, 'edit_records', 'engineering')
  const data = updateEcoSchema.parse(input)
  return withTransaction(actor.id, async (tx) => {
    const cur = await tx.query<{ status: string; version: number }>(
      `SELECT status, version FROM eco WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [data.id])
    if (cur.rows.length === 0) throw new RecordNotFoundError('ECO', data.id)
    if (cur.rows[0].version !== data.version) throw new OptimisticLockError('eco', data.id)
    // AFTER the version check: a stale screen should be told to reload, not told
    // the record is frozen — the second sentence is only true for the current one.
    await assertEcoScopeEditableInTx(tx, data.id, cur.rows[0].status)

    const params: unknown[] = []
    const p = (v: unknown) => { params.push(v); return `$${params.length}` }
    const sets = buildSet(data as Record<string, unknown>, ECO_UPDATE_COLUMNS, p)
    const setSql = [...sets, `updated_at = now()`, `updated_by = ${p(actor.id)}`,
                    `version = version + 1`].join(', ')
    const { rows } = await tx.query<{ version: number }>(
      `UPDATE eco SET ${setSql} WHERE id = ${p(data.id)} AND version = ${p(data.version)}
        RETURNING version`, params)
    if (rows.length === 0) throw new OptimisticLockError('eco', data.id)
    return { version: rows[0].version }
  })
}

const changeEcoStatusSchema = z.object({
  id: z.string().uuid(), version: z.number().int().nonnegative(), toStatus: z.string().min(1).max(50),
})
export type ChangeEcoStatusInput = z.input<typeof changeEcoStatusSchema>

/**
 * Move an ECO through its status flow. The submitted→approved step is the one
 * approval gate in basic scope: it demands approve_requests IN ADDITION to the
 * edit_records every move needs. That second authorize() runs BEFORE
 * withTransaction opens, not inside it — which is fine, since it throws
 * before the transaction starts, so a denied approval still writes nothing.
 *
 * TWO GATES ON THAT EDGE, answering different questions (see ecoService.ts):
 * `approve_requests` asks MAY THIS PERSON approve; `assertEcoApprovalInTx` asks
 * IS THIS THE CHANGE THAT WAS AGREED TO — re-checking the immutable snapshot of
 * any approval request raised for this ECO against the row as locked here, and
 * refusing on drift with the field and both values named. The permission check is
 * unchanged and is NOT replaced by the engine; both must hold.
 *
 * The snapshot check runs INSIDE the transaction, under the same FOR UPDATE that
 * the UPDATE below writes through, so nothing can edit the ECO between the check
 * and the write. Where no approval was ever requested it is a no-op and this edge
 * behaves exactly as it always has.
 */
export async function changeEcoStatus(
  actor: Actor, input: ChangeEcoStatusInput,
): Promise<{ status: string; version: number }> {
  authorize(actor, 'edit_records', 'engineering')
  const data = changeEcoStatusSchema.parse(input)
  const gated = ecoTransitionRequiresApproval(data.toStatus)
  if (gated) {
    authorize(actor, 'approve_requests', 'engineering')
  }
  return withTransaction(actor.id, async (tx) => {
    const cur = await tx.query<{ status: string; version: number }>(
      `SELECT status, version FROM eco WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [data.id])
    if (cur.rows.length === 0) throw new RecordNotFoundError('ECO', data.id)
    if (cur.rows[0].version !== data.version) throw new OptimisticLockError('eco', data.id)
    if (!isValidEcoTransition(cur.rows[0].status, data.toStatus)) {
      throw new InvalidTransitionError('ECO', cur.rows[0].status, data.toStatus)
    }
    // AFTER the transition check: an illegal move should say it is illegal, not
    // that its approval drifted — that would send the reader to the wrong fix.
    if (gated) await assertEcoApprovalInTx(tx, data.id)
    const { rows } = await tx.query<{ version: number }>(
      `UPDATE eco SET status=$1, updated_at=now(), updated_by=$2, version=version+1
        WHERE id=$3 AND version=$4 RETURNING version`,
      [data.toStatus, actor.id, data.id, data.version])
    if (rows.length === 0) throw new OptimisticLockError('eco', data.id)
    return { status: data.toStatus, version: rows[0].version }
  })
}

// ══════════════════════ Firmware releases ══════════════════════════════════
const createFirmwareSchema = z.object({
  componentTypeId: z.string().uuid(),
  fwVersion: z.string().min(1).max(100),
  releaseDate: DATE.optional(),
  changelog: z.string().max(10000).optional(),
})
export type CreateFirmwareInput = z.input<typeof createFirmwareSchema>

export async function createFirmwareRelease(
  actor: Actor, input: CreateFirmwareInput,
): Promise<{ id: string }> {
  authorize(actor, 'create_records', 'engineering')
  const data = createFirmwareSchema.parse(input)
  return withTransaction(actor.id, async (tx) => {
    try {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO firmware_release (component_type_id, fw_version, release_date, changelog,
                                       status, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$6) RETURNING id`,
        [data.componentTypeId, data.fwVersion, data.releaseDate ?? null,
         data.changelog ?? null, FIRMWARE_INITIAL_STATUS, actor.id])
      return { id: rows[0].id }
    } catch (err) {
      if (isPgCode(err, '23505')) throw new DuplicateFirmwareError(data.fwVersion)
      throw err
    }
  })
}

const updateFirmwareSchema = z.object({
  id: z.string().uuid(),
  version: z.number().int().nonnegative(),
  fwVersion: z.string().min(1).max(100).optional(),
  releaseDate: DATE.nullish(),
  changelog: z.string().max(10000).nullish(),
})
export type UpdateFirmwareInput = z.input<typeof updateFirmwareSchema>

const FIRMWARE_UPDATE_COLUMNS = {
  fwVersion: 'fw_version', releaseDate: 'release_date', changelog: 'changelog',
} as const

export async function updateFirmwareRelease(
  actor: Actor, input: UpdateFirmwareInput,
): Promise<{ version: number }> {
  authorize(actor, 'edit_records', 'engineering')
  const data = updateFirmwareSchema.parse(input)
  return withTransaction(actor.id, async (tx) => {
    const cur = await tx.query<{ version: number }>(
      `SELECT version FROM firmware_release WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [data.id])
    if (cur.rows.length === 0) throw new RecordNotFoundError('Firmware release', data.id)
    if (cur.rows[0].version !== data.version) throw new OptimisticLockError('firmware_release', data.id)

    const params: unknown[] = []
    const p = (v: unknown) => { params.push(v); return `$${params.length}` }
    const sets = buildSet(data as Record<string, unknown>, FIRMWARE_UPDATE_COLUMNS, p)
    const setSql = [...sets, `updated_at = now()`, `updated_by = ${p(actor.id)}`,
                    `version = version + 1`].join(', ')
    try {
      const { rows } = await tx.query<{ version: number }>(
        `UPDATE firmware_release SET ${setSql} WHERE id = ${p(data.id)} AND version = ${p(data.version)}
          RETURNING version`, params)
      if (rows.length === 0) throw new OptimisticLockError('firmware_release', data.id)
      return { version: rows[0].version }
    } catch (err) {
      if (isPgCode(err, '23505')) throw new DuplicateFirmwareError(data.fwVersion ?? '')
      throw err
    }
  })
}

const changeFirmwareStatusSchema = z.object({
  id: z.string().uuid(), version: z.number().int().nonnegative(), toStatus: z.string().min(1).max(50),
})
export type ChangeFirmwareStatusInput = z.input<typeof changeFirmwareStatusSchema>

export async function changeFirmwareStatus(
  actor: Actor, input: ChangeFirmwareStatusInput,
): Promise<{ status: string; version: number }> {
  authorize(actor, 'edit_records', 'engineering')
  const data = changeFirmwareStatusSchema.parse(input)
  return withTransaction(actor.id, async (tx) => {
    const cur = await tx.query<{ status: string; version: number }>(
      `SELECT status, version FROM firmware_release WHERE id=$1 AND deleted_at IS NULL FOR UPDATE`, [data.id])
    if (cur.rows.length === 0) throw new RecordNotFoundError('Firmware release', data.id)
    if (cur.rows[0].version !== data.version) throw new OptimisticLockError('firmware_release', data.id)
    if (!isValidFirmwareTransition(cur.rows[0].status, data.toStatus)) {
      throw new InvalidTransitionError('firmware release', cur.rows[0].status, data.toStatus)
    }
    const { rows } = await tx.query<{ version: number }>(
      `UPDATE firmware_release SET status=$1, updated_at=now(), updated_by=$2, version=version+1
        WHERE id=$3 AND version=$4 RETURNING version`,
      [data.toStatus, actor.id, data.id, data.version])
    if (rows.length === 0) throw new OptimisticLockError('firmware_release', data.id)
    return { status: data.toStatus, version: rows[0].version }
  })
}
