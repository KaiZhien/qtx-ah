// __tests__/integration/repairService.test.ts
//
// Mirrors deviceWriteService.test.ts's harness idiom: mock the supabase server
// module, talk to a real local Postgres over TEST_DATABASE_URL, tag rows per run,
// and clean up in afterAll. NOT run in this worktree (no docker / no
// test:integration here — shared port with parallel agents); the controller runs
// the integration suite serially at merge.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import {
  createRepair, updateRepair, changeRepairStatus, signOffRepair,
  getRepair, listRepairs, getRepairStatusCounts, listRepairableDevices,
  RepairNotFoundError, RepairDeviceNotFoundError,
} from '@/modules/maintenance/services/repairService'
import { InvalidRepairTransitionError, RepairSignOffError } from '@/modules/maintenance/domain/repairStatus'
import { OptimisticLockError } from '@/lib/db/tx'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client
let userId: string
const createdRepairIds: string[] = []
const createdDeviceIds: string[] = []

// operator: view/create/edit on maintenance — can open, edit, and walk repairs,
// but cannot sign off and cannot change device status.
const op = (): Actor => ({
  id: userId, roleKey: 'operator',
  permissions: new Set(['view_records', 'create_records', 'edit_records']),
  moduleAccess: new Set(['maintenance']), active: true,
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

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  userId = (await db.query(`SELECT id FROM app_user WHERE email='reetmitra8@gmail.com'`)).rows[0].id
})
afterAll(async () => {
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

  it('optionally moves an Active device to Under Repair (non-atomic second tx)', async () => {
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
