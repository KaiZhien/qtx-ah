/**
 * Usage readings (spec §6.3) as pure derivation — no I/O, no clock. The service
 * loads a device's `usage_record` rows and hands them here.
 *
 * WHAT A READING IS. `cumulative_sessions` is the number the machine's own
 * counter displayed on `recorded_on`. It is an ODOMETER, not an increment: two
 * readings of 500 and 620 describe 120 sessions between them, and the row itself
 * never says "120".
 *
 * ═══ WHY THE RESET FLAG IS DERIVED AT READ TIME AND NEVER STORED ═══
 *
 * Spec §6.3 says a lower reading than the previous one is ACCEPTED with a
 * warning — the physical counter was reset (a board swap, a service action, a
 * firmware re-flash). So "is this reading a reset?" is a real, useful fact. The
 * temptation is to compute it once on INSERT and store it in a boolean column.
 * That would be wrong, and not subtly:
 *
 *   1. `usage_record` is APPEND-ONLY (spec §6.4). Its rows cannot be updated —
 *      an UPDATE/DELETE-rejecting trigger enforces it. So a stored flag could
 *      never be corrected once written. A derived fact that is guaranteed to go
 *      stale, in a table that forbids fixing it, is a bug with a schema around it.
 *
 *   2. The flag is not a property of a row. It is a property of a row's PLACE IN
 *      A SEQUENCE — it depends entirely on the reading chronologically before it.
 *      Readings arrive out of order in practice: a technician backfills last
 *      quarter's logbook, or an import lands historical rows after the manual
 *      ones. Appending a BACKDATED reading re-sorts the series, which can
 *      simultaneously put a reset flag on a row that never had one and take it
 *      off a row that did — without either row being written to. Both directions
 *      are pinned by tests below. A stored flag would silently describe an
 *      ordering that no longer exists.
 *
 *   3. Deriving costs nothing worth optimising: a device's whole reading history
 *      is a handful of rows, and the derivation is one linear pass.
 *
 * So: read the rows, sort them, derive. The table stores only what was observed
 * (a date and a counter value); every interpretation lives here.
 *
 * ═══ `totalSessions` IS A LOWER BOUND, NOT A MEASUREMENT ═══
 *
 * When a counter resets from 500 to 20, the sessions run between the last
 * reading of 500 and the moment the counter went to zero are UNKNOWABLE — nobody
 * observed them. `totalSessions` sums the segments (500 + 20 = 520) and so is
 * the largest number the evidence supports, never an exact lifetime figure. The
 * delta ACROSS a reset boundary is reported as 0 for the same reason: pretending
 * to a number there would be inventing data. Anything presented to a user from
 * `totalSessions` on a device where `hasReset` is true should say "at least".
 */

/** One `usage_record` row, as the derivation needs it. */
export type UsageReading = {
  id: string
  /** YYYY-MM-DD — the date the counter was read, supplied by the person reading it. */
  recordedOn: string
  /** The odometer value on that date. Non-negative; enforced by a CHECK in the schema. */
  cumulativeSessions: number
  /** When the row was appended. Distinct from recordedOn — a reading can be backdated. */
  createdAt: Date
}

export type DerivedUsageReading = UsageReading & {
  /**
   * This reading is STRICTLY lower than the one chronologically before it — the
   * counter was reset. Never true for the first reading (there is nothing to be
   * lower than) and never true for an unchanged counter.
   */
  isReset: boolean
  /** 0 for the original counter; incremented at every reset. */
  segmentIndex: number
  /**
   * Sessions since the previous reading. 0 for the first reading and 0 across a
   * reset boundary — see the header: that gap is unknowable, not zero.
   */
  delta: number
  /** The counter value within this reading's segment — i.e. cumulative since the last reset. */
  sessionsInSegment: number
  /** Lower bound on lifetime sessions up to and including this reading. */
  totalSessions: number
}

/**
 * Total chronological order over readings: `recorded_on`, then `created_at` for
 * two readings taken on the same date (which is legal and meaningful — a
 * before-and-after pair around a service action), then `id` so the order is
 * fully determined even when two rows tie on both. Without the final tiebreak
 * the derivation would depend on the order the database happened to return rows
 * in, and the same data could produce two different answers.
 *
 * Pure: returns a new array, never sorts the caller's.
 */
export function chronologicalUsageOrder<T extends UsageReading>(readings: readonly T[]): T[] {
  return [...readings].sort((a, b) => {
    if (a.recordedOn !== b.recordedOn) return a.recordedOn < b.recordedOn ? -1 : 1
    const at = a.createdAt.getTime()
    const bt = b.createdAt.getTime()
    if (at !== bt) return at - bt
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0
  })
}

/**
 * Derives the reset flags and running totals for a device's readings.
 *
 * TAKES THE WHOLE SERIES, DELIBERATELY. Handing this a PAGE of readings gives
 * wrong answers, and quietly: the first row of the page has no predecessor
 * inside the page, so it reads as a first-ever reading and its segment and
 * totals start from scratch. Callers derive over the full device history and
 * paginate the DERIVED result, never the other way round.
 */
export function deriveUsageSeries(readings: readonly UsageReading[]): DerivedUsageReading[] {
  const ordered = chronologicalUsageOrder(readings)
  const out: DerivedUsageReading[] = []

  let previous: number | null = null
  let segmentIndex = 0
  let totalSessions = 0

  for (const reading of ordered) {
    const value = reading.cumulativeSessions
    // Strictly lower, not "different": an unchanged counter is a device that was
    // simply not used between two readings, which is ordinary and not a reset.
    const isReset = previous !== null && value < previous

    if (isReset) segmentIndex += 1

    // The first reading contributes its whole counter (the device did that work,
    // we just started recording late). A reset contributes its whole counter to
    // the total as a new segment. Otherwise only the measured delta lands.
    const delta = previous === null || isReset ? 0 : value - previous
    totalSessions = previous === null || isReset ? totalSessions + value : totalSessions + delta

    out.push({
      ...reading,
      isReset,
      segmentIndex,
      delta,
      sessionsInSegment: value,
      totalSessions,
    })
    previous = value
  }

  return out
}

export type UsageSummary = {
  /** The chronologically last reading, or null when the device has never been read. */
  latest: DerivedUsageReading | null
  readingCount: number
  /** How many times the counter was observed to go backwards. */
  resetCount: number
  hasReset: boolean
  /** Lower bound on lifetime sessions — see the module header before displaying this. */
  totalSessions: number
  /** The odometer value at the latest reading. */
  currentCounter: number | null
  /** max(recorded_on), which spec §6.3 defines as "latest". */
  latestRecordedOn: string | null
  /** Cumulative sessions since the most recent reset (the whole life when there was none). */
  sessionsSinceReset: number
}

/** Rolls a device's readings up for the profile header and the module surface. */
export function summarizeUsage(readings: readonly UsageReading[]): UsageSummary {
  const series = deriveUsageSeries(readings)
  const latest = series[series.length - 1] ?? null
  const resetCount = series.filter((x) => x.isReset).length

  return {
    latest,
    readingCount: series.length,
    resetCount,
    hasReset: resetCount > 0,
    totalSessions: latest?.totalSessions ?? 0,
    currentCounter: latest?.cumulativeSessions ?? null,
    latestRecordedOn: latest?.recordedOn ?? null,
    // The latest reading's own counter IS the sessions-since-reset figure: a
    // segment starts at the reset and the counter counts from there.
    sessionsSinceReset: latest?.sessionsInSegment ?? 0,
  }
}

/**
 * How a reading being ENTERED relates to the one before it, so the write path
 * can warn without refusing.
 *
 * `reset` is an accepted outcome, not a validation failure — spec §6.3 is
 * explicit that a non-monotonic reading is allowed with a warning. A service
 * that threw here would make a device whose counter was legitimately replaced
 * impossible to keep records for.
 */
export type NewReadingClassification =
  | { kind: 'first' }
  | { kind: 'increase'; delta: number }
  | { kind: 'unchanged' }
  | { kind: 'reset'; previous: number; next: number }

export function classifyNewReading(
  previous: number | null, next: number,
): NewReadingClassification {
  if (previous === null) return { kind: 'first' }
  if (next < previous) return { kind: 'reset', previous, next }
  if (next === previous) return { kind: 'unchanged' }
  return { kind: 'increase', delta: next - previous }
}

/**
 * Is this reading dated in the future?
 *
 * A future reading is not a policy the specification declined to make — it is a
 * DOMAIN IMPOSSIBILITY. Nobody read a counter tomorrow.
 *
 * It matters far more here than on a mutable table, because `usage_record` gives
 * up every other integrity mechanism: no UPDATE, no DELETE, no soft-delete. One
 * future-dated row permanently owns `max(recorded_on)`, which is the spec's
 * definition of "latest" — so it pins the staleness age at 0 forever, makes
 * every genuine reading recorded between now and that date classify as a counter
 * reset (each being lower than the bogus one), and cannot be corrected. Rejecting
 * on the way in is the only affordable moment.
 *
 * `today` is injected, per the house rule for date logic. Compared at UTC
 * midnight against the YYYY-MM-DD string, so the answer is a pure function of
 * its two arguments. The DATABASE holds the same rule in
 * `fn_usage_record_insert_guard` and is the real boundary — this exists so the
 * common path fails with a sentence a user can act on, and so the rule is
 * unit-tested rather than only reachable through Postgres.
 */
export function isFutureReadingDate(recordedOn: string, today: Date): boolean {
  const readingMs = Date.parse(`${recordedOn}T00:00:00Z`)
  if (Number.isNaN(readingMs)) return false // malformed is the date regex's job, not this one's
  const todayMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  return readingMs > todayMs
}

const MS_PER_DAY = 86_400_000

/**
 * Whole days between the latest reading's date and `today` — the aging signal
 * ("this device has not been read in 90 days").
 *
 * `today` is injected rather than read from the clock, per the house rule for
 * date logic. Both sides are compared at UTC midnight so the answer is a whole
 * number of days regardless of what time of day `today` carries, and a
 * future-dated reading clamps to 0 rather than reporting a negative age.
 */
export function daysSinceLastReading(
  latestRecordedOn: string | null, today: Date,
): number | null {
  if (!latestRecordedOn) return null
  const readingMs = Date.parse(`${latestRecordedOn}T00:00:00Z`)
  if (Number.isNaN(readingMs)) return null
  const todayMs = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
  return Math.max(0, Math.round((todayMs - readingMs) / MS_PER_DAY))
}
