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

/** Connection string pointed at `schema` within the same test database. */
function legacyUrlForSchema(schema: string): string {
  const url = new URL(process.env.TEST_DATABASE_URL!)
  url.searchParams.set('options', `-c search_path=${schema}`)
  return url.toString()
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  actorId = (await db.query(
    `SELECT id FROM app_user WHERE email='reetmitra8@gmail.com'`)).rows[0].id

  // A platform device for the migration to hang components off.
  deviceId = (await db.query<{ id: string }>(
    `INSERT INTO device (variant_id, status, created_at, created_by, updated_by)
     VALUES ((SELECT id FROM device_variant WHERE code='pro'), 'in_stock',
             timestamptz '2026-03-14 08:00:00+00', $1, $1) RETURNING id`,
    [actorId])).rows[0].id
  orphanId = '00000000-0000-0000-0000-0000000000ff'

  // Legacy stand-in: only the columns the runner reads.
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  await db.query(`CREATE SCHEMA ${SCHEMA}`)
  await db.query(`
    CREATE TABLE ${SCHEMA}.device (
      id uuid PRIMARY KEY,
      pcba_a_sn text, pcba_a_hw_rev text, pcba_a_bom_rev text, pcba_a_fw_ver text,
      pcba_b_sn text, pcba_b_hw_rev text, pcba_b_bom_rev text, pcba_b_fw_ver text,
      screen_model text, hmi_ver text,
      created_at timestamptz NOT NULL
    )`)
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
  await db.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
  await legacyPool.end(); await platformPool.end()
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
    const rangedDevice = (await db.query<{ id: string }>(
      `INSERT INTO device (variant_id, status, created_at, created_by, updated_by)
       VALUES ((SELECT id FROM device_variant WHERE code='basic'), 'in_stock',
               now(), $1, $1) RETURNING id`, [actorId])).rows[0].id
    const ranged = `EE-${runTag}-0001 to 0015`
    await db.query(
      `INSERT INTO ${SCHEMA}.device (id, pcba_a_sn, created_at) VALUES ($1, $2, now())`,
      [rangedDevice, ranged])

    const result = await migrateComponents(legacyPool, platformPool, actorId)
    const { rows } = await db.query<{ serial_no: string; needs_split: boolean }>(
      `SELECT serial_no, needs_split FROM component_unit WHERE serial_no = $1`, [ranged])
    expect(rows).toHaveLength(1)                 // ONE unit, not fifteen
    expect(rows[0].needs_split).toBe(true)
    expect(result.flaggedSerials.some((f) => f.serialNo === ranged)).toBe(true)
  })
})
