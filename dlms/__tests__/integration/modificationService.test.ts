// __tests__/integration/modificationService.test.ts
//
// Schema assertions for 20260801000000_platform_modifications.sql (spec §6.3):
// the `modification` record, its `modification_type` vocabulary, the deferred
// component_installation.modification_id FK this migration lands, and the
// `repair.parts_replaced` claim a later sign-off precondition reads.
//
// …plus the behaviour of modules/maintenance/services/modificationService.ts,
// in the second half of this file — the sibling of repairService.test.ts.
//
// Talks to the real local Postgres over TEST_DATABASE_URL (the shared platform
// test database __tests__/integration/setup.ts migrates + seeds), in the idiom
// of componentSchema.test.ts: raw SQL, tag rows per run, clean up in afterAll.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import {
  createModification, updateModification, changeModificationStatus, signOffModification,
  getModification, listModifications,
  ModificationNotFoundError, ModificationReferenceNotFoundError, ModificationTerminalError,
  type UpdateModificationInput,
} from '@/modules/maintenance/services/modificationService'
import {
  InvalidModificationTransitionError, ModificationSignOffError,
} from '@/modules/maintenance/domain/modificationStatus'
import { OptimisticLockError } from '@/lib/db/tx'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

let db: Client
let userId: string
let deviceId: string
let typeId: string

// Mirrors the SEEDED operator role (catalog.ts) with maintenance access: can
// create and edit, cannot sign off.
const op = (): Actor => ({
  id: userId, roleKey: 'operator',
  permissions: new Set(['view_records', 'create_records', 'edit_records']),
  moduleAccess: new Set(['maintenance']), active: true,
})
// Adds sign_off_repairs — the permission the modification table's COMMENT names
// as the only route to `closed`, and the same one repairService's sign-off uses.
const signer = (): Actor => ({
  id: userId, roleKey: 'manager',
  permissions: new Set(['view_records', 'create_records', 'edit_records', 'sign_off_repairs']),
  moduleAccess: new Set(['maintenance']), active: true,
})
const viewer = (): Actor => ({
  id: userId, roleKey: 'viewer',
  permissions: new Set(['view_records']), moduleAccess: new Set(['maintenance']), active: true,
})

/** Opens a modification through the SERVICE and records it for cleanup. */
async function openModification(over: Record<string, unknown> = {}) {
  const res = await createModification(op(), {
    deviceId, modificationTypeId: typeId, reason: 'ECO retrofit', ...over,
  })
  createdModificationIds.push(res.modificationId)
  return res
}

async function currentVersion(modificationId: string): Promise<number> {
  return (await db.query<{ version: number }>(
    `SELECT version FROM modification WHERE id=$1`, [modificationId])).rows[0].version
}

/** Walks a modification requested → approved → completed. */
async function driveToCompleted(modificationId: string) {
  await changeModificationStatus(op(), {
    modificationId, toStatus: 'approved', version: await currentVersion(modificationId) })
  await changeModificationStatus(op(), {
    modificationId, toStatus: 'completed', version: await currentVersion(modificationId) })
}

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
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
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
    await db.query(
      `DELETE FROM modification_status_history WHERE modification_id = ANY($1)`,
      [createdModificationIds])
    await db.query(`DELETE FROM modification WHERE id = ANY($1)`, [createdModificationIds])
  }
  if (createdRepairIds.length) {
    await db.query(`DELETE FROM repair WHERE id = ANY($1)`, [createdRepairIds])
  }
  if (createdDeviceIds.length) {
    await db.query(`DELETE FROM device_status_history WHERE device_id = ANY($1)`, [createdDeviceIds])
    await db.query(`DELETE FROM device WHERE id = ANY($1)`, [createdDeviceIds])
  }
  await db.end(); await getPool().end()
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

// PARITY WITH repair_status_history IS THE POINT OF THIS TABLE — do not
// "simplify" either one away. Both records carry only their CURRENT status on the
// row; the audit-grade timeline the detail page renders, and the place a
// cancellation's REASON is recorded (the service requires a note on cancel), is
// this append-only log. `modification` has no free column that could hold that
// reason: `reason` means why the change was wanted and `description` means what
// is being done. Whatever changes about one of these two tables should change
// about the other; the assertions below are deliberately written against both.
describe('modification_status_history (mirrors repair_status_history)', () => {
  it('carries the same column shape as repair_status_history', async () => {
    const shape = async (table: string) => {
      const { rows } = await db.query(
        `SELECT column_name, data_type, is_nullable FROM information_schema.columns
          WHERE table_name = $1`, [table])
      return rows.map((r) => ({
        // the FK column is named for its parent on each side — compare the rest
        column_name: r.column_name.replace(/^(modification|repair)_id$/, 'parent_id'),
        data_type: r.data_type, is_nullable: r.is_nullable,
      })).sort((a, b) => a.column_name.localeCompare(b.column_name))
    }
    expect(await shape('modification_status_history')).toEqual(await shape('repair_status_history'))
  })

  it('requires to_status and changed_by, and allows a null from_status (the opening row)', async () => {
    const mod = await makeModification()
    await expect(db.query(
      `INSERT INTO modification_status_history (modification_id, to_status, changed_by)
       VALUES ($1,'requested',$2)`, [mod.id, userId])).resolves.toBeTruthy()
    await expect(db.query(
      `INSERT INTO modification_status_history (modification_id, changed_by)
       VALUES ($1,$2)`, [mod.id, userId])).rejects.toThrow(/not-null/i)
    await expect(db.query(
      `INSERT INTO modification_status_history (modification_id, to_status)
       VALUES ($1,'approved')`, [mod.id])).rejects.toThrow(/not-null/i)
    const { rows } = await db.query(
      `SELECT from_status, note FROM modification_status_history WHERE modification_id=$1`,
      [mod.id])
    expect(rows[0]).toMatchObject({ from_status: null, note: null })
  })

  it('rejects a row for a nonexistent modification', async () => {
    await expect(db.query(
      `INSERT INTO modification_status_history (modification_id, to_status, changed_by)
       VALUES ('00000000-0000-0000-0000-000000000000','approved',$1)`, [userId]))
      .rejects.toThrow(/foreign key/i)
  })

  it('is indexed for the detail-page timeline query, like rsh_repair', async () => {
    const { rows } = await db.query(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename='modification_status_history' AND indexname='msh_modification'`)
    expect(rows.length).toBe(1)
    expect(rows[0].indexdef).toMatch(/modification_id/)
    expect(rows[0].indexdef).toMatch(/changed_at DESC/)
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
  const NEW_TABLES = ['modification', 'modification_status_history', 'modification_type']

  it('has RLS enabled and NOT forced on every new table', async () => {
    const { rows } = await db.query(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname = ANY($1) AND relkind='r' ORDER BY relname`, [NEW_TABLES])
    expect(rows.map((r) => r.relname)).toEqual(NEW_TABLES)
    expect(rows.every((r) => r.relrowsecurity === true)).toBe(true)
    expect(rows.every((r) => r.relforcerowsecurity === false)).toBe(true)
  })

  it('has NO policy on any of them (deny-via-REST)', async () => {
    const { rows } = await db.query(
      `SELECT count(*)::int AS n FROM pg_policies
        WHERE schemaname='public' AND tablename = ANY($1)`, [NEW_TABLES])
    expect(rows[0].n).toBe(0)
  })

  it('attaches the audit trigger by name on every new table', async () => {
    const { rows } = await db.query(
      `SELECT tgname FROM pg_trigger
        WHERE tgrelid = ANY(ARRAY['modification'::regclass,
                                  'modification_status_history'::regclass,
                                  'modification_type'::regclass])
          AND NOT tgisinternal ORDER BY tgname`)
    expect(rows.map((r) => r.tgname)).toEqual(expect.arrayContaining([
      'trg_audit_modification', 'trg_audit_modification_status_history',
      'trg_audit_modification_type',
    ]))
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

// ═══ Service behaviour (modules/maintenance/services/modificationService.ts) ═══
// Deliberately shaped like repairService.test.ts: same actor factories, same
// optimistic-lock assertions, same fail-closed transition assertions.

describe('createModification', () => {
  it('refuses an actor without create_records', async () => {
    await expect(createModification(viewer(), { deviceId, modificationTypeId: typeId }))
      .rejects.toThrow(PermissionError)
  })

  it('opens at "requested", mints MOD-YYYY-NNNN, stamps the requester and writes the opening history row', async () => {
    const res = await openModification({ description: 'swap amplifier board' })
    expect(res.modificationNo).toMatch(/^MOD-\d{4}-\d{4,}$/)

    const { rows } = await db.query(
      `SELECT status, version, requested_by, created_by, updated_by, reason, description,
              requested_on = current_date AS requested_today
         FROM modification WHERE id=$1`, [res.modificationId])
    expect(rows[0]).toMatchObject({
      status: 'requested', version: 1, requested_by: userId, created_by: userId,
      updated_by: userId, reason: 'ECO retrofit', description: 'swap amplifier board',
      requested_today: true,
    })

    const hist = await db.query(
      `SELECT from_status, to_status, note FROM modification_status_history
        WHERE modification_id=$1`, [res.modificationId])
    expect(hist.rows).toEqual([{ from_status: null, to_status: 'requested', note: null }])
  })

  it('honours an explicit requested_on rather than overwriting it with today', async () => {
    const res = await openModification({ requestedOn: '2026-01-15' })
    const { rows } = await db.query(
      `SELECT to_char(requested_on,'YYYY-MM-DD') AS d FROM modification WHERE id=$1`,
      [res.modificationId])
    expect(rows[0].d).toBe('2026-01-15')
  })

  it('validates every referenced row rather than trusting the id', async () => {
    const nil = '00000000-0000-0000-0000-000000000000'
    await expect(createModification(op(), { deviceId: nil, modificationTypeId: typeId }))
      .rejects.toMatchObject({ name: 'ModificationReferenceNotFoundError', reference: 'device' })
    await expect(createModification(op(), { deviceId, modificationTypeId: nil }))
      .rejects.toMatchObject({ reference: 'modification_type' })
    await expect(createModification(op(), { deviceId, modificationTypeId: typeId, ecoId: nil }))
      .rejects.toMatchObject({ reference: 'eco' })
    await expect(createModification(op(), { deviceId, modificationTypeId: typeId, repairId: nil }))
      .rejects.toMatchObject({ reference: 'repair' })
    await expect(createModification(op(), { deviceId, modificationTypeId: typeId, ecoId: nil }))
      .rejects.toThrow(ModificationReferenceNotFoundError)
  })

  it('records a real eco and repair (the retrofit linkage)', async () => {
    const repairId = (await db.query(
      `INSERT INTO repair (device_id, created_by) VALUES ($1,$2) RETURNING id`,
      [deviceId, userId])).rows[0].id
    createdRepairIds.push(repairId)
    const ecoId = (await db.query(
      `INSERT INTO eco (title, created_by) VALUES ('Service retrofit', $1) RETURNING id`,
      [userId])).rows[0].id

    const res = await openModification({ ecoId, repairId })
    const { rows } = await db.query(
      `SELECT eco_id, repair_id FROM modification WHERE id=$1`, [res.modificationId])
    expect(rows[0]).toMatchObject({ eco_id: ecoId, repair_id: repairId })
  })

  // A modification on device A citing a repair on device B is the same
  // traceability lie a cross-device component attribution would be: both rows
  // are real, so the FK is silent, and only a same-device rule catches it.
  it("refuses a repair belonging to a DIFFERENT device", async () => {
    const otherDeviceId = (await db.query(
      `INSERT INTO device (variant_id, status, created_by, updated_by)
       VALUES ((SELECT id FROM device_variant WHERE code='pro'),'active',$1,$1) RETURNING id`,
      [userId])).rows[0].id
    createdDeviceIds.push(otherDeviceId)
    const elsewhere = (await db.query(
      `INSERT INTO repair (device_id, created_by) VALUES ($1,$2) RETURNING id`,
      [otherDeviceId, userId])).rows[0].id
    createdRepairIds.push(elsewhere)

    await expect(createModification(op(), {
      deviceId, modificationTypeId: typeId, repairId: elsewhere,
    })).rejects.toMatchObject({
      name: 'InvalidAttributionError', kind: 'repair', code: 'device_mismatch',
    })

    // …and the same rule on update, which Task 2 validated for existence only.
    const { modificationId } = await openModification()
    await expect(updateModification(op(), {
      modificationId, version: 1, repairId: elsewhere,
    })).rejects.toMatchObject({ name: 'InvalidAttributionError', code: 'device_mismatch' })
    const { rows } = await db.query(
      `SELECT repair_id, version FROM modification WHERE id=$1`, [modificationId])
    expect(rows[0]).toMatchObject({ repair_id: null, version: 1 })   // rolled back whole
  })

  it('refuses a soft-deleted device (existence means LIVE, as everywhere else)', async () => {
    const dead = (await db.query(
      `INSERT INTO device (variant_id, status, created_by, updated_by, deleted_at)
       VALUES ((SELECT id FROM device_variant WHERE code='pro'),'active',$1,$1,now())
       RETURNING id`, [userId])).rows[0].id
    createdDeviceIds.push(dead)
    await expect(createModification(op(), { deviceId: dead, modificationTypeId: typeId }))
      .rejects.toMatchObject({ reference: 'device' })
  })
})

describe('changeModificationStatus', () => {
  it('performs an allowed move, stamps the approver, and writes history', async () => {
    const { modificationId } = await openModification()
    const res = await changeModificationStatus(op(), {
      modificationId, toStatus: 'approved', version: 1 })
    expect(res).toEqual({ status: 'approved', version: 2 })

    const { rows } = await db.query(
      `SELECT status, approved_by FROM modification WHERE id=$1`, [modificationId])
    expect(rows[0]).toMatchObject({ status: 'approved', approved_by: userId })

    const hist = await db.query(
      `SELECT from_status, to_status FROM modification_status_history
        WHERE modification_id=$1 ORDER BY changed_at DESC LIMIT 1`, [modificationId])
    expect(hist.rows[0]).toMatchObject({ from_status: 'requested', to_status: 'approved' })
  })

  it('stamps the completer and defaults completed_on to today, preserving an explicit date', async () => {
    const a = await openModification()
    await driveToCompleted(a.modificationId)
    const { rows } = await db.query(
      `SELECT completed_by, completed_on = current_date AS today
         FROM modification WHERE id=$1`, [a.modificationId])
    expect(rows[0]).toMatchObject({ completed_by: userId, today: true })

    const b = await openModification()
    await updateModification(op(), {
      modificationId: b.modificationId, version: 1, completedOn: '2026-02-03' })
    await driveToCompleted(b.modificationId)
    const { rows: kept } = await db.query(
      `SELECT to_char(completed_on,'YYYY-MM-DD') AS d FROM modification WHERE id=$1`,
      [b.modificationId])
    expect(kept[0].d).toBe('2026-02-03')
  })

  it('rejects a forbidden move (fail-closed) and writes nothing', async () => {
    const { modificationId } = await openModification()
    await expect(changeModificationStatus(op(), {
      modificationId, toStatus: 'completed', version: 1 }))
      .rejects.toThrow(InvalidModificationTransitionError)
    const { rows } = await db.query(
      `SELECT status, version FROM modification WHERE id=$1`, [modificationId])
    expect(rows[0]).toMatchObject({ status: 'requested', version: 1 })
    const hist = await db.query(
      `SELECT count(*)::int AS n FROM modification_status_history WHERE modification_id=$1`,
      [modificationId])
    expect(hist.rows[0].n).toBe(1)   // only the opening row
  })

  it('requires a note to cancel; succeeds with one, stamps closed_at and logs the reason', async () => {
    const { modificationId } = await openModification()
    await expect(changeModificationStatus(op(), {
      modificationId, toStatus: 'cancelled', version: 1 }))
      .rejects.toThrow(InvalidModificationTransitionError)

    const ok = await changeModificationStatus(op(), {
      modificationId, toStatus: 'cancelled', version: 1, note: '  superseded by ECO-2026-0012  ' })
    expect(ok.status).toBe('cancelled')

    const { rows } = await db.query(
      `SELECT status, closed_at FROM modification WHERE id=$1`, [modificationId])
    expect(rows[0].status).toBe('cancelled')
    expect(rows[0].closed_at).not.toBeNull()

    // The note is the ONLY place "why it stopped" is recorded — trimmed, not raw.
    const hist = await db.query(
      `SELECT to_status, note FROM modification_status_history
        WHERE modification_id=$1 ORDER BY changed_at DESC LIMIT 1`, [modificationId])
    expect(hist.rows[0]).toMatchObject({
      to_status: 'cancelled', note: 'superseded by ECO-2026-0012' })
  })

  it('does NOT allow closing from completed through the ordinary path', async () => {
    const { modificationId } = await openModification()
    await driveToCompleted(modificationId)
    await expect(changeModificationStatus(op(), {
      modificationId, toStatus: 'closed', version: await currentVersion(modificationId) }))
      .rejects.toThrow(InvalidModificationTransitionError)
  })

  it('rejects a stale version with OptimisticLockError', async () => {
    const { modificationId } = await openModification()
    await expect(changeModificationStatus(op(), {
      modificationId, toStatus: 'approved', version: 99 })).rejects.toThrow(OptimisticLockError)
  })

  it('refuses an actor without edit_records, and throws ModificationNotFoundError for an unknown id', async () => {
    const { modificationId } = await openModification()
    await expect(changeModificationStatus(viewer(), {
      modificationId, toStatus: 'approved', version: 1 })).rejects.toThrow(PermissionError)
    await expect(changeModificationStatus(op(), {
      modificationId: '00000000-0000-0000-0000-000000000000', toStatus: 'approved', version: 1 }))
      .rejects.toThrow(ModificationNotFoundError)
  })
})

describe('updateModification — the terminal-state freeze', () => {
  // The sign-off dialog promises a closed modification "cannot be reopened or
  // edited afterwards". Without this check that promise was false: cost could be
  // rewritten 500 → 5000 with NO modification_status_history row, because that
  // log records status changes only. Which makes sign-off decorative.
  it('refuses an edit to a SIGNED-OFF modification', async () => {
    const { modificationId } = await openModification()
    await driveToCompleted(modificationId)
    await signOffModification(signer(), {
      modificationId, version: await currentVersion(modificationId) })

    await expect(updateModification(op(), {
      modificationId, version: await currentVersion(modificationId), costSgd: 5000 }))
      .rejects.toThrow(ModificationTerminalError)

    const { rows } = await db.query<{ cost_sgd: string | null; status: string }>(
      `SELECT cost_sgd, status FROM modification WHERE id = $1`, [modificationId])
    expect(rows[0].status).toBe('closed')
    expect(rows[0].cost_sgd).toBeNull() // nothing was written
  })

  it('refuses an edit to a CANCELLED modification', async () => {
    const { modificationId } = await openModification()
    await changeModificationStatus(op(), {
      modificationId, toStatus: 'cancelled', version: 1, note: 'Not proceeding' })

    await expect(updateModification(op(), {
      modificationId, version: await currentVersion(modificationId), description: 'sneaky' }))
      .rejects.toThrow(ModificationTerminalError)
  })

  // `completed` has no ordinary outgoing edges either, but it is NOT terminal —
  // it is the state a signer reads and corrects before accepting. Freezing it
  // would break editing at the moment it matters most.
  it('ALLOWS an edit to a completed modification awaiting sign-off', async () => {
    const { modificationId } = await openModification()
    await driveToCompleted(modificationId)

    const res = await updateModification(op(), {
      modificationId, version: await currentVersion(modificationId),
      description: 'corrected before sign-off' })
    expect(res.version).toBeGreaterThan(0)

    const { rows } = await db.query<{ description: string }>(
      `SELECT description FROM modification WHERE id = $1`, [modificationId])
    expect(rows[0].description).toBe('corrected before sign-off')
  })
})

describe('updateModification', () => {
  it('writes only the keys supplied, clears on explicit null, and bumps version', async () => {
    const { modificationId } = await openModification({ description: 'original' })
    const res = await updateModification(op(), {
      modificationId, version: 1,
      previousConfiguration: 'PCBA-A Rev B', newConfiguration: 'PCBA-A Rev C', costSgd: 250.5,
    })
    expect(res.version).toBe(2)
    const { rows } = await db.query(
      `SELECT description, previous_configuration, new_configuration, cost_sgd
         FROM modification WHERE id=$1`, [modificationId])
    expect(rows[0]).toMatchObject({
      description: 'original', previous_configuration: 'PCBA-A Rev B',
      new_configuration: 'PCBA-A Rev C', cost_sgd: '250.50',
    })

    await updateModification(op(), { modificationId, version: 2, description: null })
    const { rows: cleared } = await db.query(
      `SELECT description, previous_configuration FROM modification WHERE id=$1`, [modificationId])
    expect(cleared[0]).toMatchObject({ description: null, previous_configuration: 'PCBA-A Rev B' })
  })

  it('cannot change status — that is changeModificationStatus / signOffModification only', async () => {
    const { modificationId } = await openModification()
    // A caller that smuggles `status` past the type system gets it dropped, not
    // applied: it is absent from both the Zod schema and UPDATE_COLUMNS.
    await updateModification(op(), {
      modificationId, version: 1, reason: 'still requested', status: 'closed',
    } as unknown as UpdateModificationInput)
    const { rows } = await db.query(
      `SELECT status, reason FROM modification WHERE id=$1`, [modificationId])
    expect(rows[0]).toMatchObject({ status: 'requested', reason: 'still requested' })
  })

  it('validates a referenced eco/repair/type on update too, and lets null clear the link', async () => {
    const nil = '00000000-0000-0000-0000-000000000000'
    const ecoId = (await db.query(
      `INSERT INTO eco (title, created_by) VALUES ('Update-path retrofit', $1) RETURNING id`,
      [userId])).rows[0].id
    const { modificationId } = await openModification({ ecoId })

    await expect(updateModification(op(), { modificationId, version: 1, ecoId: nil }))
      .rejects.toMatchObject({ reference: 'eco' })
    await expect(updateModification(op(), { modificationId, version: 1, repairId: nil }))
      .rejects.toMatchObject({ reference: 'repair' })
    await expect(updateModification(op(), { modificationId, version: 1, modificationTypeId: nil }))
      .rejects.toMatchObject({ reference: 'modification_type' })

    await updateModification(op(), { modificationId, version: 1, ecoId: null })
    const { rows } = await db.query(`SELECT eco_id FROM modification WHERE id=$1`, [modificationId])
    expect(rows[0].eco_id).toBeNull()
  })

  it('refuses a viewer, a stale version, and an unknown id', async () => {
    const { modificationId } = await openModification()
    await expect(updateModification(viewer(), { modificationId, version: 1, reason: 'x' }))
      .rejects.toThrow(PermissionError)
    await expect(updateModification(op(), { modificationId, version: 99, reason: 'x' }))
      .rejects.toThrow(OptimisticLockError)
    await expect(updateModification(op(), {
      modificationId: '00000000-0000-0000-0000-000000000000', version: 1, reason: 'x' }))
      .rejects.toThrow(ModificationNotFoundError)
  })
})

describe('signOffModification', () => {
  it('refuses an actor without sign_off_repairs', async () => {
    const { modificationId } = await openModification()
    await driveToCompleted(modificationId)
    await expect(signOffModification(op(), {
      modificationId, version: await currentVersion(modificationId) }))
      .rejects.toThrow(PermissionError)
  })

  it('refuses sign-off unless the modification is completed', async () => {
    const { modificationId } = await openModification()
    await expect(signOffModification(signer(), { modificationId, version: 1 }))
      .rejects.toThrow(ModificationSignOffError)
    await changeModificationStatus(op(), { modificationId, toStatus: 'approved', version: 1 })
    await expect(signOffModification(signer(), {
      modificationId, version: await currentVersion(modificationId) }))
      .rejects.toThrow(ModificationSignOffError)
  })

  it('closes the modification, stamps signed_off_by/at and closed_at, and logs the transition', async () => {
    const { modificationId } = await openModification()
    await driveToCompleted(modificationId)
    const before = await currentVersion(modificationId)
    const res = await signOffModification(signer(), { modificationId, version: before })
    expect(res).toEqual({ status: 'closed', version: before + 1 })

    const { rows } = await db.query(
      `SELECT status, signed_off_by, signed_off_at, closed_at FROM modification WHERE id=$1`,
      [modificationId])
    expect(rows[0].status).toBe('closed')
    expect(rows[0].signed_off_by).toBe(userId)
    expect(rows[0].signed_off_at).not.toBeNull()
    expect(rows[0].closed_at).not.toBeNull()

    const hist = await db.query(
      `SELECT from_status, to_status, note FROM modification_status_history
        WHERE modification_id=$1 ORDER BY changed_at DESC LIMIT 1`, [modificationId])
    expect(hist.rows[0]).toMatchObject({
      from_status: 'completed', to_status: 'closed', note: 'Signed off' })
  })

  it('rejects a stale version and an unknown id', async () => {
    const { modificationId } = await openModification()
    await driveToCompleted(modificationId)
    await expect(signOffModification(signer(), { modificationId, version: 99 }))
      .rejects.toThrow(OptimisticLockError)
    await expect(signOffModification(signer(), {
      modificationId: '00000000-0000-0000-0000-000000000000', version: 1 }))
      .rejects.toThrow(ModificationNotFoundError)
  })
})

describe('modification reads', () => {
  it('getModification returns null for an unknown id (404-not-403) and a full detail otherwise', async () => {
    expect(await getModification(op(), '00000000-0000-0000-0000-000000000000')).toBeNull()

    const ecoId = (await db.query(
      `INSERT INTO eco (title, created_by) VALUES ('Detail retrofit', $1) RETURNING id, eco_no`,
      [userId])).rows[0].id
    const { modificationId } = await openModification({ ecoId })
    await changeModificationStatus(op(), { modificationId, toStatus: 'approved', version: 1 })

    const detail = await getModification(op(), modificationId)
    expect(detail).toMatchObject({
      id: modificationId, status: 'approved', statusLabel: 'Approved',
      deviceId, typeCode: expect.any(String), typeName: expect.any(String),
      ecoId, requestedByName: expect.any(String), approvedByName: expect.any(String),
      version: 2,
    })
    expect(detail!.ecoNo).toMatch(/^ECO-\d{4}-\d{4,}$/)
    // newest-first, like the repair timeline
    expect(detail!.statusHistory.map((h) => h.toStatus)).toEqual(['approved', 'requested'])
    expect(detail!.statusHistory[0].changedByName).toBeTruthy()
  })

  it('getModification hides a soft-deleted record behind the same null', async () => {
    const { modificationId } = await openModification()
    await db.query(`UPDATE modification SET deleted_at=now() WHERE id=$1`, [modificationId])
    expect(await getModification(op(), modificationId)).toBeNull()
  })

  it('refuses a reader without maintenance access', async () => {
    const noMaint: Actor = {
      id: userId, roleKey: 'viewer',
      permissions: new Set(['view_records']), moduleAccess: new Set(['manufacturing']), active: true,
    }
    await expect(listModifications(noMaint)).rejects.toThrow(PermissionError)
    await expect(getModification(noMaint, '00000000-0000-0000-0000-000000000000'))
      .rejects.toThrow(PermissionError)
  })

  it('listModifications filters by status and device and resolves the type label', async () => {
    const { modificationId } = await openModification()
    const byDevice = await listModifications(op(), { deviceId })
    const mine = byDevice.items.find((m) => m.id === modificationId)
    expect(mine).toMatchObject({ status: 'requested', statusLabel: 'Requested', deviceId })
    expect(mine!.typeName).toBeTruthy()

    const requested = await listModifications(op(), { status: ['requested'] })
    expect(requested.items.every((m) => m.status === 'requested')).toBe(true)
    expect(requested.items.some((m) => m.id === modificationId)).toBe(true)
  })

  it('listModifications paginates by keyset without repeating a row', async () => {
    await openModification(); await openModification(); await openModification()
    const first = await listModifications(op(), { limit: 2 })
    expect(first.items).toHaveLength(2)
    expect(first.nextCursor).toBeTruthy()
    const second = await listModifications(op(), { limit: 2, cursor: first.nextCursor! })
    const ids = new Set(first.items.map((m) => m.id))
    expect(second.items.every((m) => !ids.has(m.id))).toBe(true)
  })

  it('listModifications excludes soft-deleted rows', async () => {
    const { modificationId } = await openModification()
    await db.query(`UPDATE modification SET deleted_at=now() WHERE id=$1`, [modificationId])
    const all = await listModifications(op(), { deviceId, limit: 100 })
    expect(all.items.some((m) => m.id === modificationId)).toBe(false)
  })
})
