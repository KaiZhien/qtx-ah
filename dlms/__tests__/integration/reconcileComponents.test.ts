import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client, Pool } from 'pg'
import { getPool } from '@/lib/db/pool'
import { migrateComponents } from '@/scripts/migrate_components'
import { reconcileComponents } from '@/scripts/reconcile'
import { migratePlatformSchema } from './setup'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

// ===========================================================================
// scripts/reconcile.ts's component half, run for real: the actual
// migrateComponents against a legacy stand-in, then the actual
// reconcileComponents over the result. Until now nothing had ever executed
// this comparison, which makes it a false safety net — the one thing standing
// between a partial migration and someone believing the fleet is complete.
//
// WHY THIS FILE OWNS A PRIVATE DATABASE, unlike every sibling in this
// directory. reconcileComponents counts the platform side GLOBALLY —
// `count(*) FROM component_installation WHERE removed_at IS NULL` and the
// matching component_unit count are unfiltered, because units cannot be scoped
// by device (an installation names a device, a unit does not) and the cutover
// target is expected to start empty. That is honest for a cutover-time check
// and fatal for a test in a shared database: componentSchema.test.ts,
// componentService.test.ts and importCommitService.test.ts each leave their
// component rows behind, ~29 open installations between them, every one of
// which reads to reconcile as an unexplained excess. No arrangement of unique
// suffixes fixes that — the comparison is a global total, so the only way to
// assert "reconcile passes" without depending on which files ran first is a
// database where the ONLY component rows are this file's.
//
// So beforeAll creates one, bootstrapped through the same
// migratePlatformSchema() the shared harness uses, and afterAll drops it. The
// legacy stand-in keeps the sibling convention exactly (a throwaway schema
// reached via `options=-c search_path=`), just inside that database. Nothing
// this file does touches the shared `public` schema at all, so it cannot make
// other runs of itself — or of anything else — flaky.
// ===========================================================================

/**
 * Fixed, not run-tagged, and deliberately so. The sibling files tag rows
 * because they live in a shared schema nobody truncates; a whole database that
 * is dropped on the way out is better served by a stable name it can
 * DROP ... IF EXISTS on the way IN, which self-heals after a run that died
 * before its afterAll (a crash, a Ctrl-C). Serials below still carry a run tag
 * so a failure message identifies its own run.
 */
const RECONCILE_DB = 'qtx_test_reconcile'
const LEGACY_FULL = 'legacy_reconcile_full'
const LEGACY_PARTIAL = 'legacy_reconcile_partial'
const runTag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

/** An installation re-pointed here has a device_id no device row can satisfy. */
const GHOST_DEVICE = '00000000-0000-0000-0000-0000000000aa'

let db: Client
let fullPool: Pool
let partialPool: Pool
let platformPool: Pool
let actorId: string
let savedDatabaseUrl: string | undefined

const devices: Record<string, string> = {}

/** The test container's URL with the database swapped. */
function urlForDatabase(database: string): string {
  const url = new URL(process.env.TEST_DATABASE_URL!)
  url.pathname = `/${database}`
  return url.toString()
}

/** Connection string pointed at `schema` within this file's private database. */
function legacyUrlForSchema(schema: string): string {
  const url = new URL(urlForDatabase(RECONCILE_DB))
  url.searchParams.set('options', `-c search_path=${schema}`)
  return url.toString()
}

/** Legacy stand-in: only the columns migrate_components.ts and reconcile.ts read. */
async function createLegacySchema(schema: string): Promise<void> {
  await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  await db.query(`CREATE SCHEMA ${schema}`)
  await db.query(`
    CREATE TABLE ${schema}.device (
      id uuid PRIMARY KEY,
      pcba_a_sn text, pcba_a_hw_rev text, pcba_a_bom_rev text, pcba_a_fw_ver text,
      pcba_b_sn text, pcba_b_hw_rev text, pcba_b_bom_rev text, pcba_b_fw_ver text,
      screen_model text, hmi_ver text,
      created_at timestamptz NOT NULL
    )`)
}

async function createDevice(variant: 'basic' | 'pro', createdAt: string): Promise<string> {
  return (await db.query<{ id: string }>(
    `INSERT INTO device (variant_id, status, created_at, created_by, updated_by)
     VALUES ((SELECT id FROM device_variant WHERE code=$1), 'in_stock', $2::timestamptz, $3, $3)
     RETURNING id`,
    [variant, createdAt, actorId])).rows[0].id
}

/**
 * Runs the real reconcileComponents and returns its verdict alongside
 * everything it printed. Both matter: the boolean is the check's contract, and
 * the lines are how an operator reads WHICH comparison failed — a test that
 * asserted only the boolean would pass just as happily if the wrong comparison
 * had fired. Output is captured rather than merely silenced so a failed
 * expectation can show it.
 */
async function runReconcile(legacy: Pool = fullPool): Promise<{ ok: boolean; out: string }> {
  const log = vi.spyOn(console, 'log').mockImplementation(() => {})
  const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
  try {
    const ok = await reconcileComponents(legacy, platformPool)
    const out = [...log.mock.calls, ...warn.mock.calls].map((c) => c.join(' ')).join('\n')
    return { ok, out }
  } finally {
    log.mockRestore()
    warn.mockRestore()
  }
}

/**
 * One statement with user triggers suppressed, inside its own transaction.
 *
 * SET LOCAL dies with the transaction, so the suppression cannot outlive the
 * statement it exists for even if that statement throws — and nothing about the
 * schema is altered, which is the point. The orphan case below needs an
 * installation whose device_id violates a live foreign key; DROPping and
 * re-ADDing that FK would leave the schema modified for every later test if the
 * restore never ran, whereas replica mode is a session setting on a connection
 * this file owns. It also gets past fn_component_installation_guard, which
 * rejects the UPDATE outright, and keeps fn_audit from recording the fixture.
 */
async function withTriggersSuppressed(sql: string, params: unknown[]): Promise<void> {
  await db.query('BEGIN')
  try {
    await db.query(`SET LOCAL session_replication_role = 'replica'`)
    await db.query(sql, params)
    await db.query('COMMIT')
  } catch (err) {
    await db.query('ROLLBACK')
    throw err
  }
}

beforeAll(async () => {
  const maintenance = new Client({ connectionString: urlForDatabase('postgres') })
  await maintenance.connect()
  try {
    // FORCE (Postgres 13+) so a previous run that died holding a connection
    // cannot wedge this one.
    await maintenance.query(`DROP DATABASE IF EXISTS ${RECONCILE_DB} WITH (FORCE)`)
    await maintenance.query(`CREATE DATABASE ${RECONCILE_DB}`)
  } finally {
    await maintenance.end()
  }
  await migratePlatformSchema(urlForDatabase(RECONCILE_DB))

  // Set BEFORE anything can call getPool(): migrateComponents reads through the
  // pool passed to it but WRITES through the getPool() singleton bound to
  // DATABASE_URL, so this is what actually aims the migration at the private
  // database. Restored in afterAll — Vitest reuses a worker process across
  // files, and a stray DATABASE_URL would follow this file into the next one.
  savedDatabaseUrl = process.env.DATABASE_URL
  process.env.DATABASE_URL = urlForDatabase(RECONCILE_DB)

  db = new Client({ connectionString: urlForDatabase(RECONCILE_DB) })
  await db.connect()
  actorId = (await db.query(
    `SELECT id FROM app_user WHERE email='reetmitra8@gmail.com'`)).rows[0].id

  // ---------------------------------------------------------------------
  // Six devices populating ONE, TWO and THREE component groups. The shape is
  // the whole point of the comparison: reconcile derives the expected
  // installation count as a sum of three independent filters, so a fixture of
  // devices × 3 would agree with a mistaken `count(device) * 3` just as well
  // and prove nothing. Here 6 devices produce 9 installations and 6 units —
  // three numbers, all different.
  // ---------------------------------------------------------------------
  for (const [key, variant, at] of [
    ['three', 'pro', '2026-03-14 08:00:00+00'],
    ['two', 'pro', '2026-03-15 08:00:00+00'],
    ['one', 'basic', '2026-03-16 08:00:00+00'],
    ['sharedNull', 'basic', '2026-03-17 08:00:00+00'],
    ['sharedBlank', 'basic', '2026-03-18 08:00:00+00'],
    ['blankScreen', 'basic', '2026-03-19 08:00:00+00'],
  ] as const) {
    devices[key] = await createDevice(variant, at)
  }

  await createLegacySchema(LEGACY_FULL)
  await db.query(
    `INSERT INTO ${LEGACY_FULL}.device (
       id, pcba_a_sn, pcba_a_hw_rev, pcba_a_bom_rev, pcba_a_fw_ver,
       pcba_b_sn, pcba_b_hw_rev, pcba_b_bom_rev, pcba_b_fw_ver,
       screen_model, hmi_ver, created_at) VALUES
     -- three groups: both boards and a screen
     ($1, $7, 'V1.2', 'B3', '1.0.4', $8, 'V2.0', NULL, '2.1', 'TK-070', '3.2',
      timestamptz '2026-03-14 08:00:00+00'),
     -- two groups: one board, and a screen known only by its firmware version
     ($2, $9, 'V1.0', 'B1', '1.0.0', NULL, NULL, NULL, NULL, NULL, '3.3',
      timestamptz '2026-03-15 08:00:00+00'),
     -- one group: the accessory board only, and NO empty primary board invented
     ($3, NULL, NULL, NULL, NULL, $10, 'V3.0', 'B9', '3.0.1', NULL, NULL,
      timestamptz '2026-03-16 08:00:00+00'),
     -- one group, sharing a serial with the next row; revisions all NULL
     ($4, NULL, NULL, NULL, NULL, $11, NULL, NULL, NULL, NULL, NULL,
      timestamptz '2026-03-17 08:00:00+00'),
     -- ...and the same serial with BLANK revisions, which must read as the
     -- same thing the NULLs above do, not as a disagreement
     ($5, NULL, NULL, NULL, NULL, $11, '', '   ', '', NULL, NULL,
      timestamptz '2026-03-18 08:00:00+00'),
     -- one group: a whitespace-only screen is no screen, on both sides
     ($6, $12, 'V4.0', NULL, NULL, NULL, NULL, NULL, NULL, '   ', '',
      timestamptz '2026-03-19 08:00:00+00')`,
    [devices.three, devices.two, devices.one, devices.sharedNull, devices.sharedBlank,
      devices.blankScreen,
      `A1-${runTag}`, `B1-${runTag}`, `A2-${runTag}`, `B3-${runTag}`, `SHARED-${runTag}`,
      `A6-${runTag}`])

  // The same legacy data with the last three devices missing — a migration
  // that stopped half way, which is exactly the state reconcile exists to
  // refuse. The platform devices all exist either way; only their components
  // are absent.
  await createLegacySchema(LEGACY_PARTIAL)
  await db.query(
    `INSERT INTO ${LEGACY_PARTIAL}.device
     SELECT * FROM ${LEGACY_FULL}.device WHERE id = ANY($1::uuid[])`,
    [[devices.three, devices.two, devices.one]])

  fullPool = new Pool({ connectionString: legacyUrlForSchema(LEGACY_FULL) })
  partialPool = new Pool({ connectionString: legacyUrlForSchema(LEGACY_PARTIAL) })
  platformPool = new Pool({ connectionString: urlForDatabase(RECONCILE_DB) })
})

afterAll(async () => {
  // No row-level teardown: everything this file created — platform rows, both
  // legacy schemas, the units and installations the migration wrote — goes
  // with the database.
  await fullPool?.end()
  await partialPool?.end()
  await platformPool?.end()
  await db?.end()
  await getPool().end()

  if (savedDatabaseUrl === undefined) delete process.env.DATABASE_URL
  else process.env.DATABASE_URL = savedDatabaseUrl

  const maintenance = new Client({ connectionString: urlForDatabase('postgres') })
  await maintenance.connect()
  try {
    await maintenance.query(`DROP DATABASE IF EXISTS ${RECONCILE_DB} WITH (FORCE)`)
  } finally {
    await maintenance.end()
  }
})

// ===========================================================================
// The failing direction first, because a reconciliation that has only ever
// been seen to pass has not been seen to work.
// ===========================================================================

describe('reconcileComponents — a partial migration', () => {
  it('fails before the back-fill has run at all', async () => {
    const { ok, out } = await runReconcile()
    expect(out).toMatch(
      /MISMATCH {2}open component_installation rows vs populated legacy groups: source=9 target=0/)
    expect(out).toMatch(
      /MISMATCH {2}component_unit rows \(pcba_a\+pcba_b\) vs distinct legacy serials: source=6 target=0/)
    expect(ok).toBe(false)
  })

  it('still fails when only some devices migrated', async () => {
    const result = await migrateComponents(partialPool, platformPool, actorId)
    expect(result.installsCreated).toBe(6)   // the three-, two- and one-group devices
    expect(result.unitsCreated).toBe(4)

    // Reconcile is asked about the FULL legacy set, which is the real
    // situation: the operator does not know the run stopped early.
    const { ok, out } = await runReconcile()
    expect(out).toMatch(
      /MISMATCH {2}open component_installation rows vs populated legacy groups: source=9 target=6/)
    expect(out).toMatch(
      /MISMATCH {2}component_unit rows \(pcba_a\+pcba_b\) vs distinct legacy serials: source=6 target=4/)
    expect(ok).toBe(false)
  })
})

// ===========================================================================
// The legacy-side SQL in reconcile.ts is a transcription of what
// mapLegacyComponents does, written independently of it. This is the assertion
// that the two agree — on a fixture where a wrong-but-plausible derivation
// (devices × 3, or installations == units) gives a different answer.
// ===========================================================================

describe('reconcileComponents — a complete migration', () => {
  it('passes once the migration is re-run over the full legacy set', async () => {
    const result = await migrateComponents(fullPool, platformPool, actorId)
    expect(result.installsCreated).toBe(3)   // only the three that were missing
    expect(result.unitsCreated).toBe(2)
    expect(result.missingDevices).toEqual([])

    const { ok, out } = await runReconcile()
    expect(out).toMatch(
      /OK {6} {2}open component_installation rows vs populated legacy groups: source=9 target=9/)
    expect(out).toMatch(
      /OK {6} {2}component_unit rows \(pcba_a\+pcba_b\) vs distinct legacy serials: source=6 target=6/)
    expect(out).toMatch(
      /OK {6} {2}component_installation rows whose device_id has no device: source=0 target=0/)
    expect(ok).toBe(true)
  })

  it('reconciles three genuinely different numbers, not one restated three ways', async () => {
    // 6 devices, 9 installations, 6 units. If any pair of these were equal the
    // comparison above could be satisfied by a derivation that is simply wrong,
    // so the fixture's shape is asserted rather than left to a reader to verify.
    const counts = (await db.query<{ devices: string; installs: string; units: string }>(
      `SELECT (SELECT count(*) FROM device)::text AS devices,
              (SELECT count(*) FROM component_installation WHERE removed_at IS NULL)::text AS installs,
              (SELECT count(*) FROM component_unit WHERE deleted_at IS NULL)::text AS units`)).rows[0]
    expect(counts).toEqual({ devices: '6', installs: '9', units: '6' })

    // ...and the 9 are not 3+3+3 either: one device populated three groups,
    // one populated two, and four populated one each.
    const perDevice = (await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM component_installation
        GROUP BY device_id ORDER BY 1 DESC`)).rows.map((r) => r.n)
    expect(perDevice).toEqual(['3', '2', '1', '1', '1', '1'])
  })

  it('stays green on an idempotent re-run', async () => {
    const again = await migrateComponents(fullPool, platformPool, actorId)
    expect(again.installsCreated).toBe(0)
    expect(again.unitsCreated).toBe(0)

    const { ok } = await runReconcile()
    expect(ok).toBe(true)
  })
})

// ===========================================================================
// A NULL revision and a blank one are the same absence of information. The
// mapper's text() collapses both to null; reconcile's LEGACY_SERIALS collapses
// both with btrim(coalesce(x,'')). If either side stopped doing that, two
// devices honestly carrying one board would be reported as disagreeing about
// it — a divergence invented out of empty strings.
// ===========================================================================

describe('reconcileComponents — NULL versus blank revisions', () => {
  it('treats one shared serial as one unit with two installations', async () => {
    const { rows } = await db.query<{ n: string; installs: string }>(
      `SELECT count(*)::text AS n,
              (SELECT count(*)::text FROM component_installation ci
                WHERE ci.component_unit_id = cu.id) AS installs
         FROM component_unit cu WHERE cu.serial_no = $1 GROUP BY cu.id`,
      [`SHARED-${runTag}`])
    expect(rows).toHaveLength(1)      // one physical board, one identity
    expect(rows[0].installs).toBe('2')
  })

  it('does not count the NULL/blank pair as a divergence', async () => {
    const { ok, out } = await runReconcile()
    expect(out).toMatch(
      /legacy serials shared by devices with DIVERGENT revisions \(not compared\): 0$/m)
    expect(ok).toBe(true)
  })

  it('does count a real disagreement, so the zero above is not vacuous', async () => {
    // Two more devices sharing a serial and genuinely disagreeing about its
    // revisions. Both sides move together — 2 more populated groups, 1 more
    // distinct serial — so reconcile still PASSES; only the reported
    // observation changes, which is exactly reconcile's contract for it.
    const first = await createDevice('basic', '2026-03-20 08:00:00+00')
    const second = await createDevice('basic', '2026-03-21 08:00:00+00')
    await db.query(
      `INSERT INTO ${LEGACY_FULL}.device
         (id, pcba_b_sn, pcba_b_hw_rev, pcba_b_bom_rev, pcba_b_fw_ver, created_at)
       VALUES ($1, $3, 'V1.0', 'B1', '1.0.0', timestamptz '2026-03-20 08:00:00+00'),
              ($2, $3, 'V2.0', 'B2', '2.0.0', timestamptz '2026-03-21 08:00:00+00')`,
      [first, second, `DIVERGE-${runTag}`])

    const result = await migrateComponents(fullPool, platformPool, actorId)
    expect(result.installsCreated).toBe(2)
    expect(result.unitsCreated).toBe(1)

    const { ok, out } = await runReconcile()
    expect(out).toMatch(
      /legacy serials shared by devices with DIVERGENT revisions \(not compared\): 1 —/)
    expect(out).toMatch(
      /OK {6} {2}open component_installation rows vs populated legacy groups: source=11 target=11/)
    expect(out).toMatch(
      /OK {6} {2}component_unit rows \(pcba_a\+pcba_b\) vs distinct legacy serials: source=7 target=7/)
    expect(ok).toBe(true)   // reported, never failed — spec §15's rider
  })
})

// ===========================================================================
// The orphan check exists because component_installation.device_id is NOT NULL
// REFERENCES device(id), so reconcile is deliberately not trusting that the
// constraint is still there. A test that never produces an orphan proves only
// that a query returning 0 compares equal to 0.
// ===========================================================================

describe('reconcileComponents — the orphan-installation check', () => {
  it('detects an installation whose device_id has no device', async () => {
    const target = (await db.query<{ id: string; device_id: string }>(
      `SELECT id, device_id FROM component_installation WHERE device_id = $1 LIMIT 1`,
      [devices.one])).rows[0]

    // Re-pointed, not inserted: an extra row would ALSO make the installation
    // count fail, and then a passing test could not tell which comparison had
    // caught the orphan. Moving an existing row keeps every other total exactly
    // where it was, so the orphan line is provably the one that fires.
    await withTriggersSuppressed(
      `UPDATE component_installation SET device_id = $1 WHERE id = $2`, [GHOST_DEVICE, target.id])
    try {
      const { ok, out } = await runReconcile()
      expect(out).toMatch(
        /MISMATCH {2}component_installation rows whose device_id has no device: source=0 target=1/)
      expect(ok).toBe(false)

      // The two count comparisons are untouched — the orphan check alone failed.
      expect(out).toMatch(/OK {6} {2}open component_installation rows/)
      expect(out).toMatch(/OK {6} {2}component_unit rows/)
    } finally {
      await withTriggersSuppressed(
        `UPDATE component_installation SET device_id = $1 WHERE id = $2`,
        [target.device_id, target.id])
    }

    // Restored, and green again: the orphan was the only thing wrong.
    const { ok } = await runReconcile()
    expect(ok).toBe(true)
  })
})
