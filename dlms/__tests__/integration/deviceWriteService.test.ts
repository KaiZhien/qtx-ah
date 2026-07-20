// __tests__/integration/deviceWriteService.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import { changeDeviceStatus, DeviceNotFoundError } from '@/modules/manufacturing/services/deviceWriteService'
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
