import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { mapStatus, mapDeviceRow, DEVICE_AUDIT_TRIGGER } from '@/scripts/migrate_demo'
import { listDevices } from '@/modules/manufacturing/services/deviceReadService'
import { getPool } from '@/lib/db/pool'
import type { Actor } from '@/modules/shared/authz/catalog'

const VARIANTS = { basic: 'variant-basic-uuid', pro: 'variant-pro-uuid' }
const ACTOR = 'actor-uuid'

const legacy = (over = {}) => ({
  id: 'device-uuid-1',
  device_sn: 'QTX-P-00412',
  pcba_a_sn: 'EE-02A-2603-0042',
  product_name: 'AH Pro',
  model_no: 'AH-2',
  status: 'In Stock',
  phase: 'Production',
  customer: '客户 A',
  destination: 'Singapore',
  remarks: '电源板已更换\nSecond line preserved',
  build_date: new Date('2026-03-01'),
  ship_date: null,
  created_at: new Date('2026-03-02'),
  deleted_at: null,
  ...over,
})

describe('mapStatus — the three production codes map 1:1 (spec §15)', () => {
  it('maps the live codes', () => {
    expect(mapStatus('In Stock')).toBe('in_stock')
    expect(mapStatus('Under Repair')).toBe('under_repair')
    expect(mapStatus('Shipped')).toBe('shipped')
  })

  it('maps the seeded codes that drifted out of use', () => {
    expect(mapStatus('Stock')).toBe('in_stock')
    expect(mapStatus('Repair')).toBe('under_repair')
  })

  it('maps the remaining terminal/delivered codes', () => {
    expect(mapStatus('Delivered')).toBe('delivered')
    expect(mapStatus('Retired')).toBe('retired')
    // Lost -> scrapped is the non-obvious one: legacy has no direct "lost"
    // status on the platform, and scrapped is the closest terminal fit.
    expect(mapStatus('Lost')).toBe('scrapped')
  })

  it('throws on an unknown status rather than guessing', () => {
    expect(() => mapStatus('Teleported')).toThrow(/unknown legacy status/i)
  })
})

describe('mapDeviceRow', () => {
  it('preserves the device UUID verbatim — audit rows depend on it', () => {
    expect(mapDeviceRow(legacy(), VARIANTS, ACTOR).id).toBe('device-uuid-1')
  })

  it('preserves bilingual free text exactly, including newlines', () => {
    const out = mapDeviceRow(legacy(), VARIANTS, ACTOR)
    expect(out.remarks).toBe('电源板已更换\nSecond line preserved')
    expect(out.customer).toBe('客户 A')
  })

  it('derives the Pro variant from the product name', () => {
    expect(mapDeviceRow(legacy(), VARIANTS, ACTOR).variant_id).toBe('variant-pro-uuid')
  })

  it('defaults to Basic when the product name says nothing', () => {
    expect(mapDeviceRow(legacy({ product_name: 'AH' }), VARIANTS, ACTOR).variant_id)
      .toBe('variant-basic-uuid')
  })

  it('carries a ranged legacy serial verbatim and flags it for review, never splitting it', () => {
    const out = mapDeviceRow(
      legacy({ device_sn: null, pcba_a_sn: 'EE-02A-2603-0001 to 0015' }), VARIANTS, ACTOR)
    expect(out.pcba_a_sn_legacy).toBe('EE-02A-2603-0001 to 0015')
    expect(out.needs_data_review).toBe(true)
    expect(out.device_sn).toBeNull()
  })

  it('flags a device with no serial of any kind', () => {
    const out = mapDeviceRow(legacy({ device_sn: null, pcba_a_sn: '' }), VARIANTS, ACTOR)
    expect(out.needs_data_review).toBe(true)
  })

  it('does NOT flag a clean single-serial row', () => {
    expect(mapDeviceRow(legacy(), VARIANTS, ACTOR).needs_data_review).toBe(false)
  })

  it('normalizes the serial for search without altering the stored value', () => {
    const out = mapDeviceRow(legacy(), VARIANTS, ACTOR)
    expect(out.device_sn).toBe('QTX-P-00412')
    expect(out.device_sn_normalized).toBe('qtxp00412')
  })

  it('maps every legacy phase to its platform code (via mapPhase)', () => {
    const cases: [string, string][] = [
      ['Production', 'production'],
      ['Validation', 'validation'],
      ['Rework', 'rework'],
      ['Pilot', 'pilot'],
      ['EOL', 'end_of_life'],
    ]
    for (const [legacyPhase, platformPhase] of cases) {
      expect(mapDeviceRow(legacy({ phase: legacyPhase }), VARIANTS, ACTOR).phase).toBe(platformPhase)
    }
  })

  it('degrades an unrecognized phase to null rather than passing it through', () => {
    const out = mapDeviceRow(legacy({ phase: 'Teleported' }), VARIANTS, ACTOR)
    expect(out.phase).toBeNull()
  })

  it('carries deleted_at verbatim — a soft-deleted legacy row stays soft-deleted', () => {
    const deletedAt = new Date('2026-05-01T00:00:00Z')
    expect(mapDeviceRow(legacy({ deleted_at: deletedAt }), VARIANTS, ACTOR).deleted_at).toBe(deletedAt)
    expect(mapDeviceRow(legacy(), VARIANTS, ACTOR).deleted_at).toBeNull()
  })
})

// ===========================================================================
// main() end-to-end, against real Postgres (the same Docker container the
// rest of this suite uses). A throwaway schema in the SAME database stands
// in for "the legacy project" — LEGACY_DATABASE_URL is pointed at it via the
// `options=-c search_path=...` connection parameter, so main()'s own
// unqualified `device`/`audit_log`/`app_user` queries resolve there, while
// DATABASE_URL (unchanged) resolves to the already-migrated platform schema
// in `public`. Mirrors the manual local proof in RB-07 but as an assertion,
// not a one-off script.
// ===========================================================================

/**
 * main() through a FRESH module instance, the way migrateComponents.test.ts
 * does it. main() now closes the getPool() singleton on its way out — that is
 * the fix for the ~30s idle-timeout hang after the summary prints, and it makes
 * RB-07 and RB-08 behave the same way when run back to back — but pg rejects a
 * second end() on the same pool, and this file calls main() three times. A fresh
 * module registry gives each invocation its own singleton and leaves the one
 * this file's own top-level getPool() owns untouched.
 */
async function runMainFresh(): Promise<void> {
  vi.resetModules()
  const mod = await import('@/scripts/migrate_demo')
  await mod.main()
}

/** Builds a connection string pointed at `schema` within the same test database. */
function legacyUrlForSchema(schema: string): string {
  const url = new URL(process.env.TEST_DATABASE_URL!)
  url.searchParams.set('options', `-c search_path=${schema}`)
  return url.toString()
}

/** Minimal legacy-shaped device/app_user/audit_log tables, just the columns migrate_demo.ts reads. */
async function createLegacySchema(admin: Client, schema: string): Promise<void> {
  await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`)
  await admin.query(`CREATE SCHEMA ${schema}`)
  await admin.query(`CREATE TABLE ${schema}.app_user (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL)`)
  await admin.query(`CREATE TABLE ${schema}.device (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
    device_sn text, pcba_a_sn text, product_name text, model_no text,
    status text NOT NULL, phase text, customer text, destination text, remarks text,
    build_date date, ship_date date,
    created_at timestamptz NOT NULL DEFAULT now(),
    deleted_at timestamptz)`)
  await admin.query(`CREATE TABLE ${schema}.audit_log (
    id uuid PRIMARY KEY DEFAULT gen_random_uuid(), table_name text NOT NULL, row_id uuid,
    action text NOT NULL, actor_id uuid, old_values jsonb, new_values jsonb,
    changed_columns text[], occurred_at timestamptz NOT NULL DEFAULT now())`)
}

async function triggerState(admin: Client): Promise<string | undefined> {
  const { rows } = await admin.query<{ tgenabled: string }>(
    `SELECT tgenabled FROM pg_trigger WHERE tgname = $1 AND NOT tgisinternal`, [DEVICE_AUDIT_TRIGGER])
  return rows[0]?.tgenabled
}

describe('main() end-to-end — soft-deleted legacy device (Issue 2, Docker Postgres)', () => {
  const SCHEMA = 'legacy_src_softdelete'
  let admin: Client
  let deviceId: string
  let actorId: string

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
    admin = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    await admin.connect()
    await createLegacySchema(admin, SCHEMA)

    // A legacy row already soft-deleted (deleted_at set) before the cutover —
    // its audit trail, if any, would already say "soft_delete" on the legacy
    // side; the platform row must agree, not resurrect it as live.
    const inserted = await admin.query<{ id: string }>(
      `INSERT INTO ${SCHEMA}.device (
         device_sn, pcba_a_sn, product_name, status, phase, created_at, deleted_at
       ) VALUES ($1, $2, $3, $4, $5, now() - interval '2 days', now() - interval '1 day')
       RETURNING id`,
      ['QTX-SOFTDEL-001', 'EE-SOFTDEL-0001', 'AH Basic', 'In Stock', 'Production'])
    deviceId = inserted.rows[0].id

    actorId = (await admin.query(
      `SELECT id FROM app_user WHERE email = 'reetmitra8@gmail.com'`)).rows[0].id

    process.env.LEGACY_DATABASE_URL = legacyUrlForSchema(SCHEMA)
    await runMainFresh()
  })

  afterAll(async () => {
    await admin.query(`DELETE FROM audit_log WHERE row_id = $1`, [deviceId])
    await admin.query(`DELETE FROM device WHERE id = $1`, [deviceId])
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await admin.end()
  })

  it('preserves deleted_at on the platform row rather than reviving it as live', async () => {
    const { rows } = await admin.query<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM device WHERE id = $1`, [deviceId])
    expect(rows).toHaveLength(1)
    expect(rows[0].deleted_at).not.toBeNull()
  })

  it('does not surface the soft-deleted device through listDevices (Task 13 excludes it)', async () => {
    const op: Actor = {
      id: actorId, roleKey: 'operator',
      permissions: new Set(['view_records']), moduleAccess: new Set(['manufacturing']), active: true,
    }
    const { items } = await listDevices(op, { q: 'QTX-SOFTDEL-001' })
    expect(items).toEqual([])
  })
})

describe('trg_audit_device residue (Issue 1, Docker Postgres)', () => {
  const SCHEMA = 'legacy_src_trigger'
  let admin: Client

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
    admin = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    await admin.connect()
  })

  afterAll(async () => {
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await admin.end()
  })

  it('stays enabled after an ordinary successful run', async () => {
    await createLegacySchema(admin, SCHEMA)
    await admin.query(`
      INSERT INTO ${SCHEMA}.device (device_sn, pcba_a_sn, product_name, status, phase)
      VALUES ('QTX-TRIG-CLEAN', 'EE-TRIG-CLEAN', 'AH Basic', 'In Stock', 'Production')`)
    process.env.LEGACY_DATABASE_URL = legacyUrlForSchema(SCHEMA)

    await runMainFresh()

    expect(await triggerState(admin)).toBe('O')
    await admin.query(`DELETE FROM device WHERE device_sn = 'QTX-TRIG-CLEAN'`)
  })

  it('stays enabled even when a batch genuinely fails mid-transaction', async () => {
    await createLegacySchema(admin, SCHEMA)
    // Two live (non-deleted) legacy rows sharing a device_sn: ON CONFLICT (id)
    // DO NOTHING only covers the id primary key, so the platform's
    // device_sn_unique partial index rejects the second INSERT with a real
    // Postgres error — not a JS mapping failure migrateDevices already
    // tolerates. Both rows are well under BATCH_SIZE, so they land in the
    // SAME batch transaction, which rolls back entirely.
    await admin.query(`
      INSERT INTO ${SCHEMA}.device (device_sn, pcba_a_sn, product_name, status, phase, created_at)
      VALUES
        ('QTX-DUP', 'EE-DUP-1', 'AH Basic', 'In Stock', 'Production', now() - interval '2 days'),
        ('QTX-DUP', 'EE-DUP-2', 'AH Basic', 'In Stock', 'Production', now() - interval '1 day')`)
    process.env.LEGACY_DATABASE_URL = legacyUrlForSchema(SCHEMA)

    await expect(runMainFresh()).rejects.toThrow(/duplicate key|unique/i)

    // Rolled back: neither row landed on the platform.
    const { rows } = await admin.query(`SELECT id FROM device WHERE device_sn = 'QTX-DUP'`)
    expect(rows).toHaveLength(0)

    // The whole point of Issue 1's fix: a genuine mid-batch crash cannot
    // leave auditing off, because SET LOCAL never committed anything outside
    // the rolled-back transaction.
    expect(await triggerState(admin)).toBe('O')
  })
})

// ===========================================================================
// migrate_demo.ts WRITES through the getPool() singleton (withTransaction),
// not through the platformPool it builds itself — so main() has to close that
// singleton too, or the process sits idle for idleTimeoutMillis (30s) after
// the summary prints. That reads as a hang, and an operator who Ctrl-Cs it
// gets exit 130 instead of the real code, which a wrapping runbook script
// misreads. RB-07 and RB-08 are a mandatory-ordered pair run back to back and
// scripts/migrate_components.ts already closes it; this is the assertion that
// the sibling now does too.
// ===========================================================================

describe('main() closes the write pool (no 30s idle hang)', () => {
  const SCHEMA = 'legacy_src_poolclose'
  let admin: Client

  beforeAll(async () => {
    process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
    admin = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    await admin.connect()
  })

  afterAll(async () => {
    // In afterAll, not at the end of the test: a failing assertion must not
    // leave the migrated row behind for the NEXT run to trip over
    // device_sn_unique on.
    await admin.query(`DELETE FROM device WHERE device_sn = 'QTX-POOL-CLOSE'`)
    await admin.query(`DROP SCHEMA IF EXISTS ${SCHEMA} CASCADE`)
    await admin.end()
  })

  it('ends the getPool() singleton it wrote through', async () => {
    await createLegacySchema(admin, SCHEMA)
    // Self-healing against a run that died before its afterAll.
    await admin.query(`DELETE FROM device WHERE device_sn = 'QTX-POOL-CLOSE'`)
    await admin.query(`
      INSERT INTO ${SCHEMA}.device (device_sn, pcba_a_sn, product_name, status, phase)
      VALUES ('QTX-POOL-CLOSE', 'EE-POOL-CLOSE', 'AH Basic', 'In Stock', 'Production')`)
    process.env.LEGACY_DATABASE_URL = legacyUrlForSchema(SCHEMA)

    vi.resetModules()
    const migrate = await import('@/scripts/migrate_demo')
    await migrate.main()

    // Imported WITHOUT another resetModules, so this is the very singleton
    // main() just wrote through — not a fresh one that would trivially be open.
    const { getPool: freshGetPool } = await import('@/lib/db/pool')
    expect(freshGetPool().ended).toBe(true)
  })
})

afterAll(async () => {
  await getPool().end()
})
