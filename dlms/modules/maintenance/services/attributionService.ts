import type { Tx } from '@/lib/db/tx'

/**
 * The same-device rule for maintenance attribution (spec §5.4).
 *
 * A `repair_id` / `modification_id` on another record is a TRACEABILITY CLAIM:
 * "this happened because of that". The FK proves only that the referenced row
 * exists — it says nothing about which device the row is for, so nothing stops
 * a component swap on device A being attributed to a repair on device B. Both
 * rows are perfectly real; the claim is still a lie, and in a medical-device
 * registry a lie in the traceability chain is the failure that matters.
 *
 * WHY THIS LIVES IN MAINTENANCE, AND WHY IT TAKES A `Tx`. `repair` and
 * `modification` are Maintenance's tables, so Manufacturing's §14 replacement
 * primitive must not query them directly — it calls in here instead. And the
 * check has to run INSIDE the caller's transaction, under the lock that already
 * established which device is involved: a check performed before the
 * transaction could be true when asked and false when written. So this is a
 * `Tx`-accepting internal, not a stand-alone service call — it opens no
 * transaction and performs no authorization of its own, because the caller has
 * already done both.
 */

export type AttributionKind = 'repair' | 'modification'
export type AttributionErrorCode = 'not_found' | 'device_mismatch'

// A CONSTANT map, never caller input — the interpolation below is safe
// precisely because the only reachable values are these two literals; the id
// itself is always a bound parameter. modificationService's REFERENCE_TABLE
// makes the same trade for the same reason.
const ATTRIBUTION_TABLE: Record<AttributionKind, string> = {
  repair: 'repair',
  modification: 'modification',
}

/**
 * ONE class with a `code` discriminant rather than two near-identical classes:
 * both failures are the same category of wrong (this link cannot be made) and a
 * caller that wants to branch precisely still can, on `kind` and `code`.
 */
export class InvalidAttributionError extends Error {
  readonly kind: AttributionKind
  readonly code: AttributionErrorCode
  readonly attributionId: string

  constructor(kind: AttributionKind, code: AttributionErrorCode, attributionId: string) {
    super(code === 'not_found'
      ? `That ${kind} no longer exists. Reload and try again.`
      : `That ${kind} is for a different device — records cannot be linked across devices.`)
    this.name = 'InvalidAttributionError'
    this.kind = kind
    this.code = code
    this.attributionId = attributionId
  }
}

/**
 * Asserts that `attributionId` names a LIVE repair/modification for `deviceId`.
 *
 * "Exists" means live everywhere else in this module (assertReferenceExists),
 * so a soft-deleted repair is refused exactly like an unknown id — attributing
 * new work to a deleted record would resurrect it in the traceability chain.
 *
 * Throws inside the caller's transaction, so a failed check rolls the entire
 * write back — the swap never half-happens.
 */
export async function assertSameDevice(
  tx: Tx, kind: AttributionKind, attributionId: string, deviceId: string,
): Promise<void> {
  const { rows } = await tx.query<{ device_id: string }>(
    `SELECT device_id FROM ${ATTRIBUTION_TABLE[kind]} WHERE id = $1 AND deleted_at IS NULL`,
    [attributionId])
  if (rows.length === 0) throw new InvalidAttributionError(kind, 'not_found', attributionId)
  if (rows[0].device_id !== deviceId) {
    throw new InvalidAttributionError(kind, 'device_mismatch', attributionId)
  }
}
