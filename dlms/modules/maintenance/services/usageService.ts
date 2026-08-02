import { z } from 'zod'
import { withTransaction, type Tx } from '@/lib/db/tx'
import { authorize } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'
import {
  deriveUsageSeries, summarizeUsage, classifyNewReading, daysSinceLastReading,
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

const DATE = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')

/**
 * A hard ceiling on how many readings one device's derivation will load. A
 * device read weekly for a decade has ~520 rows, so this is far above any real
 * series; it exists so a pathological import cannot turn one page render into an
 * unbounded fetch. If a device ever exceeds it the OLDEST readings are the ones
 * dropped, which keeps the recent picture honest and only makes the lifetime
 * lower bound lower — never wrong in the other direction.
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
async function loadSeries(tx: Tx, deviceId: string): Promise<UsageReading[]> {
  const { rows } = await tx.query<UsageRow>(
    `SELECT id, recorded_on::text AS recorded_on, cumulative_sessions, created_at
       FROM usage_record
      WHERE device_id = $1
      ORDER BY recorded_on DESC, created_at DESC, id DESC
      LIMIT $2`, [deviceId, MAX_SERIES_ROWS])
  // The domain sorts into chronological order itself, so the DESC fetch above
  // (which is what makes the LIMIT keep the NEWEST rows) needs no reversal here.
  return rows.map(toReading)
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
): Promise<{ items: UsageReadingRow[]; summary: UsageSummary } | null> {
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

    return { items, summary: summarizeUsage(derived) }
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
 * Per-device usage summaries for the Maintenance module surface, most recently
 * read first.
 *
 * `today` is a parameter (defaulted, never captured at module scope) so the
 * aging figures are testable — the house rule for date logic, the same shape the
 * domain modules take.
 *
 * TWO QUERIES, DELIBERATELY. The first picks the devices to report on; the
 * second loads THOSE devices' complete series so the derivation obeys the
 * whole-series rule. A single query with a LIMIT over readings would page the
 * input to the derivation, which is exactly the mistake the module header warns
 * about. `resetsOnly` filters the DERIVED result rather than the SQL, because
 * "has a reset" is not a fact any column holds.
 */
export async function listDeviceUsageSummaries(
  actor: Actor, filter: UsageSummariesFilter = {}, today: Date = new Date(),
): Promise<DeviceUsageSummary[]> {
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
        LIMIT $1`, [f.limit])
    if (devices.length === 0) return []

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

    const out = devices.map((d) => {
      const summary = summarizeUsage(byDevice.get(d.id) ?? [])
      return {
        ...summary,
        deviceId: d.id,
        deviceSn: d.device_sn,
        daysSinceLastReading: daysSinceLastReading(summary.latestRecordedOn, today),
      }
    })

    return f.resetsOnly ? out.filter((s) => s.hasReset) : out
  })
}

/** Headline counts for the Maintenance landing. Derived, never stored. */
export type UsageOverview = {
  deviceCount: number
  readingCount: number
  devicesWithResets: number
}

export async function getUsageOverview(actor: Actor): Promise<UsageOverview> {
  authorize(actor, 'view_records', 'maintenance')

  return withTransaction(actor.id, async (tx) => {
    const { rows: totals } = await tx.query<{ device_count: string; reading_count: string }>(
      `SELECT count(DISTINCT device_id)::text AS device_count, count(*)::text AS reading_count
         FROM usage_record`)

    // "Has a reset" is derived, so it cannot be counted in SQL. Load the reading
    // series (id-free projection — only the shape the domain needs) and count in
    // JS, which is also this repo's house rule: flat selects + JS reduce.
    const { rows } = await tx.query<UsageRow & { device_id: string }>(
      `SELECT id, device_id, recorded_on::text AS recorded_on, cumulative_sessions, created_at
         FROM usage_record`)
    const byDevice = new Map<string, UsageReading[]>()
    for (const r of rows) {
      const list = byDevice.get(r.device_id)
      if (list) list.push(toReading(r))
      else byDevice.set(r.device_id, [toReading(r)])
    }
    let devicesWithResets = 0
    for (const series of byDevice.values()) {
      if (deriveUsageSeries(series).some((x) => x.isReset)) devicesWithResets += 1
    }

    return {
      deviceCount: Number(totals[0].device_count),
      readingCount: Number(totals[0].reading_count),
      devicesWithResets,
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
 * `recorded_on` defaults to today when the caller doesn't supply one; an
 * explicit date is preserved, because a logbook is often typed up days later.
 * `entered_by` defaults to the acting user but is separable, since the person
 * who read the counter in the field is frequently not the person at the keyboard
 * (see the column's COMMENT).
 */
export async function recordUsage(
  actor: Actor, input: RecordUsageInput,
): Promise<RecordUsageResult> {
  // Ahead of the connection, deliberately — the ordering `prepareStatusChange`
  // exists to protect in Manufacturing, and the reason a permission failure must
  // never depend on the database being reachable.
  authorize(actor, 'log_usage_service', 'maintenance')
  const data = recordSchema.parse(input)

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
    const series = deriveUsageSeries(await loadSeries(tx, data.deviceId))
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
