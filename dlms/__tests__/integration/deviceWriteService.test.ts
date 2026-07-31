// __tests__/integration/deviceWriteService.test.ts
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import { changeDeviceStatus, changeDeviceStatusInTx, DeviceNotFoundError } from '@/modules/manufacturing/services/deviceWriteService'
import { createDevice, updateDevice, listAllowedTransitions, DuplicateSerialError } from '@/modules/manufacturing/services/deviceWriteService'
import { InvalidStatusChangeError } from '@/modules/manufacturing/domain/deviceStatus'
import { withTransaction, OptimisticLockError } from '@/lib/db/tx'
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

async function makeDevice(
  status: string, deviceSn: string | null = null,
): Promise<{ id: string; version: number }> {
  const { rows } = await db.query<{ id: string; version: number }>(
    `INSERT INTO device (variant_id, status, device_sn, created_by, updated_by)
     VALUES ((SELECT id FROM device_variant WHERE code='pro'), $1, $3, $2, $2)
     RETURNING id, version`, [status, userId, deviceSn])
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
    await db.query(`DELETE FROM outbox WHERE aggregate_id = ANY($1)`, [createdDeviceIds])
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

/**
 * The transactional outbox (spec §5.5). The property under test is not "a row
 * appears" but "the row and the status change share one fate": a move the graph,
 * the reason rule or the permission rule rejects must leave NO event behind, and
 * a move that commits must leave exactly one — so a handoff can be delayed by a
 * stalled drain but never lost to a crash between commit and event send.
 */
describe('changeDeviceStatus — outbox handoff events', () => {
  type OutboxRow = {
    aggregate_type: string; aggregate_id: string; event_type: string
    payload: Record<string, unknown>; created_by: string
    processed_at: string | null; attempts: number
  }
  const eventsFor = async (deviceId: string): Promise<OutboxRow[]> => {
    const { rows } = await db.query<OutboxRow>(
      `SELECT aggregate_type, aggregate_id, event_type, payload, created_by, processed_at, attempts
         FROM outbox WHERE aggregate_id = $1 ORDER BY occurred_at`, [deviceId])
    return rows
  }
  const historyFor = async (deviceId: string) =>
    (await db.query(`SELECT from_status, to_status FROM device_status_history WHERE device_id=$1`,
      [deviceId])).rows

  it('emits exactly one event for a transition carrying a task_template_key', async () => {
    // ready_for_delivery -> shipped is the one seeded edge with a template key.
    const d = await makeDevice('ready_for_delivery', `QTX-OB-${runTag}`)
    const res = await changeDeviceStatus(op(), {
      deviceId: d.id, toStatus: 'shipped', version: d.version, reason: 'palletised',
    })

    // The status change itself is unaffected by the event write.
    expect(res).toEqual({ status: 'shipped', version: d.version + 1 })
    const dev = await db.query(`SELECT status, version FROM device WHERE id=$1`, [d.id])
    expect(dev.rows[0]).toMatchObject({ status: 'shipped', version: d.version + 1 })
    expect(await historyFor(d.id)).toEqual([
      { from_status: 'ready_for_delivery', to_status: 'shipped' },
    ])

    const events = await eventsFor(d.id)
    expect(events).toHaveLength(1)
    expect(events[0]).toMatchObject({
      aggregate_type: 'device', aggregate_id: d.id, event_type: 'device_status_changed',
      created_by: userId,        // the human who caused it, not the drain
      processed_at: null, attempts: 0,
    })
    expect(events[0].payload).toMatchObject({
      taskTemplateKey: 'logistics_prepare_delivery',
      fromStatus: 'ready_for_delivery',
      toStatus: 'shipped',
      reason: 'palletised',
      notifyRoles: null,         // not seeded on this edge
      // Device identity travels with the event so the drain can name the device
      // without re-reading a row that may have moved on by then.
      deviceSn: `QTX-OB-${runTag}`,
      pcbaASnLegacy: null,
    })
  })

  it('emits nothing for a transition without a task_template_key', async () => {
    const d = await makeDevice('in_production')
    await changeDeviceStatus(op(), { deviceId: d.id, toStatus: 'quality_check', version: d.version })
    // The move really happened — the empty outbox is a deliberate no-op, not a failure.
    const dev = await db.query(`SELECT status FROM device WHERE id=$1`, [d.id])
    expect(dev.rows[0].status).toBe('quality_check')
    expect(await eventsFor(d.id)).toEqual([])
  })

  it('emits nothing when the transition graph rejects the move', async () => {
    // ready_for_delivery has a template-key edge (-> shipped) but no edge to delivered.
    const d = await makeDevice('ready_for_delivery')
    await expect(changeDeviceStatus(op(), {
      deviceId: d.id, toStatus: 'delivered', version: d.version,
    })).rejects.toThrow(InvalidStatusChangeError)
    expect(await eventsFor(d.id)).toEqual([])
    const dev = await db.query(`SELECT status FROM device WHERE id=$1`, [d.id])
    expect(dev.rows[0].status).toBe('ready_for_delivery')
  })

  it('emits nothing when the terminal-status permission rule rejects the move', async () => {
    // No seeded terminal edge carries a template key, so attach one for the duration
    // of this test: without it the assertion would pass vacuously. Restored in
    // `finally`, and safe to mutate because integration files run serially
    // (vitest.integration.config.ts: fileParallelism false) and status_transition
    // carries no audit trigger.
    await db.query(
      `UPDATE status_transition SET task_template_key='logistics_prepare_delivery',
              notify_roles=ARRAY['manager']
        WHERE from_status='active' AND to_status='retired'`)
    try {
      const blocked = await makeDevice('active')
      await expect(changeDeviceStatus(op(), {
        deviceId: blocked.id, toStatus: 'retired', version: blocked.version,
      })).rejects.toThrow(PermissionError)     // operator lacks delete_records
      expect(await eventsFor(blocked.id)).toEqual([])
      expect(await historyFor(blocked.id)).toEqual([])
      const dev = await db.query(`SELECT status, version FROM device WHERE id=$1`, [blocked.id])
      expect(dev.rows[0]).toMatchObject({ status: 'active', version: blocked.version })

      // Control: the same edge DOES emit for an actor who may make the move, so the
      // emptiness above is the rollback and not a transition that never emits.
      const allowed = await makeDevice('active')
      await changeDeviceStatus(mgr(), {
        deviceId: allowed.id, toStatus: 'retired', version: allowed.version, reason: 'end of life',
      })
      const events = await eventsFor(allowed.id)
      expect(events).toHaveLength(1)
      expect(events[0].payload).toMatchObject({
        taskTemplateKey: 'logistics_prepare_delivery',
        fromStatus: 'active', toStatus: 'retired', reason: 'end of life',
        notifyRoles: ['manager'],              // carried verbatim for the future notifications task
      })
    } finally {
      await db.query(
        `UPDATE status_transition SET task_template_key=NULL, notify_roles=NULL
          WHERE from_status='active' AND to_status='retired'`)
    }
  })
})

/**
 * The Tx-accepting entry point Maintenance reaches for (spec §5.3). Two
 * properties, and neither is "it writes the row":
 *
 *  1. It joins the CALLER's transaction rather than opening one, so the caller's
 *     rollback takes the device move with it. That is the whole reason it exists.
 *  2. It is an entry point in its OWN right — a caller handing it a live `tx`
 *     does not thereby vouch for the actor.
 */
describe('changeDeviceStatusInTx', () => {
  it('rolls back with the caller when the caller fails afterwards', async () => {
    const d = await makeDevice('ready_for_delivery', `QTX-TX-${runTag}`)
    const boom = new Error('caller failed after the device moved')

    await expect(withTransaction(userId, async (tx) => {
      // The move genuinely happens inside the transaction...
      const moved = await changeDeviceStatusInTx(tx, op(), {
        deviceId: d.id, toStatus: 'shipped', version: d.version,
      })
      expect(moved).toEqual({ status: 'shipped', version: d.version + 1 })
      const midFlight = await tx.query(`SELECT status FROM device WHERE id=$1`, [d.id])
      expect(midFlight.rows[0].status).toBe('shipped')
      // ...and then the caller's own work fails.
      throw boom
    })).rejects.toThrow(boom)

    // All three writes are gone together — the device, its history row, and the
    // handoff event this edge emits. A separate transaction would have kept them.
    const dev = await db.query(`SELECT status, version FROM device WHERE id=$1`, [d.id])
    expect(dev.rows[0]).toMatchObject({ status: 'ready_for_delivery', version: d.version })
    const hist = await db.query(
      `SELECT count(*)::int AS n FROM device_status_history WHERE device_id=$1`, [d.id])
    expect(hist.rows[0].n).toBe(0)
    const evt = await db.query(`SELECT count(*)::int AS n FROM outbox WHERE aggregate_id=$1`, [d.id])
    expect(evt.rows[0].n).toBe(0)
  })

  it('refuses a viewer even when handed an open transaction', async () => {
    const d = await makeDevice('in_production')
    await expect(withTransaction(userId, (tx) => changeDeviceStatusInTx(tx, viewer(), {
      deviceId: d.id, toStatus: 'quality_check', version: d.version,
    }))).rejects.toThrow(PermissionError)
    const dev = await db.query(`SELECT status FROM device WHERE id=$1`, [d.id])
    expect(dev.rows[0].status).toBe('in_production')
  })

  it('validates its own input even when handed an open transaction', async () => {
    await expect(withTransaction(userId, (tx) => changeDeviceStatusInTx(tx, op(), {
      deviceId: 'not-a-uuid', toStatus: 'quality_check', version: 1,
    }))).rejects.toThrow(/uuid/i)
  })
})

/**
 * ORDERING, not merely outcome — the same property taskService.test.ts pins for
 * createTask, and for the same reason. authorize.ts is documented as "the choke
 * point. Every service entry point calls this before touching data", and
 * extracting changeDeviceStatusInTx is exactly the refactor that tends to move
 * those checks inside the transaction: every assertion in this file stays green
 * if they do, while a denied call starts burning a pooled connection plus a
 * BEGIN/ROLLBACK, and a denial during a database outage starts surfacing as a
 * connection error (a 500) instead of a PermissionError (a 403).
 *
 * Proven the only way the outcome distinguishes the two: point a FRESH module
 * graph's pool at an unreachable port. If the guard still runs first, the pool is
 * never touched and the error is a PermissionError; if the transaction is opened
 * first, the connection refusal wins and an AggregateError comes back instead.
 */
describe('changeDeviceStatus — guards run before the connection', () => {
  it('authorizes and validates before it ever acquires a connection', async () => {
    const previous = process.env.DATABASE_URL
    vi.resetModules()
    process.env.DATABASE_URL = 'postgresql://nobody:nobody@127.0.0.1:1/unreachable'
    try {
      // A fresh graph, so lib/db/pool's singleton is rebuilt against the dead
      // address — and so PermissionError is compared against the class THIS
      // graph throws.
      const svc = await import('@/modules/manufacturing/services/deviceWriteService')
      const authz = await import('@/modules/shared/authz/authorize')

      await expect(svc.changeDeviceStatus(viewer(), {
        deviceId: crypto.randomUUID(), toStatus: 'quality_check', version: 1,
      })).rejects.toThrow(authz.PermissionError)
      // ...and validation, which must also fail before a connection is asked for.
      await expect(svc.changeDeviceStatus(op(), {
        deviceId: 'not-a-uuid', toStatus: 'quality_check', version: 1,
      })).rejects.toThrow(/uuid/i)
    } finally {
      process.env.DATABASE_URL = previous
      vi.resetModules()
    }
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
