import { z } from 'zod'
import { withTransaction, type Tx } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'
import {
  deriveUsageSeries, summarizeUsage, classifyNewReading, daysSinceLastReading,
  isFutureReadingDate,
  type UsageReading, type DerivedUsageReading, type UsageSummary,
  type NewReadingClassification,
} from '@/modules/maintenance/domain/usageReadings'

/**
 * Usage records (spec §6.3) — device session-counter readings.
 *
 * Shaped like repairService/modificationService: authorize first and AHEAD of
 * taking a connection, Zod parse second, one `withTransaction` third, and reads
 * that return null rather than throwing so an id-addressed page 404s instead of
 * confirming a record exists (spec §7.3).
 *
 * TWO THINGS DIFFER FROM ITS SIBLINGS, both because the table is APPEND-ONLY:
 *
 *   * NO OPTIMISTIC LOCKING, and no `version` to lock on. Nothing here updates a
 *     row — the only write is an INSERT — so there is no lost-update to prevent.
 *     A correction is a new reading, never an edit (see the migration header).
 *
 *   * NO DERIVED STATE IS STORED, so concurrency cannot corrupt anything. Every
 *     interpretation of the series — reset detection, segments, totals — is
 *     computed at READ time by the pure domain. `recordUsage` reads the previous
 *     reading only to hand the caller a WARNING ("this looks like a counter
 *     reset"); that read is advisory, and two appends racing can at worst produce
 *     a warning computed against a reading that a concurrent transaction has
 *     since superseded. The stored data is right either way, and the next read
 *     derives the truth from the whole series. This is why there is no FOR UPDATE
 *     here while every sibling service has one — it is a consequence of the
 *     design, not an omission.
 *
 * THE WHOLE-SERIES RULE. `deriveUsageSeries` is only correct over a device's
 * COMPLETE reading history: the first row of a page has no predecessor inside
 * that page, so it reads as a first-ever reading and its totals restart. Every
 * read below therefore loads a device's full series and paginates the DERIVED
 * result. Do not "optimise" this into a LIMIT on the SQL that feeds the
 * derivation — it produces wrong reset flags, silently.
 */

export class UsageDeviceNotFoundError extends Error {
  readonly deviceId: string
  constructor(deviceId: string) {
    super(`Device ${deviceId} not found`)
    this.name = 'UsageDeviceNotFoundError'
    this.deviceId = deviceId
  }
}

/**
 * A reading dated in the future. Refused rather than accepted-with-a-warning —
 * unlike a non-monotonic reading, which is a real observation. See
 * `isFutureReadingDate` for why this one cannot be tolerated on an append-only
 * table. `fn_usage_record_insert_guard` holds the same rule in the database and
 * is the actual boundary; this exists so the common path gets a usable sentence.
 */
export class UsageDateInFutureError extends Error {
  readonly recordedOn: string
  constructor(recordedOn: string) {
    super(`A usage reading cannot be dated in the future (got ${recordedOn}).`)
    this.name = 'UsageDateInFutureError'
    this.recordedOn = recordedOn
  }
}

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')

/**
 * A hard ceiling on how many readings one device's derivation will load. A
 * device read weekly for a decade has ~520 rows, so this is far above any real
 * series; it exists so a pathological import cannot turn one page render into an
 * unbounded fetch.
 *
 * THIS CAP VIOLATES THE WHOLE-SERIES RULE ABOVE, and pretending otherwise was a
 * defect. When it bites, the OLDEST readings are dropped, and an earlier draft
 * of this comment claimed that only makes the lifetime lower bound lower and is
 * "never wrong in the other direction". That is false, and here is the
 * counterexample: if the dropped prefix contained the only reset boundary, the
 * surviving window is monotonic, `hasReset` comes back FALSE, and the UI stops
 * marking the lifetime figure with `≥`. The number gets smaller AND loses the
 * qualifier that said it was a floor — the one direction that misleads.
 *
 * So callers are told. Every read that applies this cap reports `truncated` when
 * it comes back exactly full, and the UI qualifies what it prints instead of
 * asserting a lifetime it cannot support. Nothing in the current fleet is close
 * to 2000 readings; this makes the failure visible rather than silent when
 * something is.
 */
const MAX_SERIES_ROWS = 2000

type UsageRow = {
  id: string
  recorded_on: string
  cumulative_sessions: number
  created_at: Date
}

/**
 * Loads one device's complete reading series, oldest-relevant first.
 *
 * `recorded_on` is read as TEXT (`::text`), not as a Date. node-postgres parses
 * a bare `date` into a JS Date at LOCAL midnight, so on a host west of UTC
 * `2026-08-01` becomes `2026-07-31T…` once formatted back — the same one-day
 * shift already carried as a finding on delivery_order.delivered_date. The
 * domain compares recordedOn as a YYYY-MM-DD string, so keeping it text end to
 * end sidesteps the timezone entirely.
 */
async function loadSeries(
  tx: Tx, deviceId: string,
): Promise<{ readings: UsageReading[]; truncated: boolean }> {
  const { rows } = await tx.query<UsageRow>(
    `SELECT id, recorded_on::text AS recorded_on, cumulative_sessions, created_at
       FROM usage_record
      WHERE device_id = $1
      ORDER BY recorded_on DESC, created_at DESC, id DESC
      LIMIT $2`, [deviceId, MAX_SERIES_ROWS])
  // The domain sorts into chronological order itself, so the DESC fetch above
  // (which is what makes the LIMIT keep the NEWEST rows) needs no reversal here.
  return { readings: rows.map(toReading), truncated: rows.length === MAX_SERIES_ROWS }
}

function toReading(r: UsageRow): UsageReading {
  return {
    id: r.id,
    recordedOn: r.recorded_on,
    cumulativeSessions: r.cumulative_sessions,
    createdAt: r.created_at,
  }
}

async function assertDeviceLive(tx: Tx, deviceId: string): Promise<void> {
  const { rows } = await tx.query(
    `SELECT 1 FROM device WHERE id = $1 AND deleted_at IS NULL`, [deviceId])
  if (rows.length === 0) throw new UsageDeviceNotFoundError(deviceId)
}

// ── Reads ───────────────────────────────────────────────────────────────────

export type UsageReadingRow = DerivedUsageReading & {
  source: string
  note: string | null
  enteredByName: string | null
  createdByName: string | null
}

/**
 * One device's readings, NEWEST FIRST for display, each carrying its derived
 * facts. Returns null when the device is unknown or soft-deleted, so the Usage
 * tab 404s rather than confirming the device exists (spec §7.3).
 */
export async function listDeviceUsage(
  actor: Actor, deviceId: string,
): Promise<{ items: UsageReadingRow[]; summary: UsageSummary; truncated: boolean } | null> {
  authorize(actor, 'view_records', 'maintenance')

  return withTransaction(actor.id, async (tx) => {
    const { rows: live } = await tx.query(
      `SELECT 1 FROM device WHERE id = $1 AND deleted_at IS NULL`, [deviceId])
    if (live.length === 0) return null

    const { rows } = await tx.query<UsageRow & {
      source: string; note: string | null
      entered_by_name: string | null; created_by_name: string | null
    }>(
      `SELECT u.id, u.recorded_on::text AS recorded_on, u.cumulative_sessions, u.created_at,
              u.source, u.note,
              eb.full_name AS entered_by_name, cb.full_name AS created_by_name
         FROM usage_record u
         LEFT JOIN app_user eb ON eb.id = u.entered_by
         LEFT JOIN app_user cb ON cb.id = u.created_by
        WHERE u.device_id = $1
        ORDER BY u.recorded_on DESC, u.created_at DESC, u.id DESC
        LIMIT $2`, [deviceId, MAX_SERIES_ROWS])

    // Derive over the WHOLE series (see the module header), then present newest
    // first. The extra map is what keeps the two orders from being confused.
    const derived = deriveUsageSeries(rows.map(toReading))
    const byId = new Map(derived.map((d) => [d.id, d]))
    const items: UsageReadingRow[] = rows.map((r) => ({
      ...byId.get(r.id)!,
      source: r.source,
      note: r.note,
      enteredByName: r.entered_by_name,
      createdByName: r.created_by_name,
    }))

    // Exactly full means the cap may have cut the series short — and a dropped
    // prefix can hide a reset boundary, which silently downgrades the lifetime
    // figure from a marked floor to an unmarked wrong number. See MAX_SERIES_ROWS.
    return { items, summary: summarizeUsage(derived), truncated: rows.length === MAX_SERIES_ROWS }
  })
}

export type DeviceUsageSummary = UsageSummary & {
  deviceId: string
  deviceSn: string | null
  /** Whole days since the latest reading, or null when never read. */
  daysSinceLastReading: number | null
}

const summariesSchema = z.object({
  limit: z.number().int().min(1).max(200).default(50),
  /** Restrict to devices whose series contains at least one detected reset. */
  resetsOnly: z.boolean().default(false),
})
export type UsageSummariesFilter = z.input<typeof summariesSchema>

/**
 * How many devices one call will examine, regardless of the display `limit`.
 *
 * `resetsOnly` cannot be applied in SQL — "has a reset" is not a fact any column
 * holds — so the filter has to run over DERIVED summaries, which means deriving
 * more devices than are displayed. This is what bounds that: the scan is capped
 * here, the page is cut from the scan's result, and `scanComplete` says whether
 * the two are the same population.
 */
const MAX_SUMMARY_SCAN_DEVICES = 500

export type UsageSummaryPage = {
  /** The devices to display: filtered, then cut to `limit`. */
  items: DeviceUsageSummary[]
  /** How many devices matched the filter within the scan — the honest table total. */
  total: number
  /** How many devices were examined. */
  scanned: number
  /** False when the device scan hit its cap, so `total` is itself a floor. */
  scanComplete: boolean
  /** Devices with a detected reset, within the scan and BEFORE `resetsOnly`. */
  devicesWithResets: number
}

/**
 * Per-device usage summaries for the usage register, most recently read first.
 *
 * `today` is a parameter (defaulted, never captured at module scope) so the
 * aging figures are testable — the house rule for date logic.
 *
 * ═══ WHY THIS RETURNS COUNTS AND NOT JUST ROWS ═══
 *
 * An earlier version returned a bare array and let the page render its own
 * headline tiles from a SEPARATE query. That produced two numbers on one screen
 * that disagreed and nothing saying which was right: a tile counting every
 * device with readings, above a table silently cut to 50, and a reset tile
 * counted over the whole table beside a filtered list showing fewer. Both
 * numbers were individually defensible and the pair was misinformation.
 *
 * So one call now answers the whole screen. The tiles and the table come from
 * the SAME scan, `total` describes the filter that produced `items`, and
 * `scanComplete` marks the one case where `total` is itself only a floor.
 *
 * ORDER OF OPERATIONS, and it is the fix for the second half of that defect:
 * the scan cap applies to DEVICES, then summaries are derived, THEN `resetsOnly`
 * filters, THEN the display limit cuts. Filtering after the display limit — the
 * original bug — meant asking for "devices with a reset" returned only those
 * that happened to fall inside the first 50 by recency, which is not the
 * question that was asked.
 *
 * TWO QUERIES, DELIBERATELY. The first picks the devices; the second loads THOSE
 * devices' complete series so the derivation obeys the whole-series rule. A
 * single query with a LIMIT over readings would page the input to the
 * derivation, which is the mistake the module header warns about.
 */
export async function listDeviceUsageSummaries(
  actor: Actor, filter: UsageSummariesFilter = {}, today: Date = new Date(),
): Promise<UsageSummaryPage> {
  authorize(actor, 'view_records', 'maintenance')
  const f = summariesSchema.parse(filter)

  return withTransaction(actor.id, async (tx) => {
    const { rows: devices } = await tx.query<{ id: string; device_sn: string | null }>(
      `SELECT d.id, d.device_sn
         FROM device d
         JOIN (SELECT device_id, max(recorded_on) AS latest
                 FROM usage_record GROUP BY device_id) u ON u.device_id = d.id
        WHERE d.deleted_at IS NULL
        ORDER BY u.latest DESC, d.id DESC
        LIMIT $1`, [MAX_SUMMARY_SCAN_DEVICES])
    if (devices.length === 0) {
      return { items: [], total: 0, scanned: 0, scanComplete: true, devicesWithResets: 0 }
    }

    const { rows } = await tx.query<UsageRow & { device_id: string }>(
      `SELECT id, device_id, recorded_on::text AS recorded_on, cumulative_sessions, created_at
         FROM usage_record
        WHERE device_id = ANY($1)`, [devices.map((d) => d.id)])

    const byDevice = new Map<string, UsageReading[]>()
    for (const r of rows) {
      const list = byDevice.get(r.device_id)
      if (list) list.push(toReading(r))
      else byDevice.set(r.device_id, [toReading(r)])
    }

    const all = devices.map((d) => {
      const summary = summarizeUsage(byDevice.get(d.id) ?? [])
      return {
        ...summary,
        deviceId: d.id,
        deviceSn: d.device_sn,
        daysSinceLastReading: daysSinceLastReading(summary.latestRecordedOn, today),
      }
    })

    // Counted before the filter, so the tile describes the population rather
    // than the current view — and so switching the filter never changes it.
    const devicesWithResets = all.filter((s) => s.hasReset).length
    const matching = f.resetsOnly ? all.filter((s) => s.hasReset) : all

    return {
      items: matching.slice(0, f.limit),
      total: matching.length,
      scanned: all.length,
      scanComplete: devices.length < MAX_SUMMARY_SCAN_DEVICES,
      devicesWithResets,
    }
  })
}

/**
 * Cheap headline counts for the Maintenance landing.
 *
 * TWO SQL AGGREGATES AND NOTHING ELSE. An earlier version also reported
 * `devicesWithResets`, which cannot be counted in SQL — "has a reset" is derived
 * — so it loaded EVERY row of `usage_record` into JS and derived each device's
 * series. On `/maintenance`, which is every maintenance user's landing page.
 * That is precisely the unbounded page-render fetch `MAX_SERIES_ROWS` exists to
 * prevent, committed on the busier of the two pages, and on the usage register
 * it read the whole history a second time for tiles the register had already
 * derived.
 *
 * The reset count now comes from `listDeviceUsageSummaries`, which is bounded
 * and already holds the derived summaries the register renders. The landing tile
 * asks this function only for what an index can answer.
 */
export type UsageOverview = {
  deviceCount: number
  readingCount: number
}

export async function getUsageOverview(actor: Actor): Promise<UsageOverview> {
  authorize(actor, 'view_records', 'maintenance')

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{ device_count: string; reading_count: string }>(
      `SELECT count(DISTINCT device_id)::text AS device_count, count(*)::text AS reading_count
         FROM usage_record`)
    return {
      deviceCount: Number(rows[0].device_count),
      readingCount: Number(rows[0].reading_count),
    }
  })
}

export type UsageLoggableDevice = {
  id: string
  deviceSn: string | null
  statusLabel: string
  latestReading: number | null
  latestRecordedOn: string | null
}

/**
 * Devices a reading can be logged against (the New reading picker). Every live
 * device qualifies — unlike a repair, logging usage has no status precondition,
 * so there is nothing here to resolve from `status_transition`.
 */
export async function listUsageLoggableDevices(
  actor: Actor, limit = 200,
): Promise<UsageLoggableDevice[]> {
  authorize(actor, 'view_records', 'maintenance')

  return withTransaction(actor.id, async (tx) => {
    const { rows } = await tx.query<{
      id: string; device_sn: string | null; status_label: string
      latest_reading: number | null; latest_recorded_on: string | null
    }>(
      `SELECT d.id, d.device_sn, s.label_en AS status_label,
              u.cumulative_sessions AS latest_reading,
              u.recorded_on::text AS latest_recorded_on
         FROM device d
         JOIN status_option s ON s.code = d.status
         LEFT JOIN LATERAL (
           SELECT cumulative_sessions, recorded_on
             FROM usage_record
            WHERE device_id = d.id
            ORDER BY recorded_on DESC, created_at DESC, id DESC
            LIMIT 1
         ) u ON true
        WHERE d.deleted_at IS NULL
        ORDER BY d.created_at DESC
        LIMIT $1`, [limit])
    return rows.map((r) => ({
      id: r.id, deviceSn: r.device_sn, statusLabel: r.status_label,
      latestReading: r.latest_reading, latestRecordedOn: r.latest_recorded_on,
    }))
  })
}

// ── Writes ──────────────────────────────────────────────────────────────────

const recordSchema = z.object({
  deviceId: z.string().uuid(),
  cumulativeSessions: z.number().int().nonnegative(),
  recordedOn: DATE.optional(),
  source: z.enum(['manual', 'import', 'api']).default('manual'),
  enteredBy: z.string().uuid().optional(),
  note: z.string().max(2000).optional(),
})
export type RecordUsageInput = z.input<typeof recordSchema>

export type RecordUsageResult = {
  usageRecordId: string
  /**
   * How this reading relates to the one before it. `reset` is a WARNING the
   * caller shows, never a refusal — see below.
   */
  classification: NewReadingClassification
}

/**
 * Append one reading (spec §6.3, permission `log_usage_service` — the catalogue
 * already carries it; this service is what finally uses it).
 *
 * A READING LOWER THAN THE LAST ONE IS ACCEPTED. Spec §6.3 is explicit that the
 * series may be non-monotonic and that the response is a warning, not a
 * rejection: counters really do reset when a board is swapped or firmware is
 * re-flashed, and a service that refused the reading would make such a device
 * impossible to keep records for at all — the operator would either stop
 * recording or start lying to the form. So the classification is RETURNED for
 * the UI to surface, and the row is written either way.
 *
 * A READING DATED IN THE FUTURE IS REFUSED, and that is not the same judgement.
 * A non-monotonic reading is a real observation of a real counter; a future
 * reading is a domain impossibility — nobody read a counter tomorrow — and on an
 * append-only table it is uncorrectable. See `isFutureReadingDate`. The database
 * holds the same rule (`fn_usage_record_insert_guard`) and is the actual
 * boundary, binding the import/api writers that will never come through this
 * schema; the check here exists so the ordinary path fails with a usable
 * sentence instead of a raw constraint violation.
 *
 * `recorded_on` defaults to today when the caller doesn't supply one; an
 * explicit PAST date is preserved, because a logbook is often typed up days
 * later. `entered_by` defaults to the acting user but is separable, since the
 * person who read the counter in the field is frequently not the person at the
 * keyboard (see the column's COMMENT).
 */
export async function recordUsage(
  actor: Actor, input: RecordUsageInput, today: Date = new Date(),
): Promise<RecordUsageResult> {
  // Ahead of the connection, deliberately — the ordering `prepareStatusChange`
  // exists to protect in Manufacturing, and the reason a permission failure must
  // never depend on the database being reachable.
  authorize(actor, 'log_usage_service', 'maintenance')
  const data = recordSchema.parse(input)

  // Ahead of the connection too — a date nobody could have read is not worth a
  // round trip, and the caller gets a sentence rather than a constraint name.
  if (data.recordedOn && isFutureReadingDate(data.recordedOn, today)) {
    throw new UsageDateInFutureError(data.recordedOn)
  }

  return withTransaction(actor.id, async (tx) => {
    await assertDeviceLive(tx, data.deviceId)

    // Advisory only (see the module header): nothing derived is stored, so this
    // read races harmlessly. It is inside the transaction so that a rolled-back
    // append cannot leave the caller holding a warning about a row that does not
    // exist.
    //
    // The comparison is against the LATEST reading — max(recorded_on) — which is
    // deliberately the number the entry form shows the user ("last reading:
    // 500"), so the warning answers the question they actually asked. For a
    // BACKDATED entry that is not necessarily the reading the new row will sit
    // behind once the series is re-sorted, so the returned classification can
    // differ from the `isReset` flag the row later displays. That is a property
    // of backdating, not a defect: the stored row is identical either way, and
    // the displayed flag is always re-derived from the full series.
    //
    // MAX_SERIES_ROWS truncation cannot affect this: the cap keeps the NEWEST
    // rows and the comparison is against the newest, so the flag it would drop
    // is never the one being computed here.
    const { readings } = await loadSeries(tx, data.deviceId)
    const series = deriveUsageSeries(readings)
    const previous = series[series.length - 1]?.cumulativeSessions ?? null

    const { rows } = await tx.query<{ id: string }>(
      `INSERT INTO usage_record
         (device_id, recorded_on, cumulative_sessions, source, entered_by, note, created_by)
       VALUES ($1, COALESCE($2::date, current_date), $3, $4, $5, $6, $7)
       RETURNING id`,
      [data.deviceId, data.recordedOn ?? null, data.cumulativeSessions, data.source,
       data.enteredBy ?? actor.id, data.note?.trim() || null, actor.id])

    return {
      usageRecordId: rows[0].id,
      classification: classifyNewReading(previous, data.cumulativeSessions),
    }
  })
}
