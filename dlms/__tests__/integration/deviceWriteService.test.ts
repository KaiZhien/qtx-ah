// __tests__/integration/deviceWriteService.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import { changeDeviceStatus, DeviceNotFoundError } from '@/modules/manufacturing/services/deviceWriteService'
import { createDevice, updateDevice, listAllowedTransitions, DuplicateSerialError } from '@/modules/manufacturing/services/deviceWriteService'
import { InvalidStatusChangeError } from '@/modules/manufacturing/domain/deviceStatus'
import { OptimisticLockError } from '@/lib/db/tx'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client
let userId: string
const runTag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const createdDeviceIds: string[] = []

// operator: view/create/edit/change_device_status, NOT delete_records
const op = (): Actor => ({
  id: userId, roleKey: 'operator',
  permissions: new Set(['view_records', 'create_records', 'edit_records', 'change_device_status']),
  moduleAccess: new Set(['manufacturing']), active: true,
})
// manager: adds delete_records (can retire/scrap)
const mgr = (): Actor => ({
  id: userId, roleKey: 'manager',
  permissions: new Set(['view_records', 'create_records', 'edit_records', 'change_device_status', 'delete_records']),
  moduleAccess: new Set(['manufacturing']), active: true,
})
const viewer = (): Actor => ({
  id: userId, roleKey: 'viewer',
  permissions: new Set(['view_records']), moduleAccess: new Set(['manufacturing']), active: true,
})

async function makeDevice(status: string): Promise<{ id: string; version: number }> {
  const { rows } = await db.query<{ id: string; version: number }>(
    `INSERT INTO device (variant_id, status, created_by, updated_by)
     VALUES ((SELECT id FROM device_variant WHERE code='pro'), $1, $2, $2)
     RETURNING id, version`, [status, userId])
  createdDeviceIds.push(rows[0].id)
  return rows[0]
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  userId = (await db.query(`SELECT id FROM app_user WHERE email='reetmitra8@gmail.com'`)).rows[0].id
})
afterAll(async () => {
  if (createdDeviceIds.length) {
    await db.query(`DELETE FROM device_status_history WHERE device_id = ANY($1)`, [createdDeviceIds])
    await db.query(`DELETE FROM device WHERE id = ANY($1)`, [createdDeviceIds])
  }
  await db.end(); await getPool().end()
})

describe('changeDeviceStatus', () => {
  it('refuses a viewer (no change_device_status)', async () => {
    const d = await makeDevice('in_production')
    await expect(changeDeviceStatus(viewer(), { deviceId: d.id, toStatus: 'quality_check', version: d.version }))
      .rejects.toThrow(PermissionError)
  })

  it('performs an allowed move: updates status, bumps version, writes history', async () => {
    const d = await makeDevice('in_production')
    const res = await changeDeviceStatus(op(), { deviceId: d.id, toStatus: 'quality_check', version: d.version })
    expect(res.status).toBe('quality_check')
    expect(res.version).toBe(d.version + 1)
    const dev = await db.query(`SELECT status, version FROM device WHERE id=$1`, [d.id])
    expect(dev.rows[0]).toMatchObject({ status: 'quality_check', version: d.version + 1 })
    const hist = await db.query(
      `SELECT from_status, to_status, changed_by FROM device_status_history WHERE device_id=$1`, [d.id])
    expect(hist.rows).toEqual([{ from_status: 'in_production', to_status: 'quality_check', changed_by: userId }])
  })

  it('rejects a move with no status_transition row (fail-closed)', async () => {
    const d = await makeDevice('in_production')
    // in_production -> shipped is not an edge
    await expect(changeDeviceStatus(op(), { deviceId: d.id, toStatus: 'shipped', version: d.version }))
      .rejects.toThrow(InvalidStatusChangeError)
    const dev = await db.query(`SELECT status FROM device WHERE id=$1`, [d.id])
    expect(dev.rows[0].status).toBe('in_production') // unchanged
  })

  it('requires a reason on a requires_reason transition (quality_check -> in_production is rework)', async () => {
    const d = await makeDevice('quality_check')
    await expect(changeDeviceStatus(op(), { deviceId: d.id, toStatus: 'in_production', version: d.version }))
      .rejects.toThrow(InvalidStatusChangeError)
    // with a reason it succeeds and stores the reason
    const ok = await changeDeviceStatus(op(), { deviceId: d.id, toStatus: 'in_production', version: d.version, reason: 'solder rework' })
    expect(ok.status).toBe('in_production')
    const hist = await db.query(
      `SELECT reason FROM device_status_history WHERE device_id=$1 ORDER BY changed_at DESC LIMIT 1`, [d.id])
    expect(hist.rows[0].reason).toBe('solder rework')
  })

  it('blocks an operator from a terminal transition (needs delete_records)', async () => {
    // active -> retired is terminal. Seed device at 'active'.
    const d = await makeDevice('active')
    await expect(changeDeviceStatus(op(), { deviceId: d.id, toStatus: 'retired', version: d.version }))
      .rejects.toThrow(PermissionError)
    const dev = await db.query(`SELECT status FROM device WHERE id=$1`, [d.id])
    expect(dev.rows[0].status).toBe('active') // rolled back
  })

  it('lets a manager perform the terminal transition', async () => {
    const d = await makeDevice('active')
    const res = await changeDeviceStatus(mgr(), { deviceId: d.id, toStatus: 'retired', version: d.version })
    expect(res.status).toBe('retired')
  })

  it('rejects a stale version with OptimisticLockError', async () => {
    const d = await makeDevice('in_production')
    await expect(changeDeviceStatus(op(), { deviceId: d.id, toStatus: 'quality_check', version: d.version + 99 }))
      .rejects.toThrow(OptimisticLockError)
  })

  it('throws DeviceNotFoundError for an unknown id', async () => {
    await expect(changeDeviceStatus(op(), {
      deviceId: '00000000-0000-0000-0000-000000000000', toStatus: 'quality_check', version: 1,
    })).rejects.toThrow(DeviceNotFoundError)
  })
})

describe('createDevice', () => {
  it('refuses an actor without create_records', async () => {
    await expect(createDevice(viewer(), { variantCode: 'pro' })).rejects.toThrow(PermissionError)
  })

  it('creates a device at the initial status with a "Created" history row', async () => {
    const res = await createDevice(op(), {
      variantCode: 'pro', deviceSn: `QTX-W-${runTag}`, productName: 'Widget', customer: 'ACME',
    })
    createdDeviceIds.push(res.deviceId)
    expect(res.status).toBe('in_production') // the seeded is_initial status
    const dev = await db.query(`SELECT status, device_sn, product_name, created_by, version FROM device WHERE id=$1`, [res.deviceId])
    expect(dev.rows[0]).toMatchObject({
      status: 'in_production', device_sn: `QTX-W-${runTag}`, product_name: 'Widget', created_by: userId, version: 1,
    })
    const hist = await db.query(`SELECT from_status, to_status FROM device_status_history WHERE device_id=$1`, [res.deviceId])
    expect(hist.rows).toEqual([{ from_status: null, to_status: 'in_production' }])
  })

  it('rejects an unknown variant', async () => {
    await expect(createDevice(op(), { variantCode: 'nope' })).rejects.toThrow(/variant/i)
  })

  it('rejects a duplicate serial with DuplicateSerialError', async () => {
    const sn = `QTX-DUP-${runTag}`
    const a = await createDevice(op(), { variantCode: 'pro', deviceSn: sn })
    createdDeviceIds.push(a.deviceId)
    await expect(createDevice(op(), { variantCode: 'pro', deviceSn: sn })).rejects.toThrow(DuplicateSerialError)
  })
})

describe('updateDevice', () => {
  it('edits non-status fields, bumps version, leaves status untouched', async () => {
    const c = await createDevice(op(), { variantCode: 'pro', productName: 'Before' })
    createdDeviceIds.push(c.deviceId)
    const dev0 = await db.query(`SELECT version, status FROM device WHERE id=$1`, [c.deviceId])
    const res = await updateDevice(op(), {
      deviceId: c.deviceId, version: dev0.rows[0].version, productName: 'After', remarks: 'note',
    })
    expect(res.version).toBe(dev0.rows[0].version + 1)
    const dev1 = await db.query(`SELECT product_name, remarks, status, updated_by FROM device WHERE id=$1`, [c.deviceId])
    expect(dev1.rows[0]).toMatchObject({
      product_name: 'After', remarks: 'note', status: dev0.rows[0].status, updated_by: userId,
    })
  })

  it('rejects a stale version', async () => {
    const c = await createDevice(op(), { variantCode: 'pro' })
    createdDeviceIds.push(c.deviceId)
    await expect(updateDevice(op(), { deviceId: c.deviceId, version: 999, productName: 'x' }))
      .rejects.toThrow(OptimisticLockError)
  })

  it('rejects renaming to an existing serial (DuplicateSerialError)', async () => {
    const taken = `QTX-TAKEN-${runTag}`
    const a = await createDevice(op(), { variantCode: 'pro', deviceSn: taken })
    const b = await createDevice(op(), { variantCode: 'pro' })
    createdDeviceIds.push(a.deviceId, b.deviceId)
    const bv = (await db.query(`SELECT version FROM device WHERE id=$1`, [b.deviceId])).rows[0].version
    await expect(updateDevice(op(), { deviceId: b.deviceId, version: bv, deviceSn: taken }))
      .rejects.toThrow(DuplicateSerialError)
  })

  it('does NOT expose a status field (status is change-only)', async () => {
    const c = await createDevice(op(), { variantCode: 'pro' })
    createdDeviceIds.push(c.deviceId)
    const bv = (await db.query(`SELECT version FROM device WHERE id=$1`, [c.deviceId])).rows[0].version
    // @ts-expect-error status is intentionally not part of UpdateDeviceInput
    await updateDevice(op(), { deviceId: c.deviceId, version: bv, status: 'shipped' })
    const dev = await db.query(`SELECT status FROM device WHERE id=$1`, [c.deviceId])
    expect(dev.rows[0].status).toBe('in_production') // ignored
  })
})

describe('listAllowedTransitions', () => {
  it('returns only the edges out of the given status, with metadata', async () => {
    const rows = await listAllowedTransitions(op(), 'quality_check')
    const codes = rows.map((r) => r.toStatus).sort()
    expect(codes).toEqual(['in_production', 'in_stock']) // the two edges from quality_check
    const rework = rows.find((r) => r.toStatus === 'in_production')!
    expect(rework.requiresReason).toBe(true)
    expect(rework.isTerminal).toBe(false)
  })

  it('returns [] for a terminal status', async () => {
    expect(await listAllowedTransitions(op(), 'retired')).toEqual([])
  })
})
