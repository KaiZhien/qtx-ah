/**
 * The pure half of stock-transfer posting: turn a transfer's lines into the
 * exact set of balance movements to apply, plus THE ORDER IN WHICH TO TAKE THE
 * ROW LOCKS. No I/O. See modules/logistics/services/stockTransferService.ts for
 * the transactional half that consumes this.
 *
 * ═══════════════════════════════════════════════════════════════════════════
 * TWO RULES LIVE HERE. BOTH LOOK LIKE TIDINESS. NEITHER IS.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * ── RULE 1: lock keys are globally sorted, never source-then-destination ────
 * `lockKeys` is sorted by (locationId, componentTypeId) across BOTH sides of
 * the transfer. It is tempting to read that sort as cosmetic and replace it
 * with the obvious "lock the source row, then the destination row" — that
 * ordering is a deadlock.
 *
 *   transfer 1: A -> B of component X     transfer 2: B -> A of component X
 *   locks (A,X) ... then waits on (B,X)   locks (B,X) ... then waits on (A,X)
 *
 * Both hold what the other needs; Postgres detects the cycle and aborts one at
 * random. It will not reproduce on a developer's machine and will absolutely
 * reproduce in a warehouse doing two-way rebalancing. Sorting globally means
 * every transaction in the system takes (A,X) before (B,X) regardless of which
 * direction it is moving, so the loser simply waits its turn.
 * `__tests__/platform/logistics/stockPosting.test.ts` pins this ("THE DEADLOCK
 * TEST"), and the integration suite proves it against real concurrent
 * transactions.
 *
 * The same reasoning extends across lock CLASSES: the service takes all
 * stock_level locks (in this order) and only then all component_unit locks (by
 * id). One total order over both classes, or the cycle just moves.
 *
 * ── RULE 2: quantities aggregate as scaled integers, never as floats ────────
 * qty is numeric(14,3) in Postgres. Summing lines as JS numbers reintroduces
 * binary floating point (0.1 + 0.2 = 0.30000000000000004) into a balance that
 * a CHECK constraint and an auditor both treat as exact. Aggregation here is in
 * integer thousandths, and the value handed to SQL is a fixed(3) STRING so
 * node-postgres passes it through as numeric text rather than a float.
 *
 * Scope of that claim, precisely: the CONVERSION boundary still receives a JS
 * double from the caller, because the input is a JSON number off a form. What
 * toScaledQty guarantees is that the conversion is decided by the double's
 * shortest round-tripping DECIMAL representation rather than by float
 * arithmetic — so it is exact at every magnitude, and a value the double cannot
 * represent to three places is REJECTED rather than silently rounded. Once past
 * that boundary no float touches a quantity again. Taking genuinely arbitrary
 * decimals end-to-end would mean accepting strings from the client, which is a
 * bigger change than this module.
 */

export class StockPostingError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StockPostingError'
  }
}

/** numeric(14,3) — three decimal places, matching the column definition. */
const SCALE = 3

/**
 * Convert a caller-supplied quantity into exact integer thousandths.
 * Rejects anything the column could not hold losslessly.
 *
 * Scales from the DECIMAL STRING, not from `qty * 1000`. An earlier version
 * multiplied in binary floating point and compared the result against an
 * ABSOLUTE 1e-6 tolerance; because representation error grows with magnitude,
 * that false-rejected legitimate values once they got large enough —
 * `16777216.001 * 1000` lands far enough from an integer to trip a fixed
 * epsilon, so a value with exactly three decimal places was reported as having
 * more than three. String(qty) is the shortest round-tripping decimal
 * representation of the double, so digit counting on it is exact at every
 * magnitude and needs no tolerance at all.
 */
export function toScaledQty(qty: number): number {
  if (!Number.isFinite(qty)) throw new StockPostingError(`Quantity must be a finite number, got ${qty}`)

  const text = String(qty)
  // Exponential notation only appears outside |n| < 1e21 / >= 1e-7, both of
  // which are already out of range for a numeric(14,3) stock quantity.
  if (text.includes('e') || text.includes('E')) {
    throw new StockPostingError(`Quantity ${qty} is outside the supported range`)
  }
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text)
  if (!m) throw new StockPostingError(`Quantity ${qty} is not a valid decimal`)

  const [, sign, intPart, fracPart = ''] = m
  if (fracPart.length > SCALE) {
    throw new StockPostingError(`Quantity ${qty} has more than three decimal places`)
  }

  const scaled = Number(`${intPart}${fracPart.padEnd(SCALE, '0')}`)
  if (!Number.isSafeInteger(scaled)) {
    throw new StockPostingError(`Quantity ${qty} is outside the supported range`)
  }
  return sign === '-' ? -scaled : scaled
}

/**
 * Back to the fixed(3) string form SQL should receive. Pure digit surgery —
 * dividing by 1000 would put the value back through a float on the way out.
 */
export function fromScaledQty(scaled: number): string {
  const negative = scaled < 0
  const digits = String(Math.abs(scaled)).padStart(SCALE + 1, '0')
  const intPart = digits.slice(0, -SCALE)
  const fracPart = digits.slice(-SCALE)
  return `${negative ? '-' : ''}${intPart}.${fracPart}`
}

export type StockLockKey = { locationId: string; componentTypeId: string }
export type StockMovement = StockLockKey & { scaledQty: number }

export type BatchTransferLine = { componentTypeId: string; qty: number }
export type SerializedTransferLine = { componentUnitId: string }

export type StockPostingPlan = {
  /** Rows to reduce, at the source location. Magnitudes are positive. */
  decrements: StockMovement[]
  /** Rows to raise, at the destination location. Magnitudes are positive. */
  increments: StockMovement[]
  /**
   * Every stock_level row the posting touches, deduped and in the ONE order
   * every transaction must take them. See RULE 1 above.
   */
  lockKeys: StockLockKey[]
  /** component_unit ids to relocate, sorted — the second lock class. */
  serializedUnitIds: string[]
}

/** Stable string form of a lock key, for dedup/compare and for test assertions. */
export function lockKeyOf(key: StockLockKey): string {
  return `${key.locationId}:${key.componentTypeId}`
}

/**
 * Total order over stock_level rows. Location dominates component type; the
 * pair is unique per row, so this is a strict total order with no ties between
 * distinct rows — which is exactly what a deadlock-free lock order requires.
 */
export function compareLockKeys(a: StockLockKey, b: StockLockKey): number {
  if (a.locationId !== b.locationId) return a.locationId < b.locationId ? -1 : 1
  if (a.componentTypeId !== b.componentTypeId) return a.componentTypeId < b.componentTypeId ? -1 : 1
  return 0
}

export function planStockPosting(input: {
  fromLocationId: string
  toLocationId: string
  batchLines: readonly BatchTransferLine[]
  serializedLines: readonly SerializedTransferLine[]
}): StockPostingPlan {
  const { fromLocationId, toLocationId, batchLines, serializedLines } = input

  if (fromLocationId === toLocationId) {
    throw new StockPostingError('A transfer cannot move stock to and from the same location')
  }
  if (batchLines.length === 0 && serializedLines.length === 0) {
    throw new StockPostingError('A transfer must have at least one line to post')
  }

  // Aggregate by component type FIRST. Two lines of the same type must become
  // one movement: posting them separately would take the same row lock twice
  // and test the zero-floor against a half-applied balance.
  const byType = new Map<string, number>()
  for (const line of batchLines) {
    const scaled = toScaledQty(line.qty)
    if (scaled <= 0) {
      throw new StockPostingError(`Transfer quantity must be greater than zero, got ${line.qty}`)
    }
    byType.set(line.componentTypeId, (byType.get(line.componentTypeId) ?? 0) + scaled)
  }

  const decrements: StockMovement[] = []
  const increments: StockMovement[] = []
  for (const [componentTypeId, scaledQty] of byType) {
    decrements.push({ locationId: fromLocationId, componentTypeId, scaledQty })
    increments.push({ locationId: toLocationId, componentTypeId, scaledQty })
  }

  const seenUnits = new Set<string>()
  for (const line of serializedLines) {
    if (seenUnits.has(line.componentUnitId)) {
      throw new StockPostingError(
        `Component unit ${line.componentUnitId} appears more than once in this transfer`)
    }
    seenUnits.add(line.componentUnitId)
  }

  // RULE 1. Dedup then sort — the single ordering every transaction obeys.
  const keyed = new Map<string, StockLockKey>()
  for (const m of [...decrements, ...increments]) {
    const key = { locationId: m.locationId, componentTypeId: m.componentTypeId }
    keyed.set(lockKeyOf(key), key)
  }
  const lockKeys = [...keyed.values()].sort(compareLockKeys)

  return {
    decrements,
    increments,
    lockKeys,
    serializedUnitIds: [...seenUnits].sort(),
  }
}
