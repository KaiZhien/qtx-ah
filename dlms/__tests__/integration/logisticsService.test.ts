// __tests__/integration/logisticsService.test.ts
//
// Written following deviceWriteService.test.ts's idiom (mock
// @/lib/supabase/server, real pg via TEST_DATABASE_URL, runTag-suffixed
// unique values, afterAll cleanup). Per the worktree's parallel-agent
// constraints this file is NOT run here — no docker / no `test:integration`
// available in this worktree (the test-db port is shared across parallel
// agents); the controller runs it at merge time against the applied
// 20260720130000_platform_logistics.sql migration.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import {
  listLocations, getLocation, createLocation, updateLocation,
  LocationNotFoundError, DuplicateLocationCodeError,
} from '@/modules/logistics/services/locationService'
import {
  listDeliveryOrders, getDeliveryOrder, createDeliveryOrder, updateDeliveryOrder, changeDoStatus,
  getDoStatusCounts, DeliveryOrderNotFoundError, DuplicateDoNumberError,
} from '@/modules/logistics/services/deliveryOrderService'
import { InvalidDoStatusChangeError } from '@/modules/logistics/domain/doStatus'
import { OptimisticLockError } from '@/lib/db/tx'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client
let userId: string
const runTag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const createdLocationIds: string[] = []
const createdDoIds: string[] = []
const createdDeviceIds: string[] = []

// operator: view/create/edit, no delete_records — matches deliverable's gate
// spec (writes on logistics use create_records/edit_records, not a
// module-specific "change status" permission).
const op = (): Actor => ({
  id: userId, roleKey: 'operator',
  permissions: new Set(['view_records', 'create_records', 'edit_records']),
  moduleAccess: new Set(['logistics']), active: true,
})
const viewer = (): Actor => ({
  id: userId, roleKey: 'viewer',
  permissions: new Set(['view_records']), moduleAccess: new Set(['logistics']), active: true,
})
// Holds logistics permissions but was never granted the logistics module
// itself — exercises the module-access half of authorize() (spec §3.2).
const noModuleAccess = (): Actor => ({
  id: userId, roleKey: 'operator',
  permissions: new Set(['view_records', 'create_records', 'edit_records']),
  moduleAccess: new Set(['manufacturing']), active: true,
})

async function makeLocation(codeSuffix: string): Promise<{ id: string; version: number; code: string }> {
  const code = `LOC-${runTag}-${codeSuffix}`
  const { rows } = await db.query<{ id: string; version: number }>(
    `INSERT INTO stock_location (code, name, created_by, updated_by)
     VALUES ($1, $2, $3, $3) RETURNING id, version`,
    [code, `Test location ${codeSuffix}`, userId])
  createdLocationIds.push(rows[0].id)
  return { ...rows[0], code }
}

async function makeDeliveryOrder(
  doNoSuffix: string, status = 'draft',
): Promise<{ id: string; version: number }> {
  const { rows } = await db.query<{ id: string; version: number }>(
    `INSERT INTO delivery_order (do_no, status, created_by, updated_by)
     VALUES ($1, $2, $3, $3) RETURNING id, version`,
    [`DO-${runTag}-${doNoSuffix}`, status, userId])
  createdDoIds.push(rows[0].id)
  return rows[0]
}

async function makeDevice(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO device (variant_id, status, created_by, updated_by)
     VALUES ((SELECT id FROM device_variant WHERE code='pro'),
             (SELECT code FROM status_option WHERE is_initial LIMIT 1), $1, $1)
     RETURNING id`, [userId])
  createdDeviceIds.push(rows[0].id)
  return rows[0].id
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  userId = (await db.query(`SELECT id FROM app_user WHERE email='reetmitra8@gmail.com'`)).rows[0].id
})

afterAll(async () => {
  if (createdDoIds.length) {
    await db.query(`DELETE FROM delivery_order_line WHERE delivery_order_id = ANY($1)`, [createdDoIds])
    await db.query(`DELETE FROM delivery_order WHERE id = ANY($1)`, [createdDoIds])
  }
  if (createdDeviceIds.length) {
    await db.query(`DELETE FROM device WHERE id = ANY($1)`, [createdDeviceIds])
  }
  if (createdLocationIds.length) {
    await db.query(`DELETE FROM stock_location WHERE id = ANY($1)`, [createdLocationIds])
  }
  await db.end()
  await getPool().end()
})

describe('locationService', () => {
  describe('listLocations / getLocation', () => {
    it('refuses a caller without view_records', async () => {
      const noAccess: Actor = { ...viewer(), permissions: new Set() }
      await expect(listLocations(noAccess)).rejects.toThrow(PermissionError)
    })

    it('excludes inactive locations by default, includes them on request', async () => {
      const loc = await makeLocation('inactive-default')
      await db.query(`UPDATE stock_location SET active = false WHERE id = $1`, [loc.id])
      const active = await listLocations(op())
      expect(active.find((l) => l.id === loc.id)).toBeUndefined()
      const all = await listLocations(op(), { includeInactive: true })
      expect(all.find((l) => l.id === loc.id)).toBeDefined()
    })

    it('returns null from getLocation for an unknown id', async () => {
      expect(await getLocation(op(), '00000000-0000-0000-0000-000000000000')).toBeNull()
    })
  })

  describe('createLocation', () => {
    it('refuses a viewer (no create_records)', async () => {
      await expect(createLocation(viewer(), { code: `x-${runTag}`, name: 'X' }))
        .rejects.toThrow(PermissionError)
    })

    it('refuses an actor without logistics module access', async () => {
      await expect(createLocation(noModuleAccess(), { code: `x2-${runTag}`, name: 'X2' }))
        .rejects.toThrow(PermissionError)
    })

    it('creates a location with the given fields', async () => {
      const code = `SG-WH-${runTag}`
      const res = await createLocation(op(), { code, name: 'Warehouse 1', country: 'SG' })
      createdLocationIds.push(res.id)
      const row = await db.query(`SELECT code, name, country, active, created_by FROM stock_location WHERE id=$1`, [res.id])
      expect(row.rows[0]).toMatchObject({ code, name: 'Warehouse 1', country: 'SG', active: true, created_by: userId })
    })

    it('rejects a duplicate code with DuplicateLocationCodeError', async () => {
      const code = `DUP-${runTag}`
      const a = await createLocation(op(), { code, name: 'A' })
      createdLocationIds.push(a.id)
      await expect(createLocation(op(), { code, name: 'B' })).rejects.toThrow(DuplicateLocationCodeError)
    })
  })

  describe('updateLocation', () => {
    it('edits fields, bumps version, leaves omitted fields untouched', async () => {
      const loc = await makeLocation('edit-me')
      const res = await updateLocation(op(), loc.id, { name: 'Renamed', country: 'MY' }, loc.version)
      expect(res.version).toBe(loc.version + 1)
      const row = await db.query(`SELECT name, country, code FROM stock_location WHERE id=$1`, [loc.id])
      expect(row.rows[0].name).toBe('Renamed')
      expect(row.rows[0].country).toBe('MY')
    })

    it('rejects a stale version', async () => {
      const loc = await makeLocation('stale')
      await expect(updateLocation(op(), loc.id, { name: 'x' }, loc.version + 99))
        .rejects.toThrow(OptimisticLockError)
    })

    it('rejects renaming the code to one already in use', async () => {
      const taken = await makeLocation('taken')
      const other = await makeLocation('other')
      await expect(updateLocation(op(), other.id, { code: taken.code }, other.version))
        .rejects.toThrow(DuplicateLocationCodeError)
    })

    it('throws LocationNotFoundError for an unknown id', async () => {
      await expect(updateLocation(op(), '00000000-0000-0000-0000-000000000000', { name: 'x' }, 1))
        .rejects.toThrow(LocationNotFoundError)
    })
  })
})

describe('deliveryOrderService', () => {
  describe('createDeliveryOrder', () => {
    it('refuses a viewer (no create_records)', async () => {
      await expect(createDeliveryOrder(viewer(), { doNo: `x-${runTag}` })).rejects.toThrow(PermissionError)
    })

    it('creates a DO at draft status with no lines', async () => {
      const doNo = `DO-CREATE-${runTag}`
      const res = await createDeliveryOrder(op(), { doNo, customer: 'ACME' })
      createdDoIds.push(res.id)
      expect(res.status).toBe('draft')
      const row = await db.query(`SELECT status, do_no, customer, created_by, version FROM delivery_order WHERE id=$1`, [res.id])
      expect(row.rows[0]).toMatchObject({ status: 'draft', do_no: doNo, customer: 'ACME', created_by: userId, version: 1 })
    })

    it('creates a DO with lines in one transaction, numbering them in order', async () => {
      const deviceId = await makeDevice()
      const res = await createDeliveryOrder(op(), {
        doNo: `DO-LINES-${runTag}`,
        lines: [
          { description: 'Widget A', quantity: 2 },
          { deviceId, quantity: 1 },
        ],
      })
      createdDoIds.push(res.id)
      const lines = await db.query(
        `SELECT line_no, device_id, description, quantity FROM delivery_order_line
          WHERE delivery_order_id=$1 ORDER BY line_no`, [res.id])
      expect(lines.rows).toEqual([
        { line_no: 1, device_id: null, description: 'Widget A', quantity: '2.00' },
        { line_no: 2, device_id: deviceId, description: null, quantity: '1.00' },
      ])
    })

    it('rolls back the header when a line insert fails (unknown device_id)', async () => {
      const doNo = `DO-ROLLBACK-${runTag}`
      await expect(createDeliveryOrder(op(), {
        doNo,
        lines: [{ deviceId: '00000000-0000-0000-0000-000000000000', quantity: 1 }],
      })).rejects.toThrow()
      const row = await db.query(`SELECT id FROM delivery_order WHERE do_no=$1`, [doNo])
      expect(row.rows).toHaveLength(0)
    })

    it('rejects a duplicate do_no with DuplicateDoNumberError', async () => {
      const doNo = `DO-DUP-${runTag}`
      const a = await createDeliveryOrder(op(), { doNo })
      createdDoIds.push(a.id)
      await expect(createDeliveryOrder(op(), { doNo })).rejects.toThrow(DuplicateDoNumberError)
    })
  })

  describe('getDeliveryOrder', () => {
    it('returns null for an unknown id', async () => {
      expect(await getDeliveryOrder(op(), '00000000-0000-0000-0000-000000000000')).toBeNull()
    })

    it('returns the header with lines and joined device serials', async () => {
      const res = await createDeliveryOrder(op(), {
        doNo: `DO-GET-${runTag}`,
        lines: [{ description: 'Part', quantity: 3 }],
      })
      createdDoIds.push(res.id)
      const detail = await getDeliveryOrder(op(), res.id)
      expect(detail?.lines).toEqual([
        expect.objectContaining({ lineNo: 1, description: 'Part', quantity: 3, deviceId: null, deviceSn: null }),
      ])
    })
  })

  describe('listDeliveryOrders', () => {
    it('filters by status', async () => {
      const draft = await makeDeliveryOrder('list-draft', 'draft')
      const cancelled = await makeDeliveryOrder('list-cancelled', 'cancelled')
      const { items } = await listDeliveryOrders(op(), { status: ['cancelled'], limit: 50 })
      const ids = items.map((i) => i.id)
      expect(ids).toContain(cancelled.id)
      expect(ids).not.toContain(draft.id)
    })
  })

  describe('updateDeliveryOrder', () => {
    it('edits header fields, bumps version, never touches status', async () => {
      const d = await makeDeliveryOrder('update-header')
      const res = await updateDeliveryOrder(op(), {
        deliveryOrderId: d.id, version: d.version, customer: 'New Customer', carrier: 'DHL',
      })
      expect(res.version).toBe(d.version + 1)
      const row = await db.query(`SELECT customer, carrier, status FROM delivery_order WHERE id=$1`, [d.id])
      expect(row.rows[0]).toMatchObject({ customer: 'New Customer', carrier: 'DHL', status: 'draft' })
    })

    it('rejects a stale version', async () => {
      const d = await makeDeliveryOrder('update-stale')
      await expect(updateDeliveryOrder(op(), { deliveryOrderId: d.id, version: d.version + 99, carrier: 'x' }))
        .rejects.toThrow(OptimisticLockError)
    })

    it('does NOT expose a status field (status is change-only)', async () => {
      const d = await makeDeliveryOrder('no-status-field')
      // @ts-expect-error status is intentionally not part of UpdateDeliveryOrderInput
      await updateDeliveryOrder(op(), { deliveryOrderId: d.id, version: d.version, status: 'dispatched' })
      const row = await db.query(`SELECT status FROM delivery_order WHERE id=$1`, [d.id])
      expect(row.rows[0].status).toBe('draft') // ignored
    })
  })

  describe('changeDoStatus', () => {
    it('refuses a viewer (no edit_records)', async () => {
      const d = await makeDeliveryOrder('status-viewer')
      await expect(changeDoStatus(viewer(), { deliveryOrderId: d.id, toStatus: 'prepared', version: d.version }))
        .rejects.toThrow(PermissionError)
    })

    it('performs an allowed move and bumps version', async () => {
      const d = await makeDeliveryOrder('status-happy')
      const res = await changeDoStatus(op(), { deliveryOrderId: d.id, toStatus: 'prepared', version: d.version })
      expect(res).toEqual({ status: 'prepared', version: d.version + 1 })
    })

    it('rejects an illegal move (fail-closed): draft -> delivered', async () => {
      const d = await makeDeliveryOrder('status-skip')
      await expect(changeDoStatus(op(), { deliveryOrderId: d.id, toStatus: 'delivered', version: d.version }))
        .rejects.toThrow(InvalidDoStatusChangeError)
      const row = await db.query(`SELECT status FROM delivery_order WHERE id=$1`, [d.id])
      expect(row.rows[0].status).toBe('draft') // unchanged
    })

    it('stamps delivered_date with today when moving into delivered, if unset', async () => {
      const d = await makeDeliveryOrder('status-delivered', 'dispatched')
      const res = await changeDoStatus(op(), { deliveryOrderId: d.id, toStatus: 'delivered', version: d.version })
      expect(res.status).toBe('delivered')
      const row = await db.query(`SELECT delivered_date FROM delivery_order WHERE id=$1`, [d.id])
      expect(row.rows[0].delivered_date).not.toBeNull()
    })

    it('does not overwrite an already-set delivered_date', async () => {
      const d = await makeDeliveryOrder('status-delivered-preset', 'dispatched')
      await db.query(`UPDATE delivery_order SET delivered_date = '2026-01-01' WHERE id = $1`, [d.id])
      await changeDoStatus(op(), { deliveryOrderId: d.id, toStatus: 'delivered', version: d.version })
      // ::text sidesteps node-postgres parsing the DATE to a local-midnight JS
      // Date, whose toISOString() shifts a day on any UTC+ host (e.g. SGT).
      const row = await db.query(
        `SELECT delivered_date::text AS delivered_date FROM delivery_order WHERE id=$1`, [d.id])
      expect(row.rows[0].delivered_date).toBe('2026-01-01')
    })

    it('rejects a stale version with OptimisticLockError', async () => {
      const d = await makeDeliveryOrder('status-stale')
      await expect(changeDoStatus(op(), { deliveryOrderId: d.id, toStatus: 'prepared', version: d.version + 99 }))
        .rejects.toThrow(OptimisticLockError)
    })

    it('throws DeliveryOrderNotFoundError for an unknown id', async () => {
      await expect(changeDoStatus(op(), {
        deliveryOrderId: '00000000-0000-0000-0000-000000000000', toStatus: 'prepared', version: 1,
      })).rejects.toThrow(DeliveryOrderNotFoundError)
    })

    it('rejects moving out of a terminal status (cancelled)', async () => {
      const d = await makeDeliveryOrder('status-terminal', 'cancelled')
      await expect(changeDoStatus(op(), { deliveryOrderId: d.id, toStatus: 'prepared', version: d.version }))
        .rejects.toThrow(InvalidDoStatusChangeError)
    })
  })

  describe('getDoStatusCounts', () => {
    it('includes every known status, even with zero rows', async () => {
      const counts = await getDoStatusCounts(op())
      const statuses = counts.map((c) => c.status)
      expect(statuses).toEqual(['draft', 'prepared', 'dispatched', 'delivered', 'cancelled'])
    })
  })
})
