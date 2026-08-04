// __tests__/integration/usageService.test.ts
//
// Schema assertions for 20260803110000_platform_maintenance_usage.sql (spec
// §6.3/§6.4): the append-only `usage_record` table, its immutability guard, its
// CHECKs, its audit trigger and its RLS posture.
//
// …plus the behaviour of modules/maintenance/services/usageService.ts, in the
// second half of this file — the sibling of modificationService.test.ts.
//
// Talks to the real local Postgres over TEST_DATABASE_URL (the shared platform
// test database __tests__/integration/setup.ts migrates + seeds), in the idiom
// of modificationService.test.ts: raw SQL, tag rows per run, clean up in
// afterAll. EVERY assertion is scoped to rows this file created — the database
// is shared with every other integration file and is not rolled back.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import {
  recordUsage, listDeviceUsage, listDeviceUsageSummaries, getUsageOverview,
  listUsageLoggableDevices, UsageDeviceNotFoundError, UsageDateInFutureError,
} from '@/modules/maintenance/services/usageService'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

let db: Client
let userId: string
let deviceId: string
let otherDeviceId: string

// Mirrors the SEEDED operator role (catalog.ts) with maintenance access: holds
// log_usage_service, which is the permission this whole service is gated on.
const logger = (): Actor => ({
  id: userId, roleKey: 'operator',
  permissions: new Set(['view_records', 'create_records', 'edit_records', 'log_usage_service']),
  moduleAccess: new Set(['maintenance']), active: true,
})
// Can read the register but not append to it — the seeded `viewer` shape.
const viewer = (): Actor => ({
  id: userId, roleKey: 'viewer',
  permissions: new Set(['view_records']), moduleAccess: new Set(['maintenance']), active: true,
})
// Holds maintenance module access but not the maintenance module — the case the
// device profile's Usage tab guards against.
const outsider = (): Actor => ({
  id: userId, roleKey: 'operator',
  permissions: new Set(['view_records', 'log_usage_service']),
  moduleAccess: new Set(['manufacturing']), active: true,
})

const createdDeviceIds: string[] = []

async function makeDevice(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO device (variant_id, status, created_by, updated_by)
     VALUES ((SELECT id FROM device_variant WHERE code='pro'), 'active', $1, $1) RETURNING id`,
    [userId])
  createdDeviceIds.push(rows[0].id)
  return rows[0].id
}

/** Appends a reading directly, bypassing the service — for shaping a series fast. */
async function seedReading(
  device: string, recordedOn: string, sessions: number, createdAt?: string,
): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO usage_record
       (device_id, recorded_on, cumulative_sessions, created_by, created_at)
     VALUES ($1, $2, $3, $4, COALESCE($5::timestamptz, now())) RETURNING id`,
    [device, recordedOn, sessions, userId, createdAt ?? null])
  return rows[0].id
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  userId = (await db.query(`SELECT id FROM app_user WHERE email = 'reetmitra8@gmail.com'`)).rows[0].id
  deviceId = await makeDevice()
  otherDeviceId = await makeDevice()
})

afterAll(async () => {
  // usage_record refuses DELETE through the guards, so cleanup must disable them
  // — which is itself proof they are attached and firing. The devices go with it
  // so the shared database is left as it was found.
  //
  // THE try/finally IS LOAD-BEARING, NOT TIDINESS. This runs against the SHARED
  // platform test database. If the DELETE throws — a new FK from some other
  // module's table, a lock timeout, anything — an unguarded sequence leaves the
  // append-only guards DISABLED for every test file that runs after this one and
  // for every subsequent suite run against the same container. That would
  // silently switch off the exact invariant this slice exists to guarantee, and
  // the tests asserting immutability would still pass because they run before
  // this hook. Re-enabling must therefore be unconditional.
  try {
    if (createdDeviceIds.length) {
      await db.query(`ALTER TABLE usage_record DISABLE TRIGGER trg_usage_record_guard`)
      await db.query(`ALTER TABLE usage_record DISABLE TRIGGER trg_usage_record_insert_guard`)
      await db.query(`DELETE FROM usage_record WHERE device_id = ANY($1)`, [createdDeviceIds])
      await db.query(`DELETE FROM audit_log WHERE table_name = 'usage_record'
                        AND (new_values->>'device_id') = ANY($1)`, [createdDeviceIds])
      await db.query(`DELETE FROM device WHERE id = ANY($1)`, [createdDeviceIds])
    }
  } finally {
    // Unconditional, and tolerant of the DISABLE itself having failed: ENABLE on
    // an already-enabled trigger is a no-op, so this is safe on every path.
    try {
      await db.query(`ALTER TABLE usage_record ENABLE TRIGGER trg_usage_record_guard`)
      await db.query(`ALTER TABLE usage_record ENABLE TRIGGER trg_usage_record_insert_guard`)
    } catch (err) {
      // Loudly, because a silent failure here poisons every later run.
      console.error('FAILED TO RE-ENABLE usage_record append-only guards', err)
      throw err
    } finally {
      await db.end()
      await getPool().end()
    }
  }
})

// ─── Schema ────────────────────────────────────────────────────────────────

describe('usage_record schema (spec §6.3/§6.4)', () => {
  it('carries exactly the spec §6.3 columns and no mutable-row columns', async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'usage_record' ORDER BY column_name`)
    const cols = rows.map((r) => r.column_name)
    expect(cols).toEqual([
      'created_at', 'created_by', 'cumulative_sessions', 'device_id', 'entered_by',
      'id', 'note', 'recorded_on', 'source',
    ])
    // The absences are the design: an append-only row has nothing to lock, stamp
    // on update, or soft-delete. See the migration header.
    for (const absent of ['version', 'updated_at', 'updated_by', 'deleted_at', 'is_reset']) {
      expect(cols).not.toContain(absent)
    }
  })

  it('refuses a negative counter reading', async () => {
    await expect(seedReading(deviceId, '2026-01-01', -1)).rejects.toThrow(/cumulative_sessions/)
  })

  it('accepts a reading of zero — a counter can legitimately read zero', async () => {
    const id = await seedReading(otherDeviceId, '2026-01-01', 0)
    expect(id).toBeTruthy()
  })

  it('fences `source` to the three code paths that write this table', async () => {
    await expect(db.query(
      `INSERT INTO usage_record (device_id, recorded_on, cumulative_sessions, source, created_by)
       VALUES ($1, '2026-01-02', 5, 'telepathy', $2)`, [otherDeviceId, userId]))
      .rejects.toThrow(/source/)
  })

  it('has RLS enabled and NOT forced, with no anon/authenticated policy', async () => {
    const { rows } = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'usage_record'`)
    expect(rows[0].relrowsecurity).toBe(true)
    // FORCE would also gate the owner connection and fn_audit's SECURITY DEFINER
    // writes — the one path this must leave alone.
    expect(rows[0].relforcerowsecurity).toBe(false)

    const { rows: policies } = await db.query(
      `SELECT policyname FROM pg_policies WHERE tablename = 'usage_record'`)
    expect(policies).toHaveLength(0) // no policy = PostgREST denies all
  })

  it('has the audit trigger attached', async () => {
    const { rows } = await db.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger
        WHERE tgrelid = 'usage_record'::regclass AND NOT tgisinternal ORDER BY tgname`)
    expect(rows.map((r) => r.tgname)).toContain('trg_audit_usage_record')
    expect(rows.map((r) => r.tgname)).toContain('trg_usage_record_guard')
  })

  it('writes an audit row on append', async () => {
    const before = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log
        WHERE table_name = 'usage_record' AND (new_values->>'device_id') = $1`, [otherDeviceId])
    await seedReading(otherDeviceId, '2026-01-03', 7)
    const after = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log
        WHERE table_name = 'usage_record' AND (new_values->>'device_id') = $1`, [otherDeviceId])
    expect(Number(after.rows[0].n)).toBe(Number(before.rows[0].n) + 1)
  })
})

describe('usage_record is append-only (spec §6.4)', () => {
  it('refuses every UPDATE — including one that only touches the note', async () => {
    const id = await seedReading(otherDeviceId, '2026-02-01', 50)
    // Stricter than component_installation's guard, which permits the one-time
    // removal stamp. Here the note is part of the observation.
    await expect(db.query(`UPDATE usage_record SET note = 'typo fix' WHERE id = $1`, [id]))
      .rejects.toThrow(/append-only/)
    await expect(db.query(
      `UPDATE usage_record SET cumulative_sessions = 999 WHERE id = $1`, [id]))
      .rejects.toThrow(/immutable/)
  })

  it('refuses DELETE', async () => {
    const id = await seedReading(otherDeviceId, '2026-02-02', 60)
    await expect(db.query(`DELETE FROM usage_record WHERE id = $1`, [id]))
      .rejects.toThrow(/cannot be deleted/)
  })

  it('permits two readings on ONE date — the before/after pair around a reset', async () => {
    const device = await makeDevice()
    await seedReading(device, '2026-03-01', 500, '2026-03-01T09:00:00Z')
    await seedReading(device, '2026-03-01', 20, '2026-03-01T10:00:00Z')
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM usage_record WHERE device_id = $1`, [device])
    expect(Number(rows[0].n)).toBe(2)
  })
})

// ─── Service ───────────────────────────────────────────────────────────────

describe('recordUsage', () => {
  it('appends a reading and classifies the first one', async () => {
    const device = await makeDevice()
    const res = await recordUsage(logger(), { deviceId: device, cumulativeSessions: 100 })
    expect(res.classification).toEqual({ kind: 'first' })

    const { rows } = await db.query<{ cumulative_sessions: number; source: string; entered_by: string }>(
      `SELECT cumulative_sessions, source, entered_by FROM usage_record WHERE id = $1`,
      [res.usageRecordId])
    expect(rows[0].cumulative_sessions).toBe(100)
    expect(rows[0].source).toBe('manual')
    expect(rows[0].entered_by).toBe(userId) // defaults to the acting user
  })

  it('defaults recorded_on to today and preserves an explicit (backdated) date', async () => {
    const device = await makeDevice()
    const auto = await recordUsage(logger(), { deviceId: device, cumulativeSessions: 10 })
    const explicit = await recordUsage(logger(), {
      deviceId: device, cumulativeSessions: 20, recordedOn: '2025-06-15' })

    // The default is asserted IN THE DATABASE, against the same current_date the
    // INSERT used — never against the host clock. `new Date().toISOString()` is
    // UTC while the DB session carries its own timezone, so a host in Singapore
    // (UTC+8) disagrees with a UTC database for eight hours of every day, and
    // even a matched pair flips if the run straddles midnight. That is exactly
    // the class of bug this module's `::text` convention exists to prevent.
    const { rows } = await db.query<{ id: string; is_today: boolean; recorded_on: string }>(
      `SELECT id, recorded_on = current_date AS is_today, recorded_on::text AS recorded_on
         FROM usage_record WHERE device_id = $1`, [device])
    const byId = new Map(rows.map((r) => [r.id, r]))
    expect(byId.get(auto.usageRecordId)!.is_today).toBe(true)
    expect(byId.get(explicit.usageRecordId)!.recorded_on).toBe('2025-06-15')
  })

  it('classifies growth, an unchanged counter, and a reset', async () => {
    const device = await makeDevice()
    await recordUsage(logger(), { deviceId: device, cumulativeSessions: 500, recordedOn: '2026-01-01' })

    const grew = await recordUsage(logger(), {
      deviceId: device, cumulativeSessions: 620, recordedOn: '2026-02-01' })
    expect(grew.classification).toEqual({ kind: 'increase', delta: 120 })

    const same = await recordUsage(logger(), {
      deviceId: device, cumulativeSessions: 620, recordedOn: '2026-03-01' })
    expect(same.classification).toEqual({ kind: 'unchanged' })

    const reset = await recordUsage(logger(), {
      deviceId: device, cumulativeSessions: 20, recordedOn: '2026-04-01' })
    expect(reset.classification).toEqual({ kind: 'reset', previous: 620, next: 20 })
  })

  // THE rule of spec §6.3: non-monotonic is accepted with a warning, not refused.
  it('WRITES the row for a lower reading rather than rejecting it', async () => {
    const device = await makeDevice()
    await recordUsage(logger(), { deviceId: device, cumulativeSessions: 500, recordedOn: '2026-01-01' })
    const res = await recordUsage(logger(), {
      deviceId: device, cumulativeSessions: 20, recordedOn: '2026-02-01' })

    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM usage_record WHERE device_id = $1`, [device])
    expect(Number(rows[0].n)).toBe(2)
    expect(res.classification.kind).toBe('reset')
  })

  it('separates entered_by from created_by when the reader is not the typist', async () => {
    const device = await makeDevice()
    const { rows: other } = await db.query<{ id: string }>(
      `SELECT id FROM app_user WHERE id <> $1 LIMIT 1`, [userId])
    if (!other[0]) return // single-user seed: nothing to assert
    const res = await recordUsage(logger(), {
      deviceId: device, cumulativeSessions: 5, enteredBy: other[0].id })
    const { rows } = await db.query<{ entered_by: string; created_by: string }>(
      `SELECT entered_by, created_by FROM usage_record WHERE id = $1`, [res.usageRecordId])
    expect(rows[0].entered_by).toBe(other[0].id)
    expect(rows[0].created_by).toBe(userId)
  })

  // C1. A future reading is uncorrectable on an append-only table: it
  // permanently owns max(recorded_on), pins the staleness age at 0, and makes
  // every later genuine reading classify as a reset. Refused at BOTH layers.
  it('refuses a future-dated reading through the service', async () => {
    const device = await makeDevice()
    const future = new Date(Date.now() + 5 * 86_400_000).toISOString().slice(0, 10)
    await expect(recordUsage(logger(), {
      deviceId: device, cumulativeSessions: 10, recordedOn: future }))
      .rejects.toThrow(UsageDateInFutureError)

    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM usage_record WHERE device_id = $1`, [device])
    expect(Number(rows[0].n)).toBe(0) // nothing was written
  })

  it('still accepts today, which is the inclusive boundary', async () => {
    const device = await makeDevice()
    const { rows } = await db.query<{ d: string }>(`SELECT current_date::text AS d`)
    const res = await recordUsage(logger(), {
      deviceId: device, cumulativeSessions: 10, recordedOn: rows[0].d })
    expect(res.usageRecordId).toBeTruthy()
  })

  it('refuses a future date at the DATABASE too, binding the import/api writers', async () => {
    // The `source` CHECK already anticipates import/api writers that will never
    // pass through recordUsage's schema. A rule only the current writer honours
    // is a rule the next writer breaks.
    const device = await makeDevice()
    await expect(db.query(
      `INSERT INTO usage_record (device_id, recorded_on, cumulative_sessions, source, created_by)
       VALUES ($1, current_date + 1, 5, 'import', $2)`, [device, userId]))
      .rejects.toThrow(/future/)
  })

  it('refuses an actor without log_usage_service', async () => {
    await expect(recordUsage(viewer(), { deviceId, cumulativeSessions: 1 }))
      .rejects.toThrow(PermissionError)
  })

  it('refuses an actor without maintenance module access', async () => {
    await expect(recordUsage(outsider(), { deviceId, cumulativeSessions: 1 }))
      .rejects.toThrow(PermissionError)
  })

  it('refuses an unknown device', async () => {
    await expect(recordUsage(logger(), {
      deviceId: '3f2a1b4c-0000-4000-8000-0000000000ff', cumulativeSessions: 1 }))
      .rejects.toThrow(UsageDeviceNotFoundError)
  })

  it('refuses a soft-deleted device', async () => {
    const device = await makeDevice()
    await db.query(`UPDATE device SET deleted_at = now() WHERE id = $1`, [device])
    await expect(recordUsage(logger(), { deviceId: device, cumulativeSessions: 1 }))
      .rejects.toThrow(UsageDeviceNotFoundError)
  })
})

describe('listDeviceUsage', () => {
  it('returns null for an unknown device so the tab 404s (spec §7.3)', async () => {
    expect(await listDeviceUsage(logger(), '3f2a1b4c-0000-4000-8000-0000000000fe')).toBeNull()
  })

  it('derives the reset flag and the cumulative-since-reset total', async () => {
    const device = await makeDevice()
    await seedReading(device, '2026-01-01', 500)
    await seedReading(device, '2026-02-01', 20)
    await seedReading(device, '2026-03-01', 90)

    const res = await listDeviceUsage(logger(), device)
    expect(res).not.toBeNull()
    // Newest first for display.
    expect(res!.items.map((x) => x.cumulativeSessions)).toEqual([90, 20, 500])
    expect(res!.items.map((x) => x.isReset)).toEqual([false, true, false])
    expect(res!.summary.hasReset).toBe(true)
    expect(res!.summary.resetCount).toBe(1)
    expect(res!.summary.sessionsSinceReset).toBe(90)
    // Lower bound: 500 observed before the reset, 90 after. The sessions between
    // the last 500-reading and the counter reaching zero are unknowable.
    expect(res!.summary.totalSessions).toBe(590)
    expect(res!.summary.currentCounter).toBe(90)
    expect(res!.summary.latestRecordedOn).toBe('2026-03-01')
  })

  // The case the derived-at-read-time design exists for, end to end through the
  // database: a BACKDATED append moves the flag onto a row nobody wrote to.
  it('a backdated append re-derives the flags of rows already stored', async () => {
    const device = await makeDevice()
    await seedReading(device, '2026-01-01', 100, '2026-01-01T00:00:00Z')
    await seedReading(device, '2026-03-01', 300, '2026-03-01T00:00:00Z')

    const before = await listDeviceUsage(logger(), device)
    expect(before!.items.some((x) => x.isReset)).toBe(false)

    // Dated between them, appended now, showing a counter higher than March.
    await recordUsage(logger(), {
      deviceId: device, cumulativeSessions: 900, recordedOn: '2026-02-01' })

    const after = await listDeviceUsage(logger(), device)
    const march = after!.items.find((x) => x.recordedOn === '2026-03-01')!
    // The March row is byte-identical in the table and now reads as the reset.
    expect(march.isReset).toBe(true)
  })

  it('reads recorded_on as a calendar date, not a timezone-shifted instant', async () => {
    const device = await makeDevice()
    await seedReading(device, '2026-08-01', 42)
    const res = await listDeviceUsage(logger(), device)
    expect(res!.items[0].recordedOn).toBe('2026-08-01')
  })

  it('refuses an actor without maintenance access rather than returning empty', async () => {
    await expect(listDeviceUsage(outsider(), deviceId)).rejects.toThrow(PermissionError)
  })
})

describe('listDeviceUsageSummaries', () => {
  it('reports only devices with readings, and can filter to those with a reset', async () => {
    const plain = await makeDevice()
    await seedReading(plain, '2026-05-01', 10)
    await seedReading(plain, '2026-05-02', 30)

    const wasReset = await makeDevice()
    await seedReading(wasReset, '2026-05-01', 800)
    await seedReading(wasReset, '2026-05-02', 5)

    const all = await listDeviceUsageSummaries(logger(), { limit: 200 })
    const ids = all.items.map((s) => s.deviceId)
    expect(ids).toContain(plain)
    expect(ids).toContain(wasReset)

    const resets = await listDeviceUsageSummaries(logger(), { limit: 200, resetsOnly: true })
    const resetIds = resets.items.map((s) => s.deviceId)
    expect(resetIds).toContain(wasReset)
    expect(resetIds).not.toContain(plain)
  })

  // The defect this shape exists to prevent: `resetsOnly` used to filter AFTER
  // the display limit, so asking for "devices with a reset" returned only those
  // that happened to fall inside the first N by recency. With a limit of 1 and a
  // reset device that is NOT the most recently read, the old code returned
  // nothing while the tile said one existed.
  it('applies resetsOnly BEFORE the display limit, not after', async () => {
    const wasReset = await makeDevice()
    await seedReading(wasReset, '2026-04-01', 900)
    await seedReading(wasReset, '2026-04-02', 3)   // reset, but dated older
    const newer = await makeDevice()
    await seedReading(newer, '2026-07-20', 50)     // monotonic, more recent

    const page = await listDeviceUsageSummaries(logger(), { limit: 1, resetsOnly: true })
    // The one row returned must be a reset device, never "the newest device,
    // which happens not to qualify".
    expect(page.items).toHaveLength(1)
    expect(page.items[0].hasReset).toBe(true)
    expect(page.total).toBeGreaterThanOrEqual(1)
  })

  // The other half: the table's own count must describe the filter that produced
  // it, so a tile and a table on one screen cannot disagree.
  it('reports a total that matches the filter, and a limit-independent reset count', async () => {
    const wasReset = await makeDevice()
    await seedReading(wasReset, '2026-04-10', 700)
    await seedReading(wasReset, '2026-04-11', 2)

    const wide = await listDeviceUsageSummaries(logger(), { limit: 200 })
    const narrow = await listDeviceUsageSummaries(logger(), { limit: 1 })

    // The reset tile counts the SCANNED population, so shrinking the page must
    // not change it.
    expect(narrow.devicesWithResets).toBe(wide.devicesWithResets)
    expect(narrow.total).toBe(wide.total)
    // …while the rows really are cut.
    expect(narrow.items).toHaveLength(1)
    expect(narrow.items.length).toBeLessThanOrEqual(narrow.total)

    const filtered = await listDeviceUsageSummaries(logger(), { limit: 200, resetsOnly: true })
    expect(filtered.total).toBe(filtered.items.length)
    expect(filtered.total).toBe(wide.devicesWithResets)
  })

  it('ages the latest reading against the injected today', async () => {
    const device = await makeDevice()
    await seedReading(device, '2026-05-10', 10)
    const [summary] = (await listDeviceUsageSummaries(
      logger(), { limit: 200 }, new Date('2026-05-20T00:00:00Z')))
      .items.filter((s) => s.deviceId === device)
    expect(summary.daysSinceLastReading).toBe(10)
  })
})

describe('getUsageOverview / listUsageLoggableDevices', () => {
  it('answers with SQL aggregates only — no history scan', async () => {
    const device = await makeDevice()
    await seedReading(device, '2026-06-01', 400)
    await seedReading(device, '2026-06-02', 1)

    const overview = await getUsageOverview(logger())
    // Global counts are shared with every other integration file, so assert a
    // floor rather than an equality.
    expect(overview.readingCount).toBeGreaterThanOrEqual(2)
    expect(overview.deviceCount).toBeGreaterThanOrEqual(1)
    // devicesWithResets deliberately NO LONGER lives here: counting it means
    // deriving every device's series, and this runs on the Maintenance landing
    // page. It moved to listDeviceUsageSummaries, which is bounded.
    expect('devicesWithResets' in overview).toBe(false)
  })

  it('offers every live device, carrying its latest reading for the form hint', async () => {
    const device = await makeDevice()
    await seedReading(device, '2026-07-01', 77)
    const devices = await listUsageLoggableDevices(logger())
    const row = devices.find((d) => d.id === device)
    expect(row).toBeDefined()
    expect(row!.latestReading).toBe(77)
    expect(row!.latestRecordedOn).toBe('2026-07-01')
  })
})
