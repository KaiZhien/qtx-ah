import { z } from 'zod'
import { withTransaction, OptimisticLockError, type Tx } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'
import { DeviceNotFoundError } from '@/modules/manufacturing/services/deviceWriteService'
import {
  describeWarranty, validateWarrantyPeriod, messageForWarrantyPeriodError,
  InvalidWarrantyPeriodError, EXPIRING_SOON_DAYS,
  type WarrantyStatus,
} from '@/modules/finance/domain/warrantyStatus'

export class WarrantyNotFoundError extends Error {
  constructor(warrantyId: string) {
    super(`Warranty ${warrantyId} not found`)
    this.name = 'WarrantyNotFoundError'
  }
}

/** One LIVE warranty per device (warranty_device_live_unique). Renew, don't add a second. */
export class DuplicateWarrantyError extends Error {
  constructor(deviceId: string) {
    super('That device already has a live warranty. Renew or edit the existing one instead.')
    this.name = 'DuplicateWarrantyError'
    this.deviceId = deviceId
  }
  readonly deviceId: string
}

// warranty_device_live_unique is a partial unique index (device_id WHERE
// deleted_at IS NULL) -> Postgres 23505. Same mapping shape as
// invoiceService.rethrowDbError.
function rethrowDbError(err: unknown, deviceId: string): never {
  if (err && typeof err === 'object' && 'code' in err && (err as { code: string }).code === '23505') {
    throw new DuplicateWarrantyError(deviceId)
  }
  throw err
}

export type WarrantyRecord = {
  id: string
  deviceId: string
  deviceSn: string | null
  /** 'YYYY-MM-DD'. Read as TEXT out of Postgres — see the SELECT comment. */
  startDate: string
  endDate: string
  terms: string | null
  /** DERIVED, never stored. See modules/finance/domain/warrantyStatus.ts. */
  status: WarrantyStatus
  daysRemaining: number
  /** start <= today <= end. A future-dated warranty is `active` but not in force. */
  inForce: boolean
  version: number
  createdAt: Date
  /** Non-null on superseded rows (history), null on the live one. */
  supersededAt: Date | null
}

/**
 * Dates are selected as ::text, NOT as `date`.
 *
 * node-postgres parses a `date` column into a JS Date at LOCAL midnight, so on
 * any host west of UTC `toISOString().slice(0,10)` hands back the previous day
 * and a warranty silently expires 24 h early. LOGISTICS shipped and then fixed
 * exactly this (commit 6b36485). Keeping the value as the string Postgres
 * already formatted removes the conversion entirely, and the pure domain takes
 * 'YYYY-MM-DD' strings for the same reason.
 *
 * `current_date::text AS today` comes from the same statement so the derived
 * status is computed against the DATABASE's clock, not the web server's.
 */
const WARRANTY_SELECT = `
  SELECT w.id, w.device_id, d.device_sn,
         w.start_date::text AS start_date, w.end_date::text AS end_date,
         w.terms, w.version, w.created_at, w.deleted_at,
         current_date::text AS today
    FROM warranty w JOIN device d ON d.id = w.device_id`

type WarrantyRow = {
  id: string; device_id: string; device_sn: string | null
  start_date: string; end_date: string; terms: string | null
  version: number; created_at: Date; deleted_at: Date | null; today: string
}

function toRecord(r: WarrantyRow): WarrantyRecord {
  const described = describeWarranty({ startDate: r.start_date, endDate: r.end_date }, r.today)
  return {
    id: r.id, deviceId: r.device_id, deviceSn: r.device_sn,
    startDate: r.start_date, endDate: r.end_date, terms: r.terms,
    status: described.status, daysRemaining: described.daysRemaining!, inForce: described.inForce,
    version: r.version, createdAt: r.created_at, supersededAt: r.deleted_at,
  }
}

// ───────────────────────────── reads ─────────────────────────────
//
// Gated on `view_records` within the finance module, NOT on `view_finance`.
// Deliberate: view_finance is the MONEY gate (spec §3.2 — a Viewer never holds
// it even with Finance module access, and D12 makes that page-level gate the
// whole masking story for amounts). Warranty dates are not money — they are the
// service-entitlement fact a technician needs before quoting a repair. Gating
// them behind view_finance would hide warranty cover from every Viewer and from
// Operators, which is the wrong failure. The buyer's identity is NOT in any
// payload here precisely because that IS behind view_buyer_details.

/** The one live warranty for a device, or null. Null is also the "no cover" answer. */
export async function getDeviceWarranty(
  actor: Actor, deviceId: string,
): Promise<WarrantyRecord | null> {
  authorize(actor, 'view_records', 'finance')
  const id = z.string().uuid().safeParse(deviceId)
  if (!id.success) return null

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<WarrantyRow>(
      `${WARRANTY_SELECT} WHERE w.device_id = $1 AND w.deleted_at IS NULL`, [id.data])
    return rows[0] ? toRecord(rows[0]) : null
  })
}

/**
 * Every warranty ever recorded for a device, newest first — the live one plus
 * each superseded predecessor. This is the payoff for renewing by
 * supersede-and-insert rather than editing dates in place: what was promised at
 * sale time is still readable after two renewals.
 */
export async function listDeviceWarrantyHistory(
  actor: Actor, deviceId: string,
): Promise<WarrantyRecord[]> {
  authorize(actor, 'view_records', 'finance')
  const id = z.string().uuid().safeParse(deviceId)
  if (!id.success) return []

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<WarrantyRow>(
      `${WARRANTY_SELECT} WHERE w.device_id = $1 ORDER BY w.created_at DESC, w.id DESC`, [id.data])
    return rows.map(toRecord)
  })
}

export const EXPIRY_WINDOWS = [30, 60, 90] as const
export type ExpiryWindow = (typeof EXPIRY_WINDOWS)[number]

export type ExpiringWarrantyItem = {
  warrantyId: string
  deviceId: string
  deviceSn: string | null
  startDate: string
  endDate: string
  daysRemaining: number
  status: WarrantyStatus
}

const expiringSchema = z.object({
  withinDays: z.union([z.literal(30), z.literal(60), z.literal(90)]).default(30),
  limit: z.number().int().min(1).max(200).default(50),
})
export type ExpiringWarrantyFilter = z.input<typeof expiringSchema>

/**
 * The expiry radar (spec §8.5 "warranties expiring 30/60/90 d"). Soonest first.
 *
 * EXCLUDES already-expired warranties: this list is a call-to-action ("renew
 * these"), and mixing in rows whose window closed months ago makes it one. Ask
 * getWarrantyExpiryCounts for the expired tally.
 *
 * The window is compared in SQL against `current_date` so the cutoff is the
 * database's day, matching the status the same row reports.
 */
export async function getExpiringWarranties(
  actor: Actor, options: ExpiringWarrantyFilter = {},
): Promise<ExpiringWarrantyItem[]> {
  authorize(actor, 'view_records', 'finance')
  const f = expiringSchema.parse(options)

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<WarrantyRow>(
      `${WARRANTY_SELECT}
        WHERE w.deleted_at IS NULL
          AND w.end_date >= current_date
          AND w.end_date <= current_date + ($1::int * INTERVAL '1 day')
        ORDER BY w.end_date ASC, d.device_sn ASC NULLS LAST, w.id ASC
        LIMIT $2`, [f.withinDays, f.limit])

    return rows.map((r) => {
      const rec = toRecord(r)
      return {
        warrantyId: rec.id, deviceId: rec.deviceId, deviceSn: rec.deviceSn,
        startDate: rec.startDate, endDate: rec.endDate,
        daysRemaining: rec.daysRemaining, status: rec.status,
      }
    })
  })
}

export type WarrantyExpiryCounts = {
  /** CUMULATIVE: within30 ⊆ within60 ⊆ within90. All exclude already-expired rows. */
  within30: number
  within60: number
  within90: number
  /** Already past end_date. */
  expired: number
  /** Every non-expired live warranty, including the expiring ones. */
  active: number
}

/**
 * One grouped query behind the Finance landing tiles and the §8.5 dashboard.
 * Deliberately a single statement — four round trips for four numbers is how a
 * dashboard becomes slow.
 *
 * The buckets are CUMULATIVE, not disjoint: "expiring within 90 days" means
 * exactly that, and a caller who wants the 61-90 band subtracts. Disjoint
 * buckets read fine on a chart and wrong in a sentence.
 */
export async function getWarrantyExpiryCounts(actor: Actor): Promise<WarrantyExpiryCounts> {
  authorize(actor, 'view_records', 'finance')

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<Record<string, string>>(
      `SELECT
         count(*) FILTER (WHERE end_date >= current_date
                            AND end_date <= current_date + INTERVAL '30 days')::text AS within30,
         count(*) FILTER (WHERE end_date >= current_date
                            AND end_date <= current_date + INTERVAL '60 days')::text AS within60,
         count(*) FILTER (WHERE end_date >= current_date
                            AND end_date <= current_date + INTERVAL '90 days')::text AS within90,
         count(*) FILTER (WHERE end_date <  current_date)::text AS expired,
         count(*) FILTER (WHERE end_date >= current_date)::text AS active
       FROM warranty WHERE deleted_at IS NULL`)
    const r = rows[0]
    return {
      within30: Number(r.within30), within60: Number(r.within60), within90: Number(r.within90),
      expired: Number(r.expired), active: Number(r.active),
    }
  })
}

// ───────────────────────────── writes ─────────────────────────────

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')

const createSchema = z.object({
  deviceId: z.string().uuid(),
  startDate: DATE,
  endDate: DATE,
  terms: z.string().max(5000).optional(),
})
export type CreateWarrantyInput = z.input<typeof createSchema>

/** Zod cannot express "end >= start"; the pure domain owns that rule (and the DB CHECK backs it). */
function assertPeriod(startDate: string, endDate: string): void {
  const decision = validateWarrantyPeriod(startDate, endDate)
  if (!decision.ok) {
    throw new InvalidWarrantyPeriodError(decision.error, messageForWarrantyPeriodError(decision.error))
  }
}

/** Locks the device row so a concurrent soft-delete can't slip a warranty onto a dead device. */
async function requireLiveDevice(tx: Tx, deviceId: string): Promise<void> {
  const { rows } = await tx.query<{ id: string }>(
    `SELECT id FROM device WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [deviceId])
  if (rows.length === 0) throw new DeviceNotFoundError(deviceId)
}

/**
 * Register the warranty for a device. Fails if one is already live — renewal is
 * `renewWarranty`, not a second row, because the partial unique index enforces
 * one live warranty per device and silently replacing the existing one here
 * would hide a data-entry mistake.
 *
 * authorize() runs FIRST, ahead of taking a pool connection — the ordering
 * prepareStatusChange established and __tests__ pin.
 */
export async function createWarranty(
  actor: Actor, input: CreateWarrantyInput,
): Promise<{ warrantyId: string }> {
  authorize(actor, 'manage_finance', 'finance')
  const data = createSchema.parse(input)
  assertPeriod(data.startDate, data.endDate)

  return withTransaction(actor.id, async (tx) => {
    await requireLiveDevice(tx, data.deviceId)
    try {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO warranty (device_id, start_date, end_date, terms, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$5) RETURNING id`,
        [data.deviceId, data.startDate, data.endDate, data.terms ?? null, actor.id])
      return { warrantyId: rows[0].id }
    } catch (err) {
      rethrowDbError(err, data.deviceId)
    }
  })
}

const updateSchema = z.object({
  warrantyId: z.string().uuid(),
  version: z.number().int().nonnegative(),
  startDate: DATE.optional(),
  endDate: DATE.optional(),
  terms: z.string().max(5000).nullish(),
})
export type UpdateWarrantyInput = z.input<typeof updateSchema>

/**
 * CORRECT a warranty in place — a typo'd date, missing terms text.
 *
 * NOT the way to extend cover: an in-place date change destroys the evidence of
 * what was actually promised at sale time. Use renewWarranty for an extension
 * or a renewal (see the warranty.deleted_at column comment).
 */
export async function updateWarranty(
  actor: Actor, input: UpdateWarrantyInput,
): Promise<{ version: number }> {
  authorize(actor, 'manage_finance', 'finance')
  const data = updateSchema.parse(input)

  return withTransaction(actor.id, async (tx) => {
    const { rows: cur } = await tx.query<{ start_date: string; end_date: string; version: number }>(
      `SELECT start_date::text AS start_date, end_date::text AS end_date, version
         FROM warranty WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [data.warrantyId])
    if (cur.length === 0) throw new WarrantyNotFoundError(data.warrantyId)
    if (cur[0].version !== data.version) throw new OptimisticLockError('warranty', data.warrantyId)

    // Validate the RESULTING period, not just the supplied fields: changing only
    // end_date can still invert the range against the stored start_date.
    assertPeriod(data.startDate ?? cur[0].start_date, data.endDate ?? cur[0].end_date)

    const sets: string[] = []
    const params: unknown[] = []
    const p = (v: unknown) => { params.push(v); return `$${params.length}` }
    if (data.startDate !== undefined) sets.push(`start_date = ${p(data.startDate)}`)
    if (data.endDate !== undefined) sets.push(`end_date = ${p(data.endDate)}`)
    if (data.terms !== undefined) sets.push(`terms = ${p(data.terms)}`)

    const setSql = [...sets, `updated_at = now()`, `updated_by = ${p(actor.id)}`,
                    `version = version + 1`].join(', ')
    const { rows } = await tx.query<{ version: number }>(
      `UPDATE warranty SET ${setSql}
        WHERE id = ${p(data.warrantyId)} AND version = ${p(data.version)} RETURNING version`, params)
    if (rows.length === 0) throw new OptimisticLockError('warranty', data.warrantyId)
    return { version: rows[0].version }
  })
}

const renewSchema = z.object({
  warrantyId: z.string().uuid(),
  version: z.number().int().nonnegative(),
  startDate: DATE,
  endDate: DATE,
  terms: z.string().max(5000).optional(),
})
export type RenewWarrantyInput = z.input<typeof renewSchema>

/**
 * Renew/extend: supersede the current warranty and insert its successor in ONE
 * transaction.
 *
 * WHY A NEW ROW RATHER THAN EDITING THE DATES (the spec §6.3 "device FK unique"
 * question, decided here):
 *   - A warranty is a COMMERCIAL COMMITMENT. Overwriting end_date erases the
 *     record of what was promised at sale, which is the one thing a dispute
 *     turns on. audit_log would still hold the diff, but "reconstruct it from
 *     the audit trail" is not a feature — it is an admission the model is lossy.
 *   - Renewals are genuinely separate agreements with their own terms text.
 *   - The cost is that "device FK unique" becomes a PARTIAL unique index
 *     (device_id WHERE deleted_at IS NULL). That is the honest encoding of the
 *     invariant that actually matters — ONE LIVE warranty per device — and the
 *     migration says so.
 *
 * The old row is soft-deleted, so it keeps showing in listDeviceWarrantyHistory
 * and stops colliding with the new one on the unique index. Both statements are
 * in one transaction: a crash between them cannot leave a device with zero
 * warranties or two.
 */
export async function renewWarranty(
  actor: Actor, input: RenewWarrantyInput,
): Promise<{ warrantyId: string }> {
  authorize(actor, 'manage_finance', 'finance')
  const data = renewSchema.parse(input)
  assertPeriod(data.startDate, data.endDate)

  return withTransaction(actor.id, async (tx) => {
    const { rows: cur } = await tx.query<{ device_id: string; version: number }>(
      `SELECT device_id, version FROM warranty
        WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`, [data.warrantyId])
    if (cur.length === 0) throw new WarrantyNotFoundError(data.warrantyId)
    if (cur[0].version !== data.version) throw new OptimisticLockError('warranty', data.warrantyId)

    const { rowCount } = await tx.query(
      `UPDATE warranty SET deleted_at = now(), updated_at = now(), updated_by = $1,
                           version = version + 1
        WHERE id = $2 AND version = $3`, [actor.id, data.warrantyId, data.version])
    if (rowCount === 0) throw new OptimisticLockError('warranty', data.warrantyId)

    try {
      const { rows } = await tx.query<{ id: string }>(
        `INSERT INTO warranty (device_id, start_date, end_date, terms, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$5) RETURNING id`,
        [cur[0].device_id, data.startDate, data.endDate, data.terms ?? null, actor.id])
      return { warrantyId: rows[0].id }
    } catch (err) {
      rethrowDbError(err, cur[0].device_id)
    }
  })
}

const removeSchema = z.object({
  warrantyId: z.string().uuid(),
  version: z.number().int().nonnegative(),
})
export type RemoveWarrantyInput = z.input<typeof removeSchema>

/**
 * Soft-delete a warranty recorded in error. The device falls back to `none` —
 * NOT to an inferred window (see the migration header on the legacy
 * ship_date + 2 years generated column).
 *
 * Gated on manage_finance rather than delete_records: this removes a commercial
 * commitment from the books, which is a finance act, and delete_records is held
 * by roles (Operator via Manager) that have no business retracting one.
 */
export async function removeWarranty(
  actor: Actor, input: RemoveWarrantyInput,
): Promise<void> {
  authorize(actor, 'manage_finance', 'finance')
  const data = removeSchema.parse(input)

  await withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ version: number }>(
      `SELECT version FROM warranty WHERE id = $1 AND deleted_at IS NULL FOR UPDATE`,
      [data.warrantyId])
    if (rows.length === 0) throw new WarrantyNotFoundError(data.warrantyId)
    if (rows[0].version !== data.version) throw new OptimisticLockError('warranty', data.warrantyId)

    const { rowCount } = await tx.query(
      `UPDATE warranty SET deleted_at = now(), updated_at = now(), updated_by = $1,
                           version = version + 1
        WHERE id = $2 AND version = $3`, [actor.id, data.warrantyId, data.version])
    if (rowCount === 0) throw new OptimisticLockError('warranty', data.warrantyId)
  })
}

export { EXPIRING_SOON_DAYS }
