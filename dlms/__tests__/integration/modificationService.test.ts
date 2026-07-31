// __tests__/integration/modificationService.test.ts
//
// Schema assertions for 20260801000000_platform_modifications.sql (spec §6.3):
// the `modification` record, its `modification_type` vocabulary, the deferred
// component_installation.modification_id FK this migration lands, and the
// `repair.parts_replaced` claim a later sign-off precondition reads.
//
// Talks to the real local Postgres over TEST_DATABASE_URL (the shared platform
// test database __tests__/integration/setup.ts migrates + seeds), in the idiom
// of componentSchema.test.ts: raw SQL, tag rows per run, clean up in afterAll.
// Service-layer behaviour arrives with the modification service; this file is
// deliberately schema-only for now.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'

let db: Client
let userId: string
let deviceId: string
let typeId: string

const createdModificationIds: string[] = []
const createdInstallationIds: string[] = []
const createdRepairIds: string[] = []
const createdDeviceIds: string[] = []

/** Inserts a modification with the minimum NOT NULL set, and records it for cleanup. */
async function makeModification(over: Record<string, unknown> = {}) {
  const cols: Record<string, unknown> = {
    device_id: deviceId,
    modification_type_id: typeId,
    created_by: userId,
    ...over,
  }
  const keys = Object.keys(cols)
  const { rows } = await db.query(
    `INSERT INTO modification (${keys.join(',')})
     VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})
     RETURNING id, modification_no, status, version`,
    Object.values(cols),
  )
  createdModificationIds.push(rows[0].id)
  return rows[0] as { id: string; modification_no: string; status: string; version: number }
}

beforeAll(async () => {
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  userId = (await db.query(`SELECT id FROM app_user WHERE email = 'reetmitra8@gmail.com'`)).rows[0].id
  deviceId = (await db.query(
    `INSERT INTO device (variant_id, status, created_by, updated_by)
     VALUES ((SELECT id FROM device_variant WHERE code='pro'), 'active', $1, $1) RETURNING id`,
    [userId])).rows[0].id
  createdDeviceIds.push(deviceId)
  typeId = (await db.query(`SELECT id FROM modification_type ORDER BY sort LIMIT 1`)).rows[0].id
})

afterAll(async () => {
  if (createdInstallationIds.length) {
    // component_installation is append-only (fn_component_installation_guard rejects
    // DELETE), so disable the guard for the teardown rather than leaving rows behind
    // in the database every other integration file shares.
    await db.query(`ALTER TABLE component_installation DISABLE TRIGGER trg_component_installation_guard`)
    await db.query(`DELETE FROM component_installation WHERE id = ANY($1)`, [createdInstallationIds])
    await db.query(`ALTER TABLE component_installation ENABLE TRIGGER trg_component_installation_guard`)
  }
  if (createdModificationIds.length) {
    await db.query(`DELETE FROM modification WHERE id = ANY($1)`, [createdModificationIds])
  }
  if (createdRepairIds.length) {
    await db.query(`DELETE FROM repair WHERE id = ANY($1)`, [createdRepairIds])
  }
  if (createdDeviceIds.length) {
    await db.query(`DELETE FROM device_status_history WHERE device_id = ANY($1)`, [createdDeviceIds])
    await db.query(`DELETE FROM device WHERE id = ANY($1)`, [createdDeviceIds])
  }
  await db.end()
})

describe('modification_type vocabulary', () => {
  it('exists and is seeded with an extensible starter set', async () => {
    const { rows } = await db.query(
      `SELECT code, name, active FROM modification_type WHERE deleted_at IS NULL ORDER BY sort`)
    expect(rows.length).toBeGreaterThanOrEqual(4)
    expect(rows.map((r) => r.code)).toEqual(
      ['hardware_upgrade', 'firmware_update', 'eco_retrofit', 'field_fix', 'cosmetic'])
    expect(rows.every((r) => r.active === true)).toBe(true)
    expect(rows.every((r) => typeof r.name === 'string' && r.name.length > 0)).toBe(true)
  })

  it('is a table, not an enum — an admin can add a row without a migration', async () => {
    await db.query(
      `INSERT INTO modification_type (code, name, sort) VALUES ('admin_added','Admin Added',99)`)
    const { rows } = await db.query(`SELECT active FROM modification_type WHERE code='admin_added'`)
    expect(rows[0].active).toBe(true)
    await db.query(`DELETE FROM modification_type WHERE code='admin_added'`)
  })

  it('rejects a duplicate code', async () => {
    await expect(db.query(
      `INSERT INTO modification_type (code, name) VALUES ('field_fix','Duplicate')`))
      .rejects.toThrow()
  })
})

describe('modification table', () => {
  it('carries the spec §6.3 column set', async () => {
    const { rows } = await db.query(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_name = 'modification'`)
    const byName = Object.fromEntries(rows.map((r) => [r.column_name, r]))
    for (const c of [
      'id', 'modification_no', 'device_id', 'modification_type_id', 'status',
      'requested_on', 'completed_on', 'requested_by', 'approved_by', 'completed_by',
      'reason', 'description', 'previous_configuration', 'new_configuration',
      'eco_id', 'repair_id', 'cost_sgd',
      'signed_off_by', 'signed_off_at', 'closed_at',
      'created_at', 'created_by', 'updated_at', 'updated_by', 'deleted_at', 'version',
    ]) {
      expect(byName[c], `modification.${c} is missing`).toBeTruthy()
    }
    expect(byName.requested_on.data_type).toBe('date')
    expect(byName.completed_on.data_type).toBe('date')
    expect(byName.cost_sgd.data_type).toBe('numeric')
    expect(byName.signed_off_at.data_type).toBe('timestamp with time zone')
    expect(byName.device_id.is_nullable).toBe('NO')
    expect(byName.modification_type_id.is_nullable).toBe('NO')
    expect(byName.cost_sgd.is_nullable).toBe('YES')   // unknown / not costed
  })

  it('opens at "requested" with version 1', async () => {
    const row = await makeModification({ reason: 'ECO-2026-0007 retrofit' })
    expect(row.status).toBe('requested')
    expect(row.version).toBe(1)
  })

  it('fences status to the chosen vocabulary and admits every state in it', async () => {
    for (const s of ['requested', 'approved', 'completed', 'closed', 'cancelled']) {
      await expect(makeModification({ status: s })).resolves.toMatchObject({ status: s })
    }
    await expect(makeModification({ status: 'in_progress' })).rejects.toThrow()
    await expect(makeModification({ status: 'rejected' })).rejects.toThrow()
  })

  it('keeps sign-off atomic: both the actor and the timestamp, or neither', async () => {
    const row = await makeModification()
    await expect(db.query(
      `UPDATE modification SET signed_off_by=$1 WHERE id=$2`, [userId, row.id]))
      .rejects.toThrow(/modification_signoff_complete/)
    await expect(db.query(
      `UPDATE modification SET signed_off_by=$1, signed_off_at=now() WHERE id=$2`,
      [userId, row.id])).resolves.toBeTruthy()
  })

  it('preserves bilingual free text verbatim', async () => {
    const row = await makeModification({
      description: '升级放大板至 Rev C — upgrade amplifier board to Rev C',
      previous_configuration: 'PCBA-A Rev B',
      new_configuration: 'PCBA-A Rev C',
    })
    const { rows } = await db.query(
      `SELECT description, previous_configuration, new_configuration FROM modification WHERE id=$1`,
      [row.id])
    expect(rows[0].description).toBe('升级放大板至 Rev C — upgrade amplifier board to Rev C')
    expect(rows[0].previous_configuration).toBe('PCBA-A Rev B')
    expect(rows[0].new_configuration).toBe('PCBA-A Rev C')
  })
})

describe('modification_no sequence', () => {
  it('mints MOD-YYYY-NNNN and increments', async () => {
    const first = await makeModification()
    const second = await makeModification()
    const shape = /^MOD-(\d{4})-(\d{4,})$/
    expect(first.modification_no).toMatch(shape)
    expect(second.modification_no).toMatch(shape)

    const [, year] = shape.exec(first.modification_no)!
    expect(year).toBe(String(new Date().getUTCFullYear()))

    const n = (ref: string) => Number(shape.exec(ref)![2])
    expect(n(second.modification_no)).toBe(n(first.modification_no) + 1)
  })

  it('is UNIQUE — a hand-supplied duplicate is refused', async () => {
    const row = await makeModification()
    await expect(makeModification({ modification_no: row.modification_no })).rejects.toThrow()
  })
})

describe('foreign keys', () => {
  it('rejects an unknown device, type, repair, eco and app_user', async () => {
    const nil = '00000000-0000-0000-0000-000000000000'
    await expect(makeModification({ device_id: nil })).rejects.toThrow(/foreign key/i)
    await expect(makeModification({ modification_type_id: nil })).rejects.toThrow(/foreign key/i)
    await expect(makeModification({ repair_id: nil })).rejects.toThrow(/foreign key/i)
    await expect(makeModification({ eco_id: nil })).rejects.toThrow(/foreign key/i)
    await expect(makeModification({ requested_by: nil })).rejects.toThrow(/foreign key/i)
    await expect(makeModification({ approved_by: nil })).rejects.toThrow(/foreign key/i)
    await expect(makeModification({ completed_by: nil })).rejects.toThrow(/foreign key/i)
  })

  it('accepts a real repair and a real eco (the retrofit linkage)', async () => {
    const repairId = (await db.query(
      `INSERT INTO repair (device_id, created_by) VALUES ($1,$2) RETURNING id`,
      [deviceId, userId])).rows[0].id
    createdRepairIds.push(repairId)
    const ecoId = (await db.query(
      `INSERT INTO eco (title, created_by) VALUES ('Retrofit Rev C', $1) RETURNING id`,
      [userId])).rows[0].id

    const row = await makeModification({ repair_id: repairId, eco_id: ecoId })
    const { rows } = await db.query(
      `SELECT repair_id, eco_id FROM modification WHERE id=$1`, [row.id])
    expect(rows[0]).toMatchObject({ repair_id: repairId, eco_id: ecoId })
  })
})

describe('component_installation.modification_id', () => {
  it('now carries a real FK constraint to modification(id)', async () => {
    const { rows } = await db.query(
      `SELECT conname FROM pg_constraint
        WHERE conrelid = 'component_installation'::regclass AND contype = 'f'
          AND confrelid = 'modification'::regclass`)
    expect(rows.length).toBe(1)
  })

  it('rejects an installation attributed to a nonexistent modification', async () => {
    const typeRow = (await db.query(`SELECT id FROM component_type WHERE code='pcba_a'`)).rows[0]
    await expect(db.query(
      `INSERT INTO component_installation
         (device_id, component_type_id, batch_no, slot_no, installed_by, created_by, modification_id)
       VALUES ($1,$2,'BATCH-MOD-FK',41,$3,$3,'00000000-0000-0000-0000-000000000000')`,
      [deviceId, typeRow.id, userId])).rejects.toThrow(/foreign key/i)
  })

  it('accepts an installation attributed to a real modification', async () => {
    const typeRow = (await db.query(`SELECT id FROM component_type WHERE code='pcba_a'`)).rows[0]
    const mod = await makeModification()
    const { rows } = await db.query(
      `INSERT INTO component_installation
         (device_id, component_type_id, batch_no, slot_no, installed_by, created_by, modification_id)
       VALUES ($1,$2,'BATCH-MOD-OK',42,$3,$3,$4) RETURNING id`,
      [deviceId, typeRow.id, userId, mod.id])
    createdInstallationIds.push(rows[0].id)
    expect(rows[0].id).toBeTruthy()
  })
})

describe('repair.parts_replaced', () => {
  it('exists, is NOT NULL, and defaults to false', async () => {
    const { rows } = await db.query(
      `SELECT data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_name='repair' AND column_name='parts_replaced'`)
    expect(rows[0]).toMatchObject({ data_type: 'boolean', is_nullable: 'NO' })
    expect(rows[0].column_default).toMatch(/false/)

    const repairId = (await db.query(
      `INSERT INTO repair (device_id, created_by) VALUES ($1,$2) RETURNING id`,
      [deviceId, userId])).rows[0].id
    createdRepairIds.push(repairId)
    const { rows: r } = await db.query(`SELECT parts_replaced FROM repair WHERE id=$1`, [repairId])
    expect(r[0].parts_replaced).toBe(false)
  })

  it('is settable to true — the technician\'s claim', async () => {
    const repairId = (await db.query(
      `INSERT INTO repair (device_id, created_by, parts_replaced) VALUES ($1,$2,true) RETURNING id`,
      [deviceId, userId])).rows[0].id
    createdRepairIds.push(repairId)
    const { rows } = await db.query(`SELECT parts_replaced FROM repair WHERE id=$1`, [repairId])
    expect(rows[0].parts_replaced).toBe(true)
  })
})

describe('platform table conventions', () => {
  it('has RLS enabled and NOT forced on both new tables', async () => {
    const { rows } = await db.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname = ANY($1) AND relkind='r' ORDER BY relname`,
      [['modification', 'modification_type']])
    expect(rows.map((r) => r.relname)).toEqual(['modification', 'modification_type'])
    expect(rows.every((r) => r.relrowsecurity === true)).toBe(true)
    expect(rows.every((r) => r.relforcerowsecurity === false)).toBe(true)
  })

  it('has NO policy on either table (deny-via-REST)', async () => {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM pg_policies
        WHERE schemaname='public' AND tablename = ANY($1)`,
      [['modification', 'modification_type']])
    expect(rows[0].n).toBe(0)
  })

  it('attaches the audit trigger by name on both tables', async () => {
    const { rows } = await db.query(
      `SELECT tgname FROM pg_trigger
        WHERE tgrelid = ANY(ARRAY['modification'::regclass, 'modification_type'::regclass])
          AND NOT tgisinternal ORDER BY tgname`)
    expect(rows.map((r) => r.tgname)).toEqual(
      expect.arrayContaining(['trg_audit_modification', 'trg_audit_modification_type']))
  })

  it('actually writes an audit_log row on insert and update', async () => {
    const row = await makeModification({ reason: 'audit probe' })
    const inserted = await db.query(
      `SELECT action, actor_id FROM audit_log WHERE table_name='modification' AND row_id=$1`,
      [row.id])
    expect(inserted.rows.map((r) => r.action)).toEqual(['insert'])
    expect(inserted.rows[0].actor_id).toBe(userId)

    await db.query(`UPDATE modification SET reason='audit probe 2', version=version+1 WHERE id=$1`,
      [row.id])
    const after = await db.query(
      `SELECT action, changed_columns FROM audit_log
        WHERE table_name='modification' AND row_id=$1 ORDER BY occurred_at`, [row.id])
    expect(after.rows.map((r) => r.action)).toEqual(['insert', 'update'])
    expect(after.rows[1].changed_columns).toEqual(expect.arrayContaining(['reason', 'version']))
  })
})
