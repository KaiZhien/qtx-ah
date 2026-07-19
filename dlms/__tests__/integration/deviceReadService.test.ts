import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import { listDevices, getDevice } from '@/modules/manufacturing/services/deviceReadService'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client
let userId: string
let proId: string

const op = (): Actor => ({
  id: userId, roleKey: 'operator',
  permissions: new Set(['view_records']), moduleAccess: new Set(['manufacturing']), active: true,
})

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  userId = (await db.query(`SELECT id FROM app_user WHERE email = 'reetmitra8@gmail.com'`)).rows[0].id
  proId = (await db.query(`SELECT id FROM device_variant WHERE code = 'pro'`)).rows[0].id
  await db.query(`
    INSERT INTO device (device_sn, variant_id, status, product_name, created_by, updated_by)
    VALUES ('QTX-P-00412', $1, 'in_stock', 'AH Pro', $2, $2),
           ('QTX-B-00099', (SELECT id FROM device_variant WHERE code = 'basic'),
            'shipped', 'AH Basic', $2, $2)`, [proId, userId])
  await db.query(`
    INSERT INTO device (pcba_a_sn_legacy, variant_id, status, needs_data_review, created_by, updated_by)
    VALUES ('EE-02A-2603-0001 to 0015', $1, 'in_stock', true, $2, $2)`, [proId, userId])
})
afterAll(async () => { await db.end(); await getPool().end() })

describe('listDevices', () => {
  it('refuses a caller without Manufacturing access', async () => {
    const outsider: Actor = {
      id: userId, roleKey: 'finance',
      permissions: new Set(['view_records']), moduleAccess: new Set(['finance']), active: true,
    }
    await expect(listDevices(outsider, {})).rejects.toThrow(PermissionError)
  })

  it('finds a device by exact serial number', async () => {
    const { items } = await listDevices(op(), { q: 'QTX-P-00412' })
    expect(items.map((d) => d.deviceSn)).toEqual(['QTX-P-00412'])
  })

  it('finds a device by PARTIAL serial — the way people actually search', async () => {
    const { items } = await listDevices(op(), { q: '00412' })
    expect(items.some((d) => d.deviceSn === 'QTX-P-00412')).toBe(true)
  })

  it('is case-insensitive', async () => {
    const { items } = await listDevices(op(), { q: 'qtx-p-00412' })
    expect(items.some((d) => d.deviceSn === 'QTX-P-00412')).toBe(true)
  })

  it('filters by variant', async () => {
    const { items } = await listDevices(op(), { variant: ['basic'] })
    expect(items.every((d) => d.variantCode === 'basic')).toBe(true)
    expect(items.length).toBeGreaterThan(0)
  })

  it('filters by status', async () => {
    const { items } = await listDevices(op(), { status: ['shipped'] })
    expect(items.every((d) => d.status === 'shipped')).toBe(true)
  })

  it('surfaces legacy rows flagged for review', async () => {
    const { items } = await listDevices(op(), { needsReview: true })
    expect(items.length).toBe(1)
    expect(items[0].needsDataReview).toBe(true)
  })

  it('finds a legacy device by a non-hyphenated fragment of pcba_a_sn_legacy', async () => {
    const { items } = await listDevices(op(), { q: '0001' })
    expect(items.some((d) => d.legacySn === 'EE-02A-2603-0001 to 0015')).toBe(true)
  })

  it('finds a legacy device by a HYPHENATED fragment of pcba_a_sn_legacy', async () => {
    const { items } = await listDevices(op(), { q: '2603-0001' })
    expect(items.some((d) => d.legacySn === 'EE-02A-2603-0001 to 0015')).toBe(true)
  })

  it('finds a legacy device by pcba_a_sn_legacy case-insensitively', async () => {
    const { items } = await listDevices(op(), { q: 'ee-02a' })
    expect(items.some((d) => d.legacySn === 'EE-02A-2603-0001 to 0015')).toBe(true)
  })

  it('paginates by keyset and does not repeat a row across pages', async () => {
    const page1 = await listDevices(op(), { limit: 2 })
    expect(page1.items).toHaveLength(2)
    expect(page1.nextCursor).not.toBeNull()
    const page2 = await listDevices(op(), { limit: 2, cursor: page1.nextCursor! })
    const overlap = page2.items.filter((b) => page1.items.some((a) => a.id === b.id))
    expect(overlap).toEqual([])
  })

  it('excludes soft-deleted devices', async () => {
    const id = (await db.query(`
      INSERT INTO device (device_sn, variant_id, status, created_by, updated_by, deleted_at)
      VALUES ('QTX-DELETED', $1, 'in_stock', $2, $2, now()) RETURNING id`, [proId, userId])).rows[0].id
    const { items } = await listDevices(op(), { q: 'QTX-DELETED' })
    expect(items).toEqual([])
    await db.query(`DELETE FROM device WHERE id = $1`, [id])
  })
})

describe('getDevice', () => {
  it('returns the device with its status history', async () => {
    const id = (await db.query(`SELECT id FROM device WHERE device_sn = 'QTX-P-00412'`)).rows[0].id
    await db.query(`
      INSERT INTO device_status_history (device_id, from_status, to_status, changed_by)
      VALUES ($1, 'in_production', 'in_stock', $2)`, [id, userId])
    const d = await getDevice(op(), id)
    expect(d?.deviceSn).toBe('QTX-P-00412')
    expect(d?.statusHistory).toHaveLength(1)
    expect(d?.statusHistory[0].toStatus).toBe('in_stock')
  })

  it('returns null for an unknown id rather than throwing', async () => {
    expect(await getDevice(op(), crypto.randomUUID())).toBeNull()
  })
})
