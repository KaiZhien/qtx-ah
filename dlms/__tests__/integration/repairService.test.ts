// __tests__/integration/repairService.test.ts
//
// Mirrors deviceWriteService.test.ts's harness idiom: mock the supabase server
// module, talk to a real local Postgres over TEST_DATABASE_URL, tag rows per run,
// and clean up in afterAll.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import {
  createRepair, updateRepair, changeRepairStatus, signOffRepair,
  getRepair, listRepairs, getRepairStatusCounts, listRepairableDevices,
  RepairNotFoundError, RepairDeviceNotFoundError,
} from '@/modules/maintenance/services/repairService'
import { InvalidRepairTransitionError, RepairSignOffError } from '@/modules/maintenance/domain/repairStatus'
import { InvalidStatusChangeError } from '@/modules/manufacturing/domain/deviceStatus'
import {
  installComponent, replaceComponentInstallation,
} from '@/modules/manufacturing/services/componentService'
import { OptimisticLockError } from '@/lib/db/tx'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client
let userId: string
let pcbaTypeId: string
const createdRepairIds: string[] = []
const createdDeviceIds: string[] = []
const createdInstallationIds: string[] = []
const createdUnitIds: string[] = []

// component_unit_sn is unique on (component_type_id, serial_no) and
// component_installation is append-only, so serials are tagged per run — the
// same reasoning componentService.test.ts documents.
const runTag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

// operator: mirrors the SEEDED operator role (catalog.ts), which holds
// change_device_status, with the manufacturing+maintenance module access a
// real operator carries — so the cross-module device move in createRepair/
// sign-off actually runs (it calls Manufacturing's changeDeviceStatus with
// this actor). Cannot sign off (no sign_off_repairs).
const op = (): Actor => ({
  id: userId, roleKey: 'operator',
  permissions: new Set(['view_records', 'create_records', 'edit_records', 'change_device_status']),
  moduleAccess: new Set(['maintenance', 'manufacturing']), active: true,
})
// signer: adds sign_off_repairs (maintenance) AND change_device_status +
// manufacturing module access, so sign-off can also return the device to service.
const signer = (): Actor => ({
  id: userId, roleKey: 'manager',
  permissions: new Set([
    'view_records', 'create_records', 'edit_records', 'sign_off_repairs', 'change_device_status',
  ]),
  moduleAccess: new Set(['maintenance', 'manufacturing']), active: true,
})
const viewer = (): Actor => ({
  id: userId, roleKey: 'viewer',
  permissions: new Set(['view_records']), moduleAccess: new Set(['maintenance']), active: true,
})

async function makeDevice(status: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO device (variant_id, status, created_by, updated_by)
     VALUES ((SELECT id FROM device_variant WHERE code='pro'), $1, $2, $2)
     RETURNING id`, [status, userId])
  createdDeviceIds.push(rows[0].id)
  return rows[0].id
}

/** Opens a repair and records its id for cleanup. */
async function openRepair(status: string, moveDevice = false) {
  const deviceId = await makeDevice(status)
  const res = await createRepair(op(), { deviceId, faultDescription: 'no power', moveDevice })
  createdRepairIds.push(res.repairId)
  return { deviceId, ...res }
}

async function currentVersion(repairId: string): Promise<number> {
  return (await db.query<{ version: number }>(`SELECT version FROM repair WHERE id=$1`, [repairId]))
    .rows[0].version
}

/** Walks a repair to awaiting_sign_off, recording testing notes on the way. */
async function driveToAwaitingSignOff(repairId: string) {
  await changeRepairStatus(op(), { repairId, toStatus: 'in_diagnosis', version: await currentVersion(repairId) })
  await changeRepairStatus(op(), { repairId, toStatus: 'in_repair', version: await currentVersion(repairId) })
  await updateRepair(op(), { repairId, version: await currentVersion(repairId), testingNotes: 'all tests pass' })
  await changeRepairStatus(op(), { repairId, toStatus: 'testing', version: await currentVersion(repairId) })
  await changeRepairStatus(op(), { repairId, toStatus: 'awaiting_sign_off', version: await currentVersion(repairId) })
}

/** A serialized unit of the seeded pcba_a type, recorded for cleanup. */
async function makeUnit(label: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO component_unit (component_type_id, serial_no, created_by, updated_by)
     VALUES ($1,$2,$3,$3) RETURNING id`, [pcbaTypeId, `REP-${label}-${runTag}`, userId])
  createdUnitIds.push(rows[0].id)
  return rows[0].id
}

/** Installs a pcba_a on the device and returns the open installation's id. */
async function installPcba(deviceId: string, unitId: string): Promise<string> {
  const { installationId } = await installComponent(op(), {
    deviceId, componentTypeId: pcbaTypeId, unitId,
  })
  createdInstallationIds.push(installationId)
  return installationId
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  userId = (await db.query(`SELECT id FROM app_user WHERE email='reetmitra8@gmail.com'`)).rows[0].id
  pcbaTypeId = (await db.query(`SELECT id FROM component_type WHERE code='pcba_a'`)).rows[0].id
})
afterAll(async () => {
  if (createdInstallationIds.length) {
    // component_installation is append-only (fn_component_installation_guard
    // rejects DELETE), so the guard is disabled for teardown rather than
    // leaving rows behind in the database every integration file shares —
    // modificationService.test.ts's idiom.
    await db.query(`ALTER TABLE component_installation DISABLE TRIGGER trg_component_installation_guard`)
    await db.query(`DELETE FROM component_installation WHERE device_id = ANY($1)`, [createdDeviceIds])
    await db.query(`ALTER TABLE component_installation ENABLE TRIGGER trg_component_installation_guard`)
  }
  if (createdUnitIds.length) {
    await db.query(`DELETE FROM component_unit WHERE id = ANY($1)`, [createdUnitIds])
  }
  if (createdRepairIds.length) {
    await db.query(`DELETE FROM repair_status_history WHERE repair_id = ANY($1)`, [createdRepairIds])
    await db.query(`DELETE FROM repair WHERE id = ANY($1)`, [createdRepairIds])
  }
  if (createdDeviceIds.length) {
    await db.query(`DELETE FROM device_status_history WHERE device_id = ANY($1)`, [createdDeviceIds])
    await db.query(`DELETE FROM device WHERE id = ANY($1)`, [createdDeviceIds])
  }
  await db.end(); await getPool().end()
})

describe('createRepair', () => {
  it('refuses an actor without create_records', async () => {
    const deviceId = await makeDevice('active')
    await expect(createRepair(viewer(), { deviceId })).rejects.toThrow(PermissionError)
  })

  it('opens a repair at "reported", assigns a repair_no, writes the opening history row', async () => {
    const deviceId = await makeDevice('active')
    const res = await createRepair(op(), { deviceId, faultDescription: 'no power' })
    createdRepairIds.push(res.repairId)
    expect(res.repairNo).toMatch(/^REP-\d{4}-\d{4,}$/)
    expect(res.deviceMoved).toBe(false)
    const rep = await db.query(
      `SELECT status, fault_description, reported_by, created_by, version FROM repair WHERE id=$1`,
      [res.repairId])
    expect(rep.rows[0]).toMatchObject({
      status: 'reported', fault_description: 'no power', reported_by: userId,
      created_by: userId, version: 1,
    })
    const hist = await db.query(
      `SELECT from_status, to_status FROM repair_status_history WHERE repair_id=$1`, [res.repairId])
    expect(hist.rows).toEqual([{ from_status: null, to_status: 'reported' }])
  })

  it('throws RepairDeviceNotFoundError for an unknown device', async () => {
    await expect(createRepair(op(), { deviceId: '00000000-0000-0000-0000-000000000000' }))
      .rejects.toThrow(RepairDeviceNotFoundError)
  })

  it('optionally moves an Active device to Under Repair, in the same transaction', async () => {
    const { deviceId, deviceMoved } = await openRepair('active', true)
    expect(deviceMoved).toBe(true)
    const dev = await db.query(`SELECT status FROM device WHERE id=$1`, [deviceId])
    expect(dev.rows[0].status).toBe('under_repair')
  })
})

describe('changeRepairStatus', () => {
  it('performs an allowed move and writes history', async () => {
    const { repairId } = await openRepair('active')
    const res = await changeRepairStatus(op(), { repairId, toStatus: 'in_diagnosis', version: 1 })
    expect(res.status).toBe('in_diagnosis')
    expect(res.version).toBe(2)
    const hist = await db.query(
      `SELECT from_status, to_status FROM repair_status_history
        WHERE repair_id=$1 ORDER BY changed_at DESC LIMIT 1`, [repairId])
    expect(hist.rows[0]).toMatchObject({ from_status: 'reported', to_status: 'in_diagnosis' })
  })

  it('rejects a forbidden move (fail-closed) and writes nothing', async () => {
    const { repairId } = await openRepair('active')
    await expect(changeRepairStatus(op(), { repairId, toStatus: 'testing', version: 1 }))
      .rejects.toThrow(InvalidRepairTransitionError)
    const rep = await db.query(`SELECT status FROM repair WHERE id=$1`, [repairId])
    expect(rep.rows[0].status).toBe('reported')
  })

  it('requires a note to cancel; succeeds with one and stamps closed_at', async () => {
    const { repairId } = await openRepair('active')
    await expect(changeRepairStatus(op(), { repairId, toStatus: 'cancelled', version: 1 }))
      .rejects.toThrow(InvalidRepairTransitionError)
    const ok = await changeRepairStatus(op(), {
      repairId, toStatus: 'cancelled', version: 1, note: 'duplicate report',
    })
    expect(ok.status).toBe('cancelled')
    const rep = await db.query(`SELECT status, closed_at FROM repair WHERE id=$1`, [repairId])
    expect(rep.rows[0].status).toBe('cancelled')
    expect(rep.rows[0].closed_at).not.toBeNull()
  })

  it('rejects a stale version with OptimisticLockError', async () => {
    const { repairId } = await openRepair('active')
    await expect(changeRepairStatus(op(), { repairId, toStatus: 'in_diagnosis', version: 99 }))
      .rejects.toThrow(OptimisticLockError)
  })

  it('does NOT allow closing from awaiting_sign_off through the ordinary path', async () => {
    const { repairId } = await openRepair('active')
    await driveToAwaitingSignOff(repairId)
    await expect(changeRepairStatus(op(), {
      repairId, toStatus: 'closed', version: await currentVersion(repairId),
    })).rejects.toThrow(InvalidRepairTransitionError)
  })

  it('throws RepairNotFoundError for an unknown id', async () => {
    await expect(changeRepairStatus(op(), {
      repairId: '00000000-0000-0000-0000-000000000000', toStatus: 'in_diagnosis', version: 1,
    })).rejects.toThrow(RepairNotFoundError)
  })
})

describe('updateRepair', () => {
  it('records testing notes (the sign-off precondition) and bumps version', async () => {
    const { repairId } = await openRepair('active')
    const res = await updateRepair(op(), { repairId, version: 1, testingNotes: 'passed burn-in' })
    expect(res.version).toBe(2)
    const rep = await db.query(`SELECT testing_notes, status FROM repair WHERE id=$1`, [repairId])
    expect(rep.rows[0]).toMatchObject({ testing_notes: 'passed burn-in', status: 'reported' })
  })

  it('refuses a viewer and rejects a stale version', async () => {
    const { repairId } = await openRepair('active')
    await expect(updateRepair(viewer(), { repairId, version: 1, diagnosis: 'x' }))
      .rejects.toThrow(PermissionError)
    await expect(updateRepair(op(), { repairId, version: 99, diagnosis: 'x' }))
      .rejects.toThrow(OptimisticLockError)
  })
})

describe('signOffRepair', () => {
  it('refuses an actor without sign_off_repairs', async () => {
    const { repairId } = await openRepair('active')
    await driveToAwaitingSignOff(repairId)
    await expect(signOffRepair(op(), { repairId, version: await currentVersion(repairId) }))
      .rejects.toThrow(PermissionError)
  })

  it('refuses sign-off unless the repair is awaiting_sign_off', async () => {
    const { repairId } = await openRepair('active')
    await expect(signOffRepair(signer(), { repairId, version: 1 }))
      .rejects.toThrow(RepairSignOffError)
  })

  it('refuses sign-off when testing notes are missing', async () => {
    const { repairId } = await openRepair('active')
    // drive to awaiting_sign_off WITHOUT recording testing notes
    await changeRepairStatus(op(), { repairId, toStatus: 'in_diagnosis', version: await currentVersion(repairId) })
    await changeRepairStatus(op(), { repairId, toStatus: 'in_repair', version: await currentVersion(repairId) })
    await changeRepairStatus(op(), { repairId, toStatus: 'testing', version: await currentVersion(repairId) })
    await changeRepairStatus(op(), { repairId, toStatus: 'awaiting_sign_off', version: await currentVersion(repairId) })
    await expect(signOffRepair(signer(), { repairId, version: await currentVersion(repairId) }))
      .rejects.toThrow(RepairSignOffError)
  })

  it('closes the repair, stamps signed_off_by/at, and returns the device to service', async () => {
    const { deviceId, repairId } = await openRepair('active', true) // device now under_repair
    await driveToAwaitingSignOff(repairId)
    const res = await signOffRepair(signer(), { repairId, version: await currentVersion(repairId) })
    expect(res.status).toBe('closed')
    expect(res.deviceReturned).toBe(true)

    const rep = await db.query(
      `SELECT status, signed_off_by, signed_off_at, closed_at FROM repair WHERE id=$1`, [repairId])
    expect(rep.rows[0].status).toBe('closed')
    expect(rep.rows[0].signed_off_by).toBe(userId)
    expect(rep.rows[0].signed_off_at).not.toBeNull()
    expect(rep.rows[0].closed_at).not.toBeNull()

    const dev = await db.query(`SELECT status FROM device WHERE id=$1`, [deviceId])
    expect(dev.rows[0].status).toBe('active')

    const hist = await db.query(
      `SELECT from_status, to_status FROM repair_status_history
        WHERE repair_id=$1 ORDER BY changed_at DESC LIMIT 1`, [repairId])
    expect(hist.rows[0]).toMatchObject({ from_status: 'awaiting_sign_off', to_status: 'closed' })
  })
})

// ── The parts-replaced claim must be BACKED (spec §5.4) ─────────────────────
// The failure mode that matters in a device registry: a technician asserts a
// board was swapped, signs off, and the component record never changed. The
// count is read INSIDE signOffRepair's transaction, under the repair's row
// lock, so it cannot be stale by the time the repair closes.
describe('signOffRepair — the parts-replaced precondition', () => {
  it('records the claim and reports it, with the replacement count, on the detail read', async () => {
    const { repairId } = await openRepair('active')
    await updateRepair(op(), { repairId, version: 1, partsReplaced: true })
    const detail = await getRepair(op(), repairId)
    expect(detail?.partsReplaced).toBe(true)
    expect(detail?.recordedReplacementCount).toBe(0)
  })

  it('refuses sign-off when the claim is made but no installation references the repair', async () => {
    const { repairId } = await openRepair('active', true)
    await driveToAwaitingSignOff(repairId)
    await updateRepair(op(), {
      repairId, version: await currentVersion(repairId), partsReplaced: true,
    })

    await expect(signOffRepair(signer(), { repairId, version: await currentVersion(repairId) }))
      .rejects.toMatchObject({ name: 'RepairSignOffError', code: 'replacement_not_recorded' })

    // and nothing moved: still awaiting sign-off, never stamped
    const rep = await db.query(
      `SELECT status, signed_off_by, closed_at FROM repair WHERE id=$1`, [repairId])
    expect(rep.rows[0]).toMatchObject({ status: 'awaiting_sign_off', signed_off_by: null })
    expect(rep.rows[0].closed_at).toBeNull()
  })

  it('signs off once a replacement performed FROM the repair references it', async () => {
    const { deviceId, repairId } = await openRepair('active', true)
    const open = await installPcba(deviceId, await makeUnit('a'))
    const res = await replaceComponentInstallation(op(), {
      removedInstallationId: open, reason: 'board dead', repairId,
      replacementUnitId: await makeUnit('b'),
    })
    createdInstallationIds.push(res.newId)

    await driveToAwaitingSignOff(repairId)
    await updateRepair(op(), {
      repairId, version: await currentVersion(repairId), partsReplaced: true,
    })

    // the §14 primitive stamps BOTH rows, so the backing count is two
    const detail = await getRepair(op(), repairId)
    expect(detail?.recordedReplacementCount).toBe(2)

    const signed = await signOffRepair(signer(), {
      repairId, version: await currentVersion(repairId),
    })
    expect(signed.status).toBe('closed')
  })

  it('leaves a repair that made no claim entirely unaffected', async () => {
    const { repairId } = await openRepair('active', true)
    await driveToAwaitingSignOff(repairId)
    const rep = await db.query(`SELECT parts_replaced FROM repair WHERE id=$1`, [repairId])
    expect(rep.rows[0].parts_replaced).toBe(false)   // the column default
    const signed = await signOffRepair(signer(), {
      repairId, version: await currentVersion(repairId),
    })
    expect(signed.status).toBe('closed')
  })
})

// ── The device move commits with the repair, or not at all ──────────────────
//
// The property is NOT "both rows read correctly after a successful call" — that
// is equally true when the two commit on two pooled connections, which is what
// MA1 did. It is "interrupt ONE of the two writes and the OTHER must not
// survive", and only a shared transaction can satisfy that.
//
// The interruption is a trigger that refuses one device edge — the outbox
// work's method, and it stands in for exactly the crash the old shape left a
// window for. Every assertion below would FAIL under two transactions: the
// repair would already be committed by the time the device write blew up.
describe('atomicity of the repair ↔ device move', () => {
  /**
   * Refuses one device edge for the duration of `body`. `from`/`to` are test
   * literals, not input. Safe to install on the shared table because integration
   * files run serially (vitest.integration.config.ts: fileParallelism false),
   * and dropped in `finally` so a failing assertion cannot leak it into the
   * files that run after this one.
   */
  async function withBlockedDeviceMove<T>(
    from: string, to: string, body: () => Promise<T>,
  ): Promise<T> {
    await db.query(`
      CREATE OR REPLACE FUNCTION test_block_device_move() RETURNS trigger
      LANGUAGE plpgsql AS $fn$ BEGIN
        RAISE EXCEPTION 'simulated crash while moving the device';
      END $fn$`)
    await db.query(`
      CREATE TRIGGER trg_test_block_device_move BEFORE UPDATE ON device
        FOR EACH ROW WHEN (OLD.status = '${from}' AND NEW.status = '${to}')
        EXECUTE FUNCTION test_block_device_move()`)
    try {
      return await body()
    } finally {
      await db.query(`DROP TRIGGER IF EXISTS trg_test_block_device_move ON device`)
      await db.query(`DROP FUNCTION IF EXISTS test_block_device_move()`)
    }
  }

  it('un-closes the repair when the device cannot be returned to service', async () => {
    const { deviceId, repairId } = await openRepair('active', true)   // device → under_repair
    await driveToAwaitingSignOff(repairId)
    const version = await currentVersion(repairId)

    await withBlockedDeviceMove('under_repair', 'active', async () => {
      await expect(signOffRepair(signer(), { repairId, version }))
        .rejects.toThrow(/simulated crash/)
    })

    // The sign-off rolled back WITH the device move. A closed repair here would
    // mean the two writes were in different transactions — and would be the
    // divergence itself: a repair asserting the device is back in service, beside
    // a device still reading Under Repair, with nothing able to reconcile them.
    const rep = await db.query(
      `SELECT status, version, signed_off_by, signed_off_at, closed_at FROM repair WHERE id=$1`,
      [repairId])
    expect(rep.rows[0]).toMatchObject({
      status: 'awaiting_sign_off', version, signed_off_by: null,
    })
    expect(rep.rows[0].signed_off_at).toBeNull()
    expect(rep.rows[0].closed_at).toBeNull()
    const closedRows = await db.query(
      `SELECT count(*)::int AS n FROM repair_status_history
        WHERE repair_id=$1 AND to_status='closed'`, [repairId])
    expect(closedRows.rows[0].n).toBe(0)
    const dev = await db.query(`SELECT status FROM device WHERE id=$1`, [deviceId])
    expect(dev.rows[0].status).toBe('under_repair')

    // ...and the retry, now unobstructed, lands both halves together.
    const res = await signOffRepair(signer(), { repairId, version })
    expect(res).toMatchObject({ status: 'closed', deviceReturned: true })
    const after = await db.query(`SELECT status FROM device WHERE id=$1`, [deviceId])
    expect(after.rows[0].status).toBe('active')
  })

  it('leaves no repair behind when the device cannot be taken out of service', async () => {
    const deviceId = await makeDevice('active')

    await withBlockedDeviceMove('active', 'under_repair', async () => {
      await expect(createRepair(op(), {
        deviceId, faultDescription: 'no power', moveDevice: true,
      })).rejects.toThrow(/simulated crash/)
    })

    // The repair row and its opening history row demonstrably existed
    // mid-transaction (the device UPDATE runs after both), so a zero count here
    // can only be the transaction having rolled them back.
    const rep = await db.query(
      `SELECT count(*)::int AS n FROM repair WHERE device_id=$1`, [deviceId])
    expect(rep.rows[0].n).toBe(0)
    const dev = await db.query(`SELECT status FROM device WHERE id=$1`, [deviceId])
    expect(dev.rows[0].status).toBe('active')
  })

  /**
   * The behaviour change this atomicity costs, pinned deliberately. MA1
   * swallowed an illegal move into `deviceMoved: false` and committed the repair
   * anyway; a shared transaction cannot do that — a refused move takes the
   * repair with it. `in_stock` has no seeded edge to `under_repair`, so this is
   * the graph refusing, not a database error.
   */
  it('fails the whole repair when a REQUESTED device move has no legal edge', async () => {
    const deviceId = await makeDevice('in_stock')
    await expect(createRepair(op(), { deviceId, moveDevice: true }))
      .rejects.toThrow(InvalidStatusChangeError)
    const rep = await db.query(
      `SELECT count(*)::int AS n FROM repair WHERE device_id=$1`, [deviceId])
    expect(rep.rows[0].n).toBe(0)

    // Without the request, the same device opens a repair perfectly well — the
    // failure above is the move, not the device.
    const ok = await createRepair(op(), { deviceId })
    createdRepairIds.push(ok.repairId)
    expect(ok.deviceMoved).toBe(false)
  })

  /**
   * The ONE skip that survives, and it is a permission question answered from
   * the Actor alone before any connection is taken. `sign_off_repairs` is a
   * Maintenance permission and `change_device_status` a Manufacturing one;
   * refusing the sign-off because the signer cannot also move devices would be a
   * worse failure than a device left Under Repair for someone else to move.
   */
  it('still signs off for a signer who cannot move devices, and says the device stayed put',
    async () => {
      const maintenanceOnlySigner = (): Actor => ({
        id: userId, roleKey: 'manager',
        permissions: new Set(['view_records', 'create_records', 'edit_records', 'sign_off_repairs']),
        moduleAccess: new Set(['maintenance']), active: true,
      })
      const { deviceId, repairId } = await openRepair('active', true)
      await driveToAwaitingSignOff(repairId)

      const res = await signOffRepair(maintenanceOnlySigner(), {
        repairId, version: await currentVersion(repairId),
      })
      expect(res).toMatchObject({ status: 'closed', deviceReturned: false })
      const dev = await db.query(`SELECT status FROM device WHERE id=$1`, [deviceId])
      expect(dev.rows[0].status).toBe('under_repair')
    })

  /** The same leniency on the way in: the repair opens, the device does not move. */
  it('opens the repair for a creator who cannot move devices', async () => {
    const maintenanceOnlyOperator = (): Actor => ({
      id: userId, roleKey: 'operator',
      permissions: new Set(['view_records', 'create_records', 'edit_records']),
      moduleAccess: new Set(['maintenance']), active: true,
    })
    const deviceId = await makeDevice('active')
    const res = await createRepair(maintenanceOnlyOperator(), { deviceId, moveDevice: true })
    createdRepairIds.push(res.repairId)
    expect(res.deviceMoved).toBe(false)
    const dev = await db.query(`SELECT status FROM device WHERE id=$1`, [deviceId])
    expect(dev.rows[0].status).toBe('active')
  })
})

describe('reads', () => {
  it('getRepair returns null for an unknown id and a full detail otherwise', async () => {
    expect(await getRepair(op(), '00000000-0000-0000-0000-000000000000')).toBeNull()
    const { repairId } = await openRepair('active')
    const detail = await getRepair(op(), repairId)
    expect(detail?.status).toBe('reported')
    expect(detail?.statusHistory.length).toBeGreaterThanOrEqual(1)
  })

  it('listRepairs filters by status and device', async () => {
    const { deviceId, repairId } = await openRepair('active')
    const byDevice = await listRepairs(op(), { deviceId })
    expect(byDevice.items.some((r) => r.id === repairId)).toBe(true)
    const reported = await listRepairs(op(), { status: ['reported'] })
    expect(reported.items.every((r) => r.status === 'reported')).toBe(true)
  })

  it('getRepairStatusCounts zero-fills every state', async () => {
    const counts = await getRepairStatusCounts(op())
    expect(counts.map((c) => c.status)).toEqual([
      'reported', 'in_diagnosis', 'in_repair', 'testing', 'awaiting_sign_off', 'closed', 'cancelled',
    ])
    expect(counts.every((c) => c.count >= 0)).toBe(true)
  })

  it('listRepairableDevices refuses a non-maintenance viewer of another module', async () => {
    const noMaint: Actor = {
      id: userId, roleKey: 'viewer',
      permissions: new Set(['view_records']), moduleAccess: new Set(['manufacturing']), active: true,
    }
    await expect(listRepairableDevices(noMaint)).rejects.toThrow(PermissionError)
    const devices = await listRepairableDevices(op())
    expect(Array.isArray(devices)).toBe(true)
  })
})
