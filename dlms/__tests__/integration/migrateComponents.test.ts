import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client, Pool } from 'pg'
import { getPool } from '@/lib/db/pool'
import { migrateComponents } from '@/scripts/migrate_components'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

const SCHEMA = 'legacy_components_src'
const runTag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

let db: Client
let legacyPool: Pool
let platformPool: Pool
let actorId: string
let deviceId: string
let orphanId: string

/**
 * Every platform device and legacy schema this FILE creates, so afterAll can
 * put the shared test database back the way it found it. Component units are
 * cleaned by serial instead — every serial below carries `runTag`.
 */
const createdDeviceIds: string[] = []
const legacySchemas: string[] = [SCHEMA]
const extraPools: Pool[] = []

/** Connection string pointed at `schema` within the same test database. */
function legacyUrlForSchema(schema: string): string {
  const url = new URL(process.env.TEST_DATABASE_URL!)
  url.searchParams.set('options', `-c search_path=${schema}`)
  return url.toString()
}

/** A platform device for the migration to hang components off, tracked for teardown. */
async function createDevice(variant: 'basic' | 'pro', createdAt: string): Promise<string> {
  const id = (await db.query<{ id: string }>(
    `INSERT INTO device (variant_id, status, created_at, created_by, updated_by)
     VALUES ((SELECT id FROM device_variant WHERE code=$1), 'in_stock', $2::timestamptz, $3, $3)
     RETURNING id`,
    [variant, createdAt, actorId])).rows[0].id
  createdDeviceIds.push(id)
  return id
}

/** Legacy stand-in: only the columns the runner reads. */
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
  if (!legacySchemas.includes(schema)) legacySchemas.push(schema)
}

function poolForSchema(schema: string): Pool {
  const pool = new Pool({ connectionString: legacyUrlForSchema(schema) })
  extraPools.push(pool)
  return pool
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  actorId = (await db.query(
    `SELECT id FROM app_user WHERE email='reetmitra8@gmail.com'`)).rows[0].id

  deviceId = await createDevice('pro', '2026-03-14 08:00:00+00')
  orphanId = '00000000-0000-0000-0000-0000000000ff'

  await createLegacySchema(SCHEMA)
  await db.query(
    `INSERT INTO ${SCHEMA}.device VALUES
       ($1, $2, 'V1.2', 'B3', '1.0.4', $3, 'V2.0', NULL, '2.1', 'TK-070', '3.2',
        timestamptz '2026-03-14 08:00:00+00'),
       ($4, $5, 'V1.0', 'B1', '1.0.0', NULL, NULL, NULL, NULL, NULL, NULL,
        timestamptz '2026-03-15 08:00:00+00')`,
    [deviceId, `A-${runTag}`, `B-${runTag}`, orphanId, `ORPHAN-${runTag}`])

  legacyPool = new Pool({ connectionString: legacyUrlForSchema(SCHEMA) })
  platformPool = new Pool({ connectionString: process.env.TEST_DATABASE_URL })
})

afterAll(async () => {
  for (const schema of legacySchemas) {
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  }

  // The platform rows this file created live in `public` alongside everyone
  // else's, so they get deleted rather than dropped with a schema.
  // component_installation is append-only — fn_component_installation_guard
  // raises on DELETE — so teardown suppresses user triggers for the duration.
  // SET (not SET LOCAL) is scoped to THIS client's session, and this client is
  // closed immediately below; it also keeps fn_audit from recording the
  // teardown itself.
  await db.query(`SET session_replication_role = 'replica'`)
  await db.query(
    `DELETE FROM audit_log WHERE table_name = 'component_installation'
       AND row_id IN (SELECT id FROM component_installation WHERE device_id = ANY($1::uuid[]))`,
    [createdDeviceIds])
  await db.query(
    `DELETE FROM audit_log WHERE table_name = 'component_unit'
       AND row_id IN (SELECT id FROM component_unit WHERE serial_no LIKE $1)`, [`%${runTag}%`])
  await db.query(`DELETE FROM audit_log WHERE row_id = ANY($1::uuid[])`, [createdDeviceIds])
  await db.query(
    `DELETE FROM component_installation WHERE device_id = ANY($1::uuid[])`, [createdDeviceIds])
  await db.query(`DELETE FROM component_unit WHERE serial_no LIKE $1`, [`%${runTag}%`])
  await db.query(`DELETE FROM device WHERE id = ANY($1::uuid[])`, [createdDeviceIds])
  await db.query(`SET session_replication_role = 'origin'`)

  await legacyPool.end(); await platformPool.end()
  for (const pool of extraPools) await pool.end()
  await db.end(); await getPool().end()
})

describe('migrateComponents', () => {
  it('creates units and open installations for every populated group', async () => {
    const result = await migrateComponents(legacyPool, platformPool, actorId)
    expect(result.unitsCreated).toBe(2)      // pcba_a + pcba_b; the screen has no unit
    expect(result.installsCreated).toBe(3)   // pcba_a + pcba_b + hmi_screen

    const { rows } = await db.query<{
      code: string; serial_no: string | null; batch_no: string | null
      hw_rev: string | null; fw_ver: string | null; installed_at: Date; removed_at: Date | null
    }>(
      `SELECT ct.code, cu.serial_no, ci.batch_no, cu.hw_rev, cu.fw_ver,
              ci.installed_at, ci.removed_at
         FROM component_installation ci
         JOIN component_type ct ON ct.id = ci.component_type_id
         LEFT JOIN component_unit cu ON cu.id = ci.component_unit_id
        WHERE ci.device_id = $1 ORDER BY ct.sort`, [deviceId])
    expect(rows.map((r) => r.code)).toEqual(['pcba_a', 'pcba_b', 'hmi_screen'])
    expect(rows[0].serial_no).toBe(`A-${runTag}`)
    expect(rows[0].hw_rev).toBe('V1.2')
    expect(rows[1].fw_ver).toBe('2.1')
    expect(rows.every((r) => r.removed_at === null)).toBe(true)
  })

  it('stamps installed_at from the legacy device creation time', async () => {
    const { rows } = await db.query<{ installed_at: Date }>(
      `SELECT installed_at FROM component_installation WHERE device_id=$1 LIMIT 1`, [deviceId])
    expect(rows[0].installed_at.toISOString()).toBe('2026-03-14T08:00:00.000Z')
  })

  it('migrates the screen as a batch installation with no unit row', async () => {
    const { rows } = await db.query<{ component_unit_id: string | null; batch_no: string; notes: string }>(
      `SELECT ci.component_unit_id, ci.batch_no, ci.notes
         FROM component_installation ci JOIN component_type ct ON ct.id = ci.component_type_id
        WHERE ci.device_id = $1 AND ct.code = 'hmi_screen'`, [deviceId])
    expect(rows[0].component_unit_id).toBeNull()
    expect(rows[0].batch_no).toBe('TK-070')
    expect(rows[0].notes).toContain('3.2')
  })

  it('marks created units as installed', async () => {
    const { rows } = await db.query<{ disposition: string }>(
      `SELECT disposition FROM component_unit WHERE serial_no = $1`, [`A-${runTag}`])
    expect(rows[0].disposition).toBe('installed')
  })

  it('reports a legacy device with no platform counterpart instead of creating one', async () => {
    const result = await migrateComponents(legacyPool, platformPool, actorId)
    expect(result.missingDevices).toContain(orphanId)
    const { rows } = await db.query(`SELECT 1 FROM device WHERE id = $1`, [orphanId])
    expect(rows).toHaveLength(0)
  })

  it('is idempotent — a second run creates nothing', async () => {
    const again = await migrateComponents(legacyPool, platformPool, actorId)
    expect(again.unitsCreated).toBe(0)
    expect(again.installsCreated).toBe(0)
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM component_installation WHERE device_id = $1`, [deviceId])
    expect(rows[0].n).toBe('3')
  })

  it('leaves the component audit trail enabled — these are genuine platform writes', async () => {
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log
        WHERE table_name = 'component_unit' AND row_id IN
              (SELECT id FROM component_unit WHERE serial_no = $1)`, [`A-${runTag}`])
    expect(Number(rows[0].n)).toBeGreaterThan(0)
  })
})

describe('migrateComponents — flagged serials', () => {
  it('carries a ranged serial verbatim as one unit, flags needs_split, and reports it', async () => {
    const rangedDevice = await createDevice('basic', '2026-05-01 08:00:00+00')
    const ranged = `EE-${runTag}-0001 to 0015`
    await db.query(
      `INSERT INTO ${SCHEMA}.device (id, pcba_a_sn, created_at)
       VALUES ($1, $2, timestamptz '2026-05-01 08:00:00+00')`,
      [rangedDevice, ranged])

    const result = await migrateComponents(legacyPool, platformPool, actorId)
    const { rows } = await db.query<{ serial_no: string; needs_split: boolean }>(
      `SELECT serial_no, needs_split FROM component_unit WHERE serial_no = $1`, [ranged])
    expect(rows).toHaveLength(1)                 // ONE unit, not fifteen
    expect(rows[0].needs_split).toBe(true)
    expect(result.flaggedSerials.some((f) => f.serialNo === ranged)).toBe(true)
  })
})

// ===========================================================================
// The back-fill only ever SEEDS history. A slot the platform has since taken
// over — through a removal, with or without a replacement — is never touched
// again, no matter how many times this script is re-run.
// ===========================================================================

describe('migrateComponents — slots the platform has taken over', () => {
  it('does not resurrect an installation that was removed and NOT replaced', async () => {
    const device = await createDevice('basic', '2026-06-01 08:00:00+00')
    await db.query(
      `INSERT INTO ${SCHEMA}.device (id, pcba_a_sn, created_at)
       VALUES ($1, $2, timestamptz '2026-06-01 08:00:00+00')`,
      [device, `REMOVED-${runTag}`])

    await migrateComponents(legacyPool, platformPool, actorId)
    const first = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM component_installation WHERE device_id = $1`, [device])
    expect(first.rows[0].n).toBe('1')

    // Someone pulls the board out through the UI and does not fit a new one:
    // the one-time removal stamp is the only UPDATE the append-only guard
    // permits, and it leaves NO open row for ON CONFLICT to catch.
    await db.query(
      `UPDATE component_installation SET removed_at = now(), removed_by = $2,
              removal_reason = 'removed in service'
        WHERE device_id = $1`, [device, actorId])

    const again = await migrateComponents(legacyPool, platformPool, actorId)
    expect(again.installsCreated).toBe(0)

    const { rows } = await db.query<{ removed_at: Date | null }>(
      `SELECT removed_at FROM component_installation WHERE device_id = $1`, [device])
    expect(rows).toHaveLength(1)                  // not two — no back-dated resurrection
    expect(rows[0].removed_at).not.toBeNull()     // and the slot stays empty
  })

  it('does not add a third row when the component was removed AND replaced', async () => {
    const device = await createDevice('basic', '2026-06-02 08:00:00+00')
    await db.query(
      `INSERT INTO ${SCHEMA}.device (id, pcba_a_sn, created_at)
       VALUES ($1, $2, timestamptz '2026-06-02 08:00:00+00')`,
      [device, `REPLACED-${runTag}`])

    await migrateComponents(legacyPool, platformPool, actorId)

    const typeId = (await db.query<{ id: string }>(
      `SELECT id FROM component_type WHERE code = 'pcba_a'`)).rows[0].id
    await db.query(
      `UPDATE component_installation SET removed_at = now(), removed_by = $2,
              removal_reason = 'swapped'
        WHERE device_id = $1`, [device, actorId])
    const replacementUnit = (await db.query<{ id: string }>(
      `INSERT INTO component_unit (component_type_id, serial_no, disposition, created_by)
       VALUES ($1, $2, 'installed', $3) RETURNING id`,
      [typeId, `REPLACEMENT-${runTag}`, actorId])).rows[0].id
    await db.query(
      `INSERT INTO component_installation (
         device_id, component_type_id, component_unit_id, installed_at, installed_by, created_by)
       VALUES ($1, $2, $3, now(), $4, $4)`, [device, typeId, replacementUnit, actorId])

    const again = await migrateComponents(legacyPool, platformPool, actorId)
    expect(again.installsCreated).toBe(0)

    const { rows } = await db.query<{ serial_no: string; removed_at: Date | null }>(
      `SELECT cu.serial_no, ci.removed_at
         FROM component_installation ci JOIN component_unit cu ON cu.id = ci.component_unit_id
        WHERE ci.device_id = $1 ORDER BY ci.installed_at`, [device])
    expect(rows).toHaveLength(2)
    expect(rows[0].serial_no).toBe(`REPLACED-${runTag}`)
    expect(rows[0].removed_at).not.toBeNull()
    expect(rows[1].serial_no).toBe(`REPLACEMENT-${runTag}`)
    expect(rows[1].removed_at).toBeNull()
  })
})

// ===========================================================================
// Two devices carrying the SAME serial for the same component type with
// DIFFERENT revisions. The existing unit is reused (§15 forbids inventing a
// second identity for one physical part), so the second row's revisions are
// stored nowhere — they must therefore be reported, not silently dropped.
// Realistic: legacy pcba_a_sn has a unique index, pcba_b_sn has none.
// ===========================================================================

describe('migrateComponents — a shared serial with divergent revisions', () => {
  const shared = `SHARED-B-${runTag}`
  let firstDevice: string
  let secondDevice: string

  beforeAll(async () => {
    firstDevice = await createDevice('basic', '2026-06-10 08:00:00+00')
    secondDevice = await createDevice('basic', '2026-06-11 08:00:00+00')
    await db.query(
      `INSERT INTO ${SCHEMA}.device (id, pcba_b_sn, pcba_b_hw_rev, pcba_b_bom_rev, pcba_b_fw_ver, created_at)
       VALUES ($1, $3, 'V1.0', 'B1', '1.0.0', timestamptz '2026-06-10 08:00:00+00'),
              ($2, $3, 'V2.0', 'B2', '2.0.0', timestamptz '2026-06-11 08:00:00+00')`,
      [firstDevice, secondDevice, shared])
  })

  it('reuses the one unit, keeps the first revisions, and REPORTS the divergence', async () => {
    const result = await migrateComponents(legacyPool, platformPool, actorId)

    const units = await db.query<{ hw_rev: string; bom_rev: string; fw_ver: string }>(
      `SELECT hw_rev, bom_rev, fw_ver FROM component_unit WHERE serial_no = $1`, [shared])
    expect(units.rows).toHaveLength(1)                 // one physical board, one identity
    expect(units.rows[0].hw_rev).toBe('V1.0')          // write behaviour unchanged

    const divergent = result.divergentUnits.filter((d) => d.serialNo === shared)
    expect(divergent).toHaveLength(1)
    expect(divergent[0]).toMatchObject({
      deviceId: secondDevice,
      typeCode: 'pcba_b',
      serialNo: shared,
      existing: { hwRev: 'V1.0', bomRev: 'B1', fwVer: '1.0.0' },
      incoming: { hwRev: 'V2.0', bomRev: 'B2', fwVer: '2.0.0' },
    })
  })

  it('reports it again on a re-run — like needs_split it is a queue a human works', async () => {
    const again = await migrateComponents(legacyPool, platformPool, actorId)
    expect(again.divergentUnits.some((d) => d.serialNo === shared)).toBe(true)
    expect(again.unitsCreated).toBe(0)
    expect(again.installsCreated).toBe(0)
  })

  it('does not report divergence for a re-run whose revisions match', async () => {
    const again = await migrateComponents(legacyPool, platformPool, actorId)
    expect(again.divergentUnits.some((d) => d.serialNo === `A-${runTag}`)).toBe(false)
  })
})

// ===========================================================================
// Keyset paging. Every test above fits in one page, so the
// `WHERE (created_at, id) > ($1, $2)` continuation branch never runs — the
// injectable page size makes it reachable with six rows instead of 500+.
// Three of the six share one created_at, which is the case keyset paging is
// subtle about and the real fleet exhibits.
// ===========================================================================

describe('migrateComponents — keyset continuation across pages', () => {
  const PAGING_SCHEMA = 'legacy_components_paging'
  let pagingPool: Pool
  let deviceIds: string[]

  beforeAll(async () => {
    await createLegacySchema(PAGING_SCHEMA)
    deviceIds = []
    for (let i = 0; i < 6; i += 1) {
      // The first three share one timestamp, the last three share another.
      const at = i < 3 ? '2026-04-01 00:00:00+00' : '2026-04-02 00:00:00+00'
      const id = await createDevice('basic', at)
      deviceIds.push(id)
      await db.query(
        `INSERT INTO ${PAGING_SCHEMA}.device (id, pcba_a_sn, created_at)
         VALUES ($1, $2, $3::timestamptz)`, [id, `PAGE-${i}-${runTag}`, at])
    }
    pagingPool = poolForSchema(PAGING_SCHEMA)
  })

  it('processes every row exactly once with a page size smaller than the row count', async () => {
    const result = await migrateComponents(pagingPool, platformPool, actorId, 2)

    expect(result.devicesSeen).toBe(6)
    expect(result.unitsCreated).toBe(6)
    expect(result.installsCreated).toBe(6)
    expect(result.missingDevices).toEqual([])

    const { rows } = await db.query<{ device_id: string; n: string; serial_no: string }>(
      `SELECT ci.device_id, count(*)::text AS n, min(cu.serial_no) AS serial_no
         FROM component_installation ci JOIN component_unit cu ON cu.id = ci.component_unit_id
        WHERE ci.device_id = ANY($1::uuid[])
        GROUP BY ci.device_id`, [deviceIds])
    expect(rows).toHaveLength(6)                       // none skipped
    expect(rows.every((r) => r.n === '1')).toBe(true)  // none processed twice
    expect(rows.map((r) => r.serial_no).sort()).toEqual(
      [0, 1, 2, 3, 4, 5].map((i) => `PAGE-${i}-${runTag}`).sort())
  })

  it('stays idempotent across pages on a re-run', async () => {
    const again = await migrateComponents(pagingPool, platformPool, actorId, 2)
    expect(again.devicesSeen).toBe(6)
    expect(again.unitsCreated).toBe(0)
    expect(again.installsCreated).toBe(0)
  })
})

// ===========================================================================
// A failure part-way through must leave the operator able to tell what
// committed and where to resume — batch 1 of 3 commits, batch 2 rolls back,
// batch 3 never runs, and the summary says exactly that BEFORE the error.
// ===========================================================================

describe('migrateComponents — partial summary on a mid-run failure', () => {
  const FAIL_SCHEMA = 'legacy_components_fail'
  let failPool: Pool
  let ids: string[]

  beforeAll(async () => {
    await createLegacySchema(FAIL_SCHEMA)
    ids = []
    for (let i = 0; i < 3; i += 1) {
      const id = await createDevice('basic', `2026-04-1${i} 00:00:00+00`)
      ids.push(id)
      // The middle row's serial trips the fault-injection trigger below.
      const serial = i === 1 ? `BOOM-${runTag}` : `FAIL-${i}-${runTag}`
      await db.query(
        `INSERT INTO ${FAIL_SCHEMA}.device (id, pcba_a_sn, created_at)
         VALUES ($1, $2, $3::timestamptz)`, [id, serial, `2026-04-1${i} 00:00:00+00`])
    }
    failPool = poolForSchema(FAIL_SCHEMA)
  })

  it('prints what committed, the failing batch and device, and the resume point', async () => {
    // Fault injection: a real Postgres error raised from inside the batch
    // transaction, on the connection the runner is actually using — the same
    // shape as any constraint violation, without needing one that fits.
    await db.query(`
      CREATE FUNCTION fn_test_boom() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW.serial_no LIKE '%BOOM%' THEN
          RAISE EXCEPTION 'injected failure for %', NEW.serial_no;
        END IF;
        RETURN NEW;
      END $$`)
    await db.query(`
      CREATE TRIGGER trg_test_boom BEFORE INSERT ON component_unit
        FOR EACH ROW EXECUTE FUNCTION fn_test_boom()`)

    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const error = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      await expect(migrateComponents(failPool, platformPool, actorId, 1))
        .rejects.toThrow(/injected failure/)

      const out = log.mock.calls.map((c) => c.join(' ')).join('\n')
      expect(out).toContain('PARTIAL RESULT — RUN FAILED during batch 2')
      expect(out).toMatch(/Legacy devices seen:\s+2/)   // rows READ, incl. the failed batch
      expect(out).toMatch(/Component units:\s+1/)       // COMMITTED only
      expect(out).toMatch(/Installations:\s+1/)
      expect(out).toContain(`Failed while processing device: ${ids[1]}`)
      expect(out).toContain(`id=${ids[0]}`)               // resume point = last committed row
    } finally {
      log.mockRestore(); warn.mockRestore(); error.mockRestore()
      await db.query(`DROP TRIGGER trg_test_boom ON component_unit`)
      await db.query(`DROP FUNCTION fn_test_boom()`)
    }

    // Batch 1 committed, batch 2 rolled back, batch 3 never ran.
    const { rows } = await db.query<{ device_id: string }>(
      `SELECT device_id FROM component_installation WHERE device_id = ANY($1::uuid[])`, [ids])
    expect(rows.map((r) => r.device_id)).toEqual([ids[0]])
    const units = await db.query(
      `SELECT 1 FROM component_unit WHERE serial_no = $1`, [`BOOM-${runTag}`])
    expect(units.rows).toHaveLength(0)
  })
})

// ===========================================================================
// main() end-to-end, the way migrateDemo.test.ts does it: a throwaway schema
// in the SAME database stands in for "the legacy project", pointed at via the
// `options=-c search_path=...` connection parameter, while DATABASE_URL
// resolves to the already-migrated platform schema in `public`.
//
// These run LAST and each through a FRESH module instance: main() now closes
// the getPool() singleton on its way out (that is the fix for the 30s
// idle-timeout hang), and pg rejects a second end() on the same pool. A fresh
// module registry gives each invocation its own singleton and leaves the one
// this file's own migrateComponents calls used untouched.
// ===========================================================================

describe('main()', () => {
  const MAIN_SCHEMA = 'legacy_components_main'
  const ORPHAN_SCHEMA = 'legacy_components_main_orphan'
  let savedLegacyUrl: string | undefined
  let savedAppEnv: string | undefined
  let savedExitCode: number | string | undefined
  let mainDevice: string

  async function runMainFresh(): Promise<void> {
    vi.resetModules()
    const mod = await import('@/scripts/migrate_components')
    await mod.main()
  }

  beforeAll(async () => {
    savedLegacyUrl = process.env.LEGACY_DATABASE_URL
    savedAppEnv = process.env.APP_ENV
    savedExitCode = process.exitCode

    await createLegacySchema(MAIN_SCHEMA)
    mainDevice = await createDevice('pro', '2026-04-20 00:00:00+00')
    await db.query(
      `INSERT INTO ${MAIN_SCHEMA}.device (id, pcba_a_sn, pcba_a_hw_rev, created_at)
       VALUES ($1, $2, 'V9.9', timestamptz '2026-04-20 00:00:00+00')`,
      [mainDevice, `MAIN-${runTag}`])

    await createLegacySchema(ORPHAN_SCHEMA)
    await db.query(
      `INSERT INTO ${ORPHAN_SCHEMA}.device (id, pcba_a_sn, created_at)
       VALUES ('00000000-0000-0000-0000-0000000000fe', $1, now())`, [`MAINORPHAN-${runTag}`])
  })

  afterAll(() => {
    if (savedLegacyUrl === undefined) delete process.env.LEGACY_DATABASE_URL
    else process.env.LEGACY_DATABASE_URL = savedLegacyUrl
    if (savedAppEnv === undefined) delete process.env.APP_ENV
    else process.env.APP_ENV = savedAppEnv
    // Never leave a non-zero exit code behind: vitest's own process would
    // inherit it and report a green suite as a failed run.
    process.exitCode = savedExitCode
  })

  it('refuses to run against production, the way migrate_demo.ts does', async () => {
    // The two are a mandatory-ordered pair in one runbook; a refusal on only
    // one half of the pair is no refusal at all.
    process.env.APP_ENV = 'production'
    process.env.LEGACY_DATABASE_URL = legacyUrlForSchema(MAIN_SCHEMA)
    try {
      await expect(runMainFresh()).rejects.toThrow(/refuses to run with APP_ENV=production/)
    } finally {
      process.env.APP_ENV = savedAppEnv
    }
  })

  it('refuses to start without LEGACY_DATABASE_URL', async () => {
    delete process.env.LEGACY_DATABASE_URL
    await expect(runMainFresh()).rejects.toThrow(/LEGACY_DATABASE_URL is required/)
  })

  it('resolves the super_admin actor and migrates end to end', async () => {
    process.env.LEGACY_DATABASE_URL = legacyUrlForSchema(MAIN_SCHEMA)
    await runMainFresh()

    const { rows } = await db.query<{ serial_no: string; hw_rev: string; created_by: string }>(
      `SELECT cu.serial_no, cu.hw_rev, cu.created_by
         FROM component_installation ci JOIN component_unit cu ON cu.id = ci.component_unit_id
        WHERE ci.device_id = $1`, [mainDevice])
    expect(rows).toHaveLength(1)
    expect(rows[0].serial_no).toBe(`MAIN-${runTag}`)
    expect(rows[0].hw_rev).toBe('V9.9')
    // The super_admin main() resolved by role is the same user this file
    // resolved by email.
    expect(rows[0].created_by).toBe(actorId)
    expect(process.exitCode ?? 0).toBe(0)
  })

  it('exits non-zero when a legacy device has no platform counterpart', async () => {
    process.env.LEGACY_DATABASE_URL = legacyUrlForSchema(ORPHAN_SCHEMA)
    await runMainFresh()

    expect(process.exitCode).toBe(1)
    process.exitCode = 0

    const { rows } = await db.query(
      `SELECT 1 FROM device WHERE id = '00000000-0000-0000-0000-0000000000fe'`)
    expect(rows).toHaveLength(0)
  })
})
