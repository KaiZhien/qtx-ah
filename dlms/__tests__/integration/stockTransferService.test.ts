// __tests__/integration/stockTransferService.test.ts
//
// Written following logisticsService.test.ts's idiom (mock @/lib/supabase/server,
// real pg via TEST_DATABASE_URL, runTag-suffixed unique values, afterAll
// cleanup). Per the worktree's parallel-agent constraints this file is NOT run
// here — the dockerized test DB on port 55432 is shared across the agents
// working in parallel, so the controller runs it serially at merge time against
// the applied 20260803130000_platform_logistics_stock.sql migration.
//
// The tests that matter most in this file are, in order:
//   * "receiving twice"          — idempotency of the posting
//   * "deterministic lock order" — deadlock freedom under real concurrency
//   * "insufficient stock"       — the zero floor, with a readable error
//   * "batch vs serialized"      — the one-source-of-truth invariant
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import {
  listStockTransfers, getStockTransfer, createStockTransfer, changeTransferStatus,
  receiveStockTransfer, StockTransferNotFoundError, DuplicateTransferNumberError,
  InsufficientStockError, TrackingModeMismatchError, UnknownReferenceError,
  SerializedUnitNotAtSourceError,
} from '@/modules/logistics/services/stockTransferService'
import {
  listStockLevels, getStockByLocation, getTransferStatusCounts,
} from '@/modules/logistics/services/stockLevelService'
import { updateDeliveryOrder } from '@/modules/logistics/services/deliveryOrderService'
import { InvalidTransferStatusChangeError } from '@/modules/logistics/domain/transferStatus'
import { StockPostingError } from '@/modules/logistics/domain/stockPosting'
import { OptimisticLockError } from '@/lib/db/tx'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client
let userId: string
const runTag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const createdLocationIds: string[] = []
const createdTransferIds: string[] = []
const createdTypeIds: string[] = []
const createdUnitIds: string[] = []
const createdDoIds: string[] = []

const op = (): Actor => ({
  id: userId, roleKey: 'operator',
  permissions: new Set(['view_records', 'create_records', 'edit_records']),
  moduleAccess: new Set(['logistics']), active: true,
})
const viewer = (): Actor => ({
  id: userId, roleKey: 'viewer',
  permissions: new Set(['view_records']), moduleAccess: new Set(['logistics']), active: true,
})
const noModuleAccess = (): Actor => ({
  id: userId, roleKey: 'operator',
  permissions: new Set(['view_records', 'create_records', 'edit_records']),
  moduleAccess: new Set(['manufacturing']), active: true,
})

async function makeLocation(suffix: string): Promise<{ id: string; code: string }> {
  const code = `STK-${runTag}-${suffix}`
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO stock_location (code, name, created_by, updated_by)
     VALUES ($1,$2,$3,$3) RETURNING id`, [code, `Loc ${suffix}`, userId])
  createdLocationIds.push(rows[0].id)
  return { id: rows[0].id, code }
}

/** The seeded component types are all SERIALIZED — batch ones must be made here. */
async function makeComponentType(
  suffix: string, trackingMode: 'batch' | 'serialized',
): Promise<{ id: string; code: string }> {
  const code = `CT-${runTag}-${suffix}`
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO component_type (code, name, tracking_mode, created_by)
     VALUES ($1,$2,$3,$4) RETURNING id`, [code, `Type ${suffix}`, trackingMode, userId])
  createdTypeIds.push(rows[0].id)
  return { id: rows[0].id, code }
}

async function makeUnit(typeId: string, suffix: string, locationId: string | null = null) {
  const serial = `SN-${runTag}-${suffix}`
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO component_unit (component_type_id, serial_no, location_id, created_by, updated_by)
     VALUES ($1,$2,$3,$4,$4) RETURNING id`, [typeId, serial, locationId, userId])
  createdUnitIds.push(rows[0].id)
  return { id: rows[0].id, serial }
}

/** Seed a balance directly, bypassing the service — arranging, not asserting. */
async function setStock(locationId: string, typeId: string, qty: string) {
  await db.query(
    `INSERT INTO stock_level (location_id, component_type_id, qty, created_by, updated_by)
     VALUES ($1,$2,$3::numeric,$4,$4)
     ON CONFLICT (location_id, component_type_id) DO UPDATE SET qty = EXCLUDED.qty`,
    [locationId, typeId, qty, userId])
}

async function qtyAt(locationId: string, typeId: string): Promise<string | null> {
  const { rows } = await db.query<{ qty: string }>(
    `SELECT qty::text AS qty FROM stock_level WHERE location_id=$1 AND component_type_id=$2`,
    [locationId, typeId])
  return rows[0]?.qty ?? null
}

async function makeTransfer(input: {
  suffix: string; from: string; to: string
  batchLines?: { componentTypeId: string; qty: number }[]
  serializedLines?: { componentUnitId: string }[]
}): Promise<{ id: string; version: number }> {
  const res = await createStockTransfer(op(), {
    transferNo: `ST-${runTag}-${input.suffix}`,
    fromLocationId: input.from, toLocationId: input.to,
    batchLines: input.batchLines ?? [], serializedLines: input.serializedLines ?? [],
  })
  createdTransferIds.push(res.id)
  const { rows } = await db.query<{ version: number }>(
    `SELECT version FROM stock_transfer WHERE id=$1`, [res.id])
  return { id: res.id, version: rows[0].version }
}

/** draft -> dispatched, returning the bumped version. */
async function dispatch(id: string, version: number): Promise<number> {
  const res = await changeTransferStatus(op(), { stockTransferId: id, toStatus: 'dispatched', version })
  return res.version
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  userId = (await db.query(`SELECT id FROM app_user WHERE email='reetmitra8@gmail.com'`)).rows[0].id
})

afterAll(async () => {
  if (createdTransferIds.length) {
    await db.query(`DELETE FROM stock_transfer_line WHERE stock_transfer_id = ANY($1)`, [createdTransferIds])
    await db.query(`DELETE FROM stock_transfer WHERE id = ANY($1)`, [createdTransferIds])
  }
  if (createdDoIds.length) {
    await db.query(`DELETE FROM delivery_order_line WHERE delivery_order_id = ANY($1)`, [createdDoIds])
    await db.query(`DELETE FROM delivery_order WHERE id = ANY($1)`, [createdDoIds])
  }
  if (createdLocationIds.length) {
    await db.query(`DELETE FROM stock_level WHERE location_id = ANY($1)`, [createdLocationIds])
  }
  if (createdUnitIds.length) {
    await db.query(`DELETE FROM component_unit WHERE id = ANY($1)`, [createdUnitIds])
  }
  if (createdTypeIds.length) {
    await db.query(`DELETE FROM stock_level WHERE component_type_id = ANY($1)`, [createdTypeIds])
    await db.query(`DELETE FROM component_type WHERE id = ANY($1)`, [createdTypeIds])
  }
  if (createdLocationIds.length) {
    await db.query(`DELETE FROM stock_location WHERE id = ANY($1)`, [createdLocationIds])
  }
  await db.end()
  await getPool().end()
})

// ───────────────────────────────────────────────────────────────────────────
describe('schema', () => {
  it('rejects a negative balance at the CHECK constraint (the backstop)', async () => {
    const loc = await makeLocation('neg')
    const type = await makeComponentType('neg', 'batch')
    await setStock(loc.id, type.id, '1')
    await expect(db.query(
      `UPDATE stock_level SET qty = -1 WHERE location_id=$1 AND component_type_id=$2`,
      [loc.id, type.id])).rejects.toThrow(/stock_level_qty_check|violates check constraint/)
  })

  it('refuses a stock_level row for a SERIALIZED component type', async () => {
    // The one-source-of-truth invariant, enforced structurally: a serialized
    // unit's location is component_unit.location_id and nowhere else.
    const loc = await makeLocation('ser-level')
    const serialized = await makeComponentType('ser-level', 'serialized')
    await expect(db.query(
      `INSERT INTO stock_level (location_id, component_type_id, qty, created_by, updated_by)
       VALUES ($1,$2,1,$3,$3)`, [loc.id, serialized.id, userId]))
      .rejects.toThrow(/only accounts for batch-tracked/)
  })

  it('enforces the either/or line constraint: never both, never neither', async () => {
    const a = await makeLocation('eo-a')
    const b = await makeLocation('eo-b')
    const type = await makeComponentType('eo', 'batch')
    const serType = await makeComponentType('eo-s', 'serialized')
    const unit = await makeUnit(serType.id, 'eo')
    const t = await makeTransfer({ suffix: 'eo', from: a.id, to: b.id,
      batchLines: [{ componentTypeId: type.id, qty: 1 }] })

    // both populated
    await expect(db.query(
      `INSERT INTO stock_transfer_line
         (stock_transfer_id, line_no, component_type_id, qty, component_unit_id, created_by)
       VALUES ($1, 90, $2, 1, $3, $4)`, [t.id, type.id, unit.id, userId]))
      .rejects.toThrow(/stock_transfer_line_batch_or_unit/)

    // neither populated
    await expect(db.query(
      `INSERT INTO stock_transfer_line (stock_transfer_id, line_no, created_by)
       VALUES ($1, 91, $2)`, [t.id, userId]))
      .rejects.toThrow(/stock_transfer_line_batch_or_unit/)
  })

  it('rejects a transfer whose source and destination are the same location', async () => {
    const a = await makeLocation('same')
    await expect(db.query(
      `INSERT INTO stock_transfer (transfer_no, from_location_id, to_location_id, initiated_by, created_by, updated_by)
       VALUES ($1,$2,$2,$3,$3,$3)`, [`ST-same-${runTag}`, a.id, userId]))
      .rejects.toThrow(/stock_transfer_distinct_locations/)
  })

  it('has RLS enabled and NOT forced on all three new tables', async () => {
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname IN ('stock_level','stock_transfer','stock_transfer_line')`)
    expect(rows).toHaveLength(3)
    for (const r of rows) {
      expect(r.relrowsecurity).toBe(true)
      expect(r.relforcerowsecurity).toBe(false)
    }
  })

  it('grants no anon/authenticated policy (deny-via-REST)', async () => {
    const { rows } = await db.query(
      `SELECT policyname FROM pg_policies
        WHERE tablename IN ('stock_level','stock_transfer','stock_transfer_line')`)
    expect(rows).toHaveLength(0)
  })

  it('attaches the audit trigger to the mutable tables', async () => {
    const { rows } = await db.query<{ tgrelid: string }>(
      `SELECT c.relname AS tgrelid FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
        WHERE NOT t.tgisinternal AND t.tgname LIKE '%audit%'
          AND c.relname IN ('stock_level','stock_transfer')`)
    expect(new Set(rows.map((r) => r.tgrelid))).toEqual(new Set(['stock_level', 'stock_transfer']))
  })

  it('closes the carried finding: delivery_order_line (do_id, line_no) is UNIQUE', async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO delivery_order (do_no, created_by, updated_by)
       VALUES ($1,$2,$2) RETURNING id`, [`DO-line-${runTag}`, userId])
    createdDoIds.push(rows[0].id)
    await db.query(
      `INSERT INTO delivery_order_line (delivery_order_id, line_no, quantity, created_by)
       VALUES ($1,1,1,$2)`, [rows[0].id, userId])
    await expect(db.query(
      `INSERT INTO delivery_order_line (delivery_order_id, line_no, quantity, created_by)
       VALUES ($1,1,1,$2)`, [rows[0].id, userId]))
      .rejects.toThrow(/delivery_order_line_no_unique/)
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('createStockTransfer — batch vs serialized (one source of truth)', () => {
  it('refuses a viewer (no create_records)', async () => {
    const a = await makeLocation('perm-a')
    const b = await makeLocation('perm-b')
    const type = await makeComponentType('perm', 'batch')
    await expect(createStockTransfer(viewer(), {
      transferNo: `ST-perm-${runTag}`, fromLocationId: a.id, toLocationId: b.id,
      batchLines: [{ componentTypeId: type.id, qty: 1 }],
    })).rejects.toThrow(PermissionError)
  })

  it('refuses an actor without logistics module access', async () => {
    const a = await makeLocation('perm2-a')
    const b = await makeLocation('perm2-b')
    const type = await makeComponentType('perm2', 'batch')
    await expect(createStockTransfer(noModuleAccess(), {
      transferNo: `ST-perm2-${runTag}`, fromLocationId: a.id, toLocationId: b.id,
      batchLines: [{ componentTypeId: type.id, qty: 1 }],
    })).rejects.toThrow(PermissionError)
  })

  it('rejects a SERIALIZED component type used as a batch (quantity) line', async () => {
    const a = await makeLocation('mm-a')
    const b = await makeLocation('mm-b')
    const serialized = await makeComponentType('mm-ser', 'serialized')
    await expect(createStockTransfer(op(), {
      transferNo: `ST-mm-${runTag}`, fromLocationId: a.id, toLocationId: b.id,
      batchLines: [{ componentTypeId: serialized.id, qty: 3 }],
    })).rejects.toThrow(TrackingModeMismatchError)
  })

  it('rejects a BATCH component unit used as a serialized line', async () => {
    const a = await makeLocation('mm2-a')
    const b = await makeLocation('mm2-b')
    const batch = await makeComponentType('mm2-batch', 'batch')
    // A unit row for a batch type is itself odd, but nothing stops one existing
    // — the transfer path must still refuse to move it as a serialized line.
    const unit = await makeUnit(batch.id, 'mm2')
    await expect(createStockTransfer(op(), {
      transferNo: `ST-mm2-${runTag}`, fromLocationId: a.id, toLocationId: b.id,
      serializedLines: [{ componentUnitId: unit.id }],
    })).rejects.toThrow(TrackingModeMismatchError)
  })

  it('rejects an unknown component type', async () => {
    const a = await makeLocation('unk-a')
    const b = await makeLocation('unk-b')
    await expect(createStockTransfer(op(), {
      transferNo: `ST-unk-${runTag}`, fromLocationId: a.id, toLocationId: b.id,
      batchLines: [{ componentTypeId: '00000000-0000-0000-0000-000000000000', qty: 1 }],
    })).rejects.toThrow(UnknownReferenceError)
  })

  it('rejects a same-location transfer before taking a connection', async () => {
    const a = await makeLocation('self')
    const type = await makeComponentType('self', 'batch')
    await expect(createStockTransfer(op(), {
      transferNo: `ST-self-${runTag}`, fromLocationId: a.id, toLocationId: a.id,
      batchLines: [{ componentTypeId: type.id, qty: 1 }],
    })).rejects.toThrow(StockPostingError)
  })

  it('rejects a transfer with no lines', async () => {
    const a = await makeLocation('empty-a')
    const b = await makeLocation('empty-b')
    await expect(createStockTransfer(op(), {
      transferNo: `ST-empty-${runTag}`, fromLocationId: a.id, toLocationId: b.id,
    })).rejects.toThrow(StockPostingError)
  })

  it('rejects a duplicate transfer number', async () => {
    const a = await makeLocation('dup-a')
    const b = await makeLocation('dup-b')
    const type = await makeComponentType('dup', 'batch')
    const first = await makeTransfer({ suffix: 'dup', from: a.id, to: b.id,
      batchLines: [{ componentTypeId: type.id, qty: 1 }] })
    expect(first.id).toBeTruthy()
    await expect(createStockTransfer(op(), {
      transferNo: `ST-${runTag}-dup`, fromLocationId: a.id, toLocationId: b.id,
      batchLines: [{ componentTypeId: type.id, qty: 1 }],
    })).rejects.toThrow(DuplicateTransferNumberError)
  })

  it('writes header + lines atomically and numbers the lines from 1', async () => {
    const a = await makeLocation('mix-a')
    const b = await makeLocation('mix-b')
    const batch = await makeComponentType('mix-b', 'batch')
    const ser = await makeComponentType('mix-s', 'serialized')
    const unit = await makeUnit(ser.id, 'mix')
    const t = await makeTransfer({ suffix: 'mix', from: a.id, to: b.id,
      batchLines: [{ componentTypeId: batch.id, qty: 2.5 }],
      serializedLines: [{ componentUnitId: unit.id }] })

    const detail = await getStockTransfer(op(), t.id)
    expect(detail?.status).toBe('draft')
    expect(detail?.lines.map((l) => l.lineNo)).toEqual([1, 2])
    expect(detail?.lines[0]).toMatchObject({ kind: 'batch', qty: 2.5, componentTypeId: batch.id })
    expect(detail?.lines[1]).toMatchObject({ kind: 'serialized', componentUnitId: unit.id })
    // A serialized line has no component_type_id of its own; the detail read
    // resolves the label through the unit so the UI can render lines uniformly.
    expect(detail?.lines[1].componentTypeCode).toBe(ser.code)
  })

  it('returns null from getStockTransfer for an unknown id', async () => {
    expect(await getStockTransfer(op(), '00000000-0000-0000-0000-000000000000')).toBeNull()
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('receiveStockTransfer — posting', () => {
  it('moves stock from source to destination in one transaction', async () => {
    const a = await makeLocation('post-a')
    const b = await makeLocation('post-b')
    const type = await makeComponentType('post', 'batch')
    await setStock(a.id, type.id, '10')

    const t = await makeTransfer({ suffix: 'post', from: a.id, to: b.id,
      batchLines: [{ componentTypeId: type.id, qty: 4 }] })
    const v = await dispatch(t.id, t.version)
    const res = await receiveStockTransfer(op(), { stockTransferId: t.id, version: v })

    expect(res.status).toBe('received')
    expect(await qtyAt(a.id, type.id)).toBe('6.000')
    expect(await qtyAt(b.id, type.id)).toBe('4.000')
  })

  it('creates the destination balance row when the location held none', async () => {
    const a = await makeLocation('new-a')
    const b = await makeLocation('new-b')
    const type = await makeComponentType('new', 'batch')
    await setStock(a.id, type.id, '3')
    expect(await qtyAt(b.id, type.id)).toBeNull()

    const t = await makeTransfer({ suffix: 'new', from: a.id, to: b.id,
      batchLines: [{ componentTypeId: type.id, qty: 3 }] })
    await receiveStockTransfer(op(), { stockTransferId: t.id, version: await dispatch(t.id, t.version) })

    expect(await qtyAt(a.id, type.id)).toBe('0.000')
    expect(await qtyAt(b.id, type.id)).toBe('3.000')
  })

  it('aggregates repeated lines of the same type into one movement', async () => {
    const a = await makeLocation('agg-a')
    const b = await makeLocation('agg-b')
    const type = await makeComponentType('agg', 'batch')
    await setStock(a.id, type.id, '10')

    const t = await makeTransfer({ suffix: 'agg', from: a.id, to: b.id,
      batchLines: [{ componentTypeId: type.id, qty: 3 }, { componentTypeId: type.id, qty: 4 }] })
    await receiveStockTransfer(op(), { stockTransferId: t.id, version: await dispatch(t.id, t.version) })

    expect(await qtyAt(a.id, type.id)).toBe('3.000')
    expect(await qtyAt(b.id, type.id)).toBe('7.000')
  })

  it('keeps fractional quantities exact (no floating-point drift)', async () => {
    const a = await makeLocation('frac-a')
    const b = await makeLocation('frac-b')
    const type = await makeComponentType('frac', 'batch')
    await setStock(a.id, type.id, '1')

    const t = await makeTransfer({ suffix: 'frac', from: a.id, to: b.id,
      batchLines: [{ componentTypeId: type.id, qty: 0.1 }, { componentTypeId: type.id, qty: 0.2 }] })
    await receiveStockTransfer(op(), { stockTransferId: t.id, version: await dispatch(t.id, t.version) })

    // 0.1 + 0.2 as JS floats is 0.30000000000000004; scaled-integer aggregation
    // makes this exactly 0.300, so the source lands on exactly 0.700.
    expect(await qtyAt(b.id, type.id)).toBe('0.300')
    expect(await qtyAt(a.id, type.id)).toBe('0.700')
  })

  it('refuses a viewer (no edit_records)', async () => {
    const a = await makeLocation('rperm-a')
    const b = await makeLocation('rperm-b')
    const type = await makeComponentType('rperm', 'batch')
    await setStock(a.id, type.id, '5')
    const t = await makeTransfer({ suffix: 'rperm', from: a.id, to: b.id,
      batchLines: [{ componentTypeId: type.id, qty: 1 }] })
    const v = await dispatch(t.id, t.version)
    await expect(receiveStockTransfer(viewer(), { stockTransferId: t.id, version: v }))
      .rejects.toThrow(PermissionError)
  })

  it('throws StockTransferNotFoundError for an unknown transfer', async () => {
    await expect(receiveStockTransfer(op(), {
      stockTransferId: '00000000-0000-0000-0000-000000000000', version: 1,
    })).rejects.toThrow(StockTransferNotFoundError)
  })

  it('refuses to receive a transfer still in draft (fail-closed lifecycle)', async () => {
    const a = await makeLocation('draft-a')
    const b = await makeLocation('draft-b')
    const type = await makeComponentType('draft', 'batch')
    await setStock(a.id, type.id, '5')
    const t = await makeTransfer({ suffix: 'draft', from: a.id, to: b.id,
      batchLines: [{ componentTypeId: type.id, qty: 1 }] })
    await expect(receiveStockTransfer(op(), { stockTransferId: t.id, version: t.version }))
      .rejects.toThrow(InvalidTransferStatusChangeError)
    expect(await qtyAt(a.id, type.id)).toBe('5.000')
  })

  it('rejects a stale version with OptimisticLockError and posts nothing', async () => {
    const a = await makeLocation('ver-a')
    const b = await makeLocation('ver-b')
    const type = await makeComponentType('ver', 'batch')
    await setStock(a.id, type.id, '5')
    const t = await makeTransfer({ suffix: 'ver', from: a.id, to: b.id,
      batchLines: [{ componentTypeId: type.id, qty: 1 }] })
    const v = await dispatch(t.id, t.version)
    await expect(receiveStockTransfer(op(), { stockTransferId: t.id, version: v - 1 }))
      .rejects.toThrow(OptimisticLockError)
    expect(await qtyAt(a.id, type.id)).toBe('5.000')
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('receiveStockTransfer — IDEMPOTENCY', () => {
  it('receiving twice does not double-post', async () => {
    const a = await makeLocation('idem-a')
    const b = await makeLocation('idem-b')
    const type = await makeComponentType('idem', 'batch')
    await setStock(a.id, type.id, '10')

    const t = await makeTransfer({ suffix: 'idem', from: a.id, to: b.id,
      batchLines: [{ componentTypeId: type.id, qty: 4 }] })
    const v = await dispatch(t.id, t.version)
    const first = await receiveStockTransfer(op(), { stockTransferId: t.id, version: v })

    // Second receive, with the version the first one produced — so the version
    // check CANNOT be what stops it. Only the status guard can.
    await expect(receiveStockTransfer(op(), { stockTransferId: t.id, version: first.version }))
      .rejects.toThrow(InvalidTransferStatusChangeError)

    expect(await qtyAt(a.id, type.id)).toBe('6.000')
    expect(await qtyAt(b.id, type.id)).toBe('4.000')
  })

  it('two CONCURRENT receives of the same transfer post exactly once', async () => {
    // The double-click case. Both calls race into withTransaction; the loser
    // blocks on the header's FOR UPDATE, then re-reads status='received' and
    // fails closed. Exactly one succeeds and the balance moved once.
    const a = await makeLocation('race-a')
    const b = await makeLocation('race-b')
    const type = await makeComponentType('race', 'batch')
    await setStock(a.id, type.id, '10')

    const t = await makeTransfer({ suffix: 'race', from: a.id, to: b.id,
      batchLines: [{ componentTypeId: type.id, qty: 4 }] })
    const v = await dispatch(t.id, t.version)

    const results = await Promise.allSettled([
      receiveStockTransfer(op(), { stockTransferId: t.id, version: v }),
      receiveStockTransfer(op(), { stockTransferId: t.id, version: v }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    expect(results.filter((r) => r.status === 'rejected')).toHaveLength(1)

    expect(await qtyAt(a.id, type.id)).toBe('6.000')
    expect(await qtyAt(b.id, type.id)).toBe('4.000')
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('receiveStockTransfer — the zero floor', () => {
  it('raises InsufficientStockError naming the component and location', async () => {
    const a = await makeLocation('short-a')
    const b = await makeLocation('short-b')
    const type = await makeComponentType('short', 'batch')
    await setStock(a.id, type.id, '2')

    const t = await makeTransfer({ suffix: 'short', from: a.id, to: b.id,
      batchLines: [{ componentTypeId: type.id, qty: 5 }] })
    const v = await dispatch(t.id, t.version)

    const err = await receiveStockTransfer(op(), { stockTransferId: t.id, version: v })
      .catch((e) => e)
    expect(err).toBeInstanceOf(InsufficientStockError)
    // The clerk must be told WHICH component ran out WHERE — not a raw 23514.
    expect(err.message).toContain(type.code)
    expect(err.message).toContain(a.code)
    expect(err.message).not.toMatch(/check constraint|23514/)
  })

  it('rolls the WHOLE posting back — no partial movement, transfer stays dispatched', async () => {
    const a = await makeLocation('roll-a')
    const b = await makeLocation('roll-b')
    const plenty = await makeComponentType('roll-ok', 'batch')
    const scarce = await makeComponentType('roll-no', 'batch')
    await setStock(a.id, plenty.id, '10')
    await setStock(a.id, scarce.id, '1')

    const t = await makeTransfer({ suffix: 'roll', from: a.id, to: b.id,
      batchLines: [{ componentTypeId: plenty.id, qty: 5 }, { componentTypeId: scarce.id, qty: 9 }] })
    const v = await dispatch(t.id, t.version)

    await expect(receiveStockTransfer(op(), { stockTransferId: t.id, version: v }))
      .rejects.toThrow(InsufficientStockError)

    // The plentiful component must NOT have moved even though its own
    // decrement would have succeeded on its own.
    expect(await qtyAt(a.id, plenty.id)).toBe('10.000')
    expect(await qtyAt(b.id, plenty.id)).toBeNull()
    expect(await qtyAt(a.id, scarce.id)).toBe('1.000')

    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM stock_transfer WHERE id=$1`, [t.id])
    expect(rows[0].status).toBe('dispatched')
  })

  it('allows a transfer that empties the source exactly to zero', async () => {
    const a = await makeLocation('exact-a')
    const b = await makeLocation('exact-b')
    const type = await makeComponentType('exact', 'batch')
    await setStock(a.id, type.id, '7.5')
    const t = await makeTransfer({ suffix: 'exact', from: a.id, to: b.id,
      batchLines: [{ componentTypeId: type.id, qty: 7.5 }] })
    await receiveStockTransfer(op(), { stockTransferId: t.id, version: await dispatch(t.id, t.version) })
    expect(await qtyAt(a.id, type.id)).toBe('0.000')
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('receiveStockTransfer — DETERMINISTIC LOCK ORDER (deadlock freedom)', () => {
  it('two opposite-direction transfers on the same pair of locations both succeed', async () => {
    // THE test this whole track hangs on. Transfer 1 moves X from A to B while
    // transfer 2 moves X from B to A, concurrently. Under the naive
    // "lock the source, then the destination" ordering these two hold what the
    // other needs and Postgres aborts one with a 40P01 deadlock. Because
    // planStockPosting sorts lock keys globally, BOTH transactions take (A,X)
    // before (B,X) and the loser simply waits.
    //
    // If this test starts failing with "deadlock detected", someone replaced
    // the sort in stockPosting.ts with source-then-destination.
    const a = await makeLocation('dead-a')
    const b = await makeLocation('dead-b')
    const type = await makeComponentType('dead', 'batch')
    await setStock(a.id, type.id, '100')
    await setStock(b.id, type.id, '100')

    const t1 = await makeTransfer({ suffix: 'dead-1', from: a.id, to: b.id,
      batchLines: [{ componentTypeId: type.id, qty: 10 }] })
    const t2 = await makeTransfer({ suffix: 'dead-2', from: b.id, to: a.id,
      batchLines: [{ componentTypeId: type.id, qty: 4 }] })
    const v1 = await dispatch(t1.id, t1.version)
    const v2 = await dispatch(t2.id, t2.version)

    const results = await Promise.allSettled([
      receiveStockTransfer(op(), { stockTransferId: t1.id, version: v1 }),
      receiveStockTransfer(op(), { stockTransferId: t2.id, version: v2 }),
    ])
    const failures = results.filter((r) => r.status === 'rejected')
    expect(failures.map((f) => String((f as PromiseRejectedResult).reason))).toEqual([])

    // Net: A loses 10 and gains 4; B gains 10 and loses 4.
    expect(await qtyAt(a.id, type.id)).toBe('94.000')
    expect(await qtyAt(b.id, type.id)).toBe('106.000')
  })

  it('survives a pre-held lock that forces both transfers to queue', async () => {
    // Deterministic version of the test above. A third connection holds the
    // (A,X) row — the FIRST key in the global order for BOTH transfers — so
    // neither can start posting. Under the naive ordering the B->A transfer
    // would instead sail past (A,X), grab (B,X), and be holding it when the
    // A->B transfer wakes up needing it: guaranteed deadlock. Under the sorted
    // ordering both simply queue behind (A,X) and run one after the other.
    const a = await makeLocation('gate-a')
    const b = await makeLocation('gate-b')
    const type = await makeComponentType('gate', 'batch')
    await setStock(a.id, type.id, '50')
    await setStock(b.id, type.id, '50')

    const t1 = await makeTransfer({ suffix: 'gate-1', from: a.id, to: b.id,
      batchLines: [{ componentTypeId: type.id, qty: 5 }] })
    const t2 = await makeTransfer({ suffix: 'gate-2', from: b.id, to: a.id,
      batchLines: [{ componentTypeId: type.id, qty: 2 }] })
    const v1 = await dispatch(t1.id, t1.version)
    const v2 = await dispatch(t2.id, t2.version)

    // Whichever of the two location ids sorts first is the gate row.
    const firstLocationId = [a.id, b.id].sort()[0]

    const gate = new Client({ connectionString: process.env.TEST_DATABASE_URL })
    await gate.connect()
    let released = false
    try {
      await gate.query('BEGIN')
      await gate.query(
        `SELECT id FROM stock_level WHERE location_id=$1 AND component_type_id=$2 FOR UPDATE`,
        [firstLocationId, type.id])

      const running = Promise.allSettled([
        receiveStockTransfer(op(), { stockTransferId: t1.id, version: v1 }),
        receiveStockTransfer(op(), { stockTransferId: t2.id, version: v2 }),
      ])
      // Give both receives time to reach the gate row and block on it.
      await new Promise((r) => setTimeout(r, 400))
      await gate.query('COMMIT')
      released = true

      const results = await running
      expect(results.filter((r) => r.status === 'rejected')
        .map((f) => String((f as PromiseRejectedResult).reason))).toEqual([])
    } finally {
      if (!released) await gate.query('ROLLBACK').catch(() => {})
      await gate.end()
    }

    expect(await qtyAt(a.id, type.id)).toBe('47.000')
    expect(await qtyAt(b.id, type.id)).toBe('53.000')
  }, 30_000)

  it('four concurrent transfers criss-crossing three locations all settle correctly', async () => {
    const a = await makeLocation('mesh-a')
    const b = await makeLocation('mesh-b')
    const c = await makeLocation('mesh-c')
    const x = await makeComponentType('mesh-x', 'batch')
    const y = await makeComponentType('mesh-y', 'batch')
    for (const loc of [a, b, c]) {
      await setStock(loc.id, x.id, '100')
      await setStock(loc.id, y.id, '100')
    }

    const specs = [
      { suffix: 'mesh-1', from: a.id, to: b.id, type: x.id, qty: 5 },
      { suffix: 'mesh-2', from: b.id, to: a.id, type: x.id, qty: 3 },
      { suffix: 'mesh-3', from: b.id, to: c.id, type: y.id, qty: 7 },
      { suffix: 'mesh-4', from: c.id, to: b.id, type: x.id, qty: 2 },
    ]
    const prepared = []
    for (const s of specs) {
      const t = await makeTransfer({ suffix: s.suffix, from: s.from, to: s.to,
        batchLines: [{ componentTypeId: s.type, qty: s.qty }] })
      prepared.push({ id: t.id, version: await dispatch(t.id, t.version) })
    }

    const results = await Promise.allSettled(prepared.map((p) =>
      receiveStockTransfer(op(), { stockTransferId: p.id, version: p.version })))
    expect(results.filter((r) => r.status === 'rejected')
      .map((f) => String((f as PromiseRejectedResult).reason))).toEqual([])

    expect(await qtyAt(a.id, x.id)).toBe('98.000')   // -5 +3
    expect(await qtyAt(b.id, x.id)).toBe('104.000')  // +5 -3 +2
    expect(await qtyAt(c.id, x.id)).toBe('98.000')   // -2
    expect(await qtyAt(b.id, y.id)).toBe('93.000')   // -7
    expect(await qtyAt(c.id, y.id)).toBe('107.000')  // +7
  }, 30_000)
})

// ───────────────────────────────────────────────────────────────────────────
describe('receiveStockTransfer — serialized units', () => {
  it('moves component_unit.location_id and writes NO stock_level row', async () => {
    const a = await makeLocation('ser-a')
    const b = await makeLocation('ser-b')
    const type = await makeComponentType('ser', 'serialized')
    const unit = await makeUnit(type.id, 'ser', a.id)

    const t = await makeTransfer({ suffix: 'ser', from: a.id, to: b.id,
      serializedLines: [{ componentUnitId: unit.id }] })
    await receiveStockTransfer(op(), { stockTransferId: t.id, version: await dispatch(t.id, t.version) })

    const { rows } = await db.query<{ location_id: string }>(
      `SELECT location_id FROM component_unit WHERE id=$1`, [unit.id])
    expect(rows[0].location_id).toBe(b.id)
    // The invariant: a serialized unit is never ALSO counted in stock_level.
    expect(await qtyAt(b.id, type.id)).toBeNull()
    expect(await qtyAt(a.id, type.id)).toBeNull()
  })

  it('accepts a unit whose location was never recorded (legacy NULL)', async () => {
    const a = await makeLocation('nul-a')
    const b = await makeLocation('nul-b')
    const type = await makeComponentType('nul', 'serialized')
    const unit = await makeUnit(type.id, 'nul', null)

    const t = await makeTransfer({ suffix: 'nul', from: a.id, to: b.id,
      serializedLines: [{ componentUnitId: unit.id }] })
    await receiveStockTransfer(op(), { stockTransferId: t.id, version: await dispatch(t.id, t.version) })

    const { rows } = await db.query<{ location_id: string }>(
      `SELECT location_id FROM component_unit WHERE id=$1`, [unit.id])
    expect(rows[0].location_id).toBe(b.id)
  })

  it('refuses a unit that has since been moved somewhere else', async () => {
    const a = await makeLocation('moved-a')
    const b = await makeLocation('moved-b')
    const elsewhere = await makeLocation('moved-c')
    const type = await makeComponentType('moved', 'serialized')
    const unit = await makeUnit(type.id, 'moved', a.id)

    const t = await makeTransfer({ suffix: 'moved', from: a.id, to: b.id,
      serializedLines: [{ componentUnitId: unit.id }] })
    const v = await dispatch(t.id, t.version)
    await db.query(`UPDATE component_unit SET location_id=$1 WHERE id=$2`, [elsewhere.id, unit.id])

    await expect(receiveStockTransfer(op(), { stockTransferId: t.id, version: v }))
      .rejects.toThrow(SerializedUnitNotAtSourceError)

    // Rolled back: still at the third location, transfer still dispatched.
    const { rows } = await db.query<{ location_id: string }>(
      `SELECT location_id FROM component_unit WHERE id=$1`, [unit.id])
    expect(rows[0].location_id).toBe(elsewhere.id)
  })

  it('posts a mixed batch + serialized transfer atomically', async () => {
    const a = await makeLocation('both-a')
    const b = await makeLocation('both-b')
    const batch = await makeComponentType('both-b', 'batch')
    const ser = await makeComponentType('both-s', 'serialized')
    const unit = await makeUnit(ser.id, 'both', a.id)
    await setStock(a.id, batch.id, '20')

    const t = await makeTransfer({ suffix: 'both', from: a.id, to: b.id,
      batchLines: [{ componentTypeId: batch.id, qty: 6 }],
      serializedLines: [{ componentUnitId: unit.id }] })
    await receiveStockTransfer(op(), { stockTransferId: t.id, version: await dispatch(t.id, t.version) })

    expect(await qtyAt(a.id, batch.id)).toBe('14.000')
    expect(await qtyAt(b.id, batch.id)).toBe('6.000')
    const { rows } = await db.query<{ location_id: string }>(
      `SELECT location_id FROM component_unit WHERE id=$1`, [unit.id])
    expect(rows[0].location_id).toBe(b.id)
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('changeTransferStatus', () => {
  it('stamps dispatched_at on the move to dispatched', async () => {
    const a = await makeLocation('disp-a')
    const b = await makeLocation('disp-b')
    const type = await makeComponentType('disp', 'batch')
    const t = await makeTransfer({ suffix: 'disp', from: a.id, to: b.id,
      batchLines: [{ componentTypeId: type.id, qty: 1 }] })
    await dispatch(t.id, t.version)
    const { rows } = await db.query<{ dispatched_at: Date | null }>(
      `SELECT dispatched_at FROM stock_transfer WHERE id=$1`, [t.id])
    expect(rows[0].dispatched_at).not.toBeNull()
  })

  it('cannot be used to reach `received` — that would skip the posting', async () => {
    const a = await makeLocation('skip-a')
    const b = await makeLocation('skip-b')
    const type = await makeComponentType('skip', 'batch')
    await setStock(a.id, type.id, '5')
    const t = await makeTransfer({ suffix: 'skip', from: a.id, to: b.id,
      batchLines: [{ componentTypeId: type.id, qty: 1 }] })
    const v = await dispatch(t.id, t.version)
    await expect(changeTransferStatus(op(), {
      stockTransferId: t.id, toStatus: 'received' as never, version: v,
    })).rejects.toThrow()
    // Nothing moved, status untouched.
    expect(await qtyAt(a.id, type.id)).toBe('5.000')
    const { rows } = await db.query<{ status: string }>(
      `SELECT status FROM stock_transfer WHERE id=$1`, [t.id])
    expect(rows[0].status).toBe('dispatched')
  })

  it('allows cancelling a dispatched transfer (dispatch posted nothing)', async () => {
    const a = await makeLocation('canc-a')
    const b = await makeLocation('canc-b')
    const type = await makeComponentType('canc', 'batch')
    await setStock(a.id, type.id, '5')
    const t = await makeTransfer({ suffix: 'canc', from: a.id, to: b.id,
      batchLines: [{ componentTypeId: type.id, qty: 1 }] })
    const v = await dispatch(t.id, t.version)
    await changeTransferStatus(op(), { stockTransferId: t.id, toStatus: 'cancelled', version: v })
    expect(await qtyAt(a.id, type.id)).toBe('5.000')
  })

  it('refuses to receive a cancelled transfer', async () => {
    const a = await makeLocation('cr-a')
    const b = await makeLocation('cr-b')
    const type = await makeComponentType('cr', 'batch')
    await setStock(a.id, type.id, '5')
    const t = await makeTransfer({ suffix: 'cr', from: a.id, to: b.id,
      batchLines: [{ componentTypeId: type.id, qty: 1 }] })
    const res = await changeTransferStatus(op(), {
      stockTransferId: t.id, toStatus: 'cancelled', version: t.version })
    await expect(receiveStockTransfer(op(), { stockTransferId: t.id, version: res.version }))
      .rejects.toThrow(InvalidTransferStatusChangeError)
    expect(await qtyAt(a.id, type.id)).toBe('5.000')
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('stockLevelService reads', () => {
  it('lists levels with location and component labels, hiding zeros by default', async () => {
    const a = await makeLocation('read-a')
    const b = await makeLocation('read-b')
    const type = await makeComponentType('read', 'batch')
    await setStock(a.id, type.id, '12')
    await setStock(b.id, type.id, '0')

    const rows = await listStockLevels(op(), { componentTypeId: type.id })
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      locationId: a.id, locationCode: a.code, componentTypeCode: type.code, qty: 12,
    })

    const withZero = await listStockLevels(op(), { componentTypeId: type.id, includeZero: true })
    expect(withZero).toHaveLength(2)
  })

  it('narrows by location', async () => {
    const a = await makeLocation('nar-a')
    const t1 = await makeComponentType('nar-1', 'batch')
    const t2 = await makeComponentType('nar-2', 'batch')
    await setStock(a.id, t1.id, '1')
    await setStock(a.id, t2.id, '2')
    const rows = await listStockLevels(op(), { locationId: a.id })
    expect(rows.map((r) => r.componentTypeId).sort()).toEqual([t1.id, t2.id].sort())
  })

  it('refuses a caller without view_records', async () => {
    await expect(listStockLevels({ ...viewer(), permissions: new Set() }))
      .rejects.toThrow(PermissionError)
    await expect(getStockByLocation({ ...viewer(), permissions: new Set() }))
      .rejects.toThrow(PermissionError)
  })

  it('rolls up distinct component types and total qty per location', async () => {
    const loc = await makeLocation('roll-up')
    const t1 = await makeComponentType('ru-1', 'batch')
    const t2 = await makeComponentType('ru-2', 'batch')
    await setStock(loc.id, t1.id, '3')
    await setStock(loc.id, t2.id, '4.5')

    const rows = await getStockByLocation(op())
    const mine = rows.find((r) => r.locationId === loc.id)
    expect(mine).toMatchObject({ componentTypeCount: 2, totalQty: 7.5, locationCode: loc.code })
  })

  it('reports a count for every transfer status, including zeros', async () => {
    const counts = await getTransferStatusCounts(op())
    expect(counts.map((c) => c.status)).toEqual(['draft', 'dispatched', 'received', 'cancelled'])
    for (const c of counts) expect(c.count).toBeGreaterThanOrEqual(0)
  })
})

describe('listStockTransfers', () => {
  it('finds a transfer by either endpoint location', async () => {
    const a = await makeLocation('list-a')
    const b = await makeLocation('list-b')
    const type = await makeComponentType('list', 'batch')
    const t = await makeTransfer({ suffix: 'list', from: a.id, to: b.id,
      batchLines: [{ componentTypeId: type.id, qty: 1 }] })

    for (const locationId of [a.id, b.id]) {
      const { items } = await listStockTransfers(op(), { locationId })
      expect(items.map((i) => i.id)).toContain(t.id)
    }
  })

  it('filters by status and reports the line count', async () => {
    const a = await makeLocation('lst-a')
    const b = await makeLocation('lst-b')
    const type = await makeComponentType('lst', 'batch')
    const t = await makeTransfer({ suffix: 'lst', from: a.id, to: b.id,
      batchLines: [{ componentTypeId: type.id, qty: 1 }, { componentTypeId: type.id, qty: 2 }] })

    const { items } = await listStockTransfers(op(), { status: ['draft'], locationId: a.id })
    const mine = items.find((i) => i.id === t.id)
    expect(mine).toMatchObject({ lineCount: 2, fromLocationName: `Loc lst-a` })
  })

  it('refuses a caller without view_records', async () => {
    await expect(listStockTransfers({ ...viewer(), permissions: new Set() }))
      .rejects.toThrow(PermissionError)
  })
})

// ───────────────────────────────────────────────────────────────────────────
describe('carried finding: podReceivedAt validation', () => {
  it('rejects a non-datetime string instead of letting Postgres raise 22007', async () => {
    const { rows } = await db.query<{ id: string; version: number }>(
      `INSERT INTO delivery_order (do_no, created_by, updated_by)
       VALUES ($1,$2,$2) RETURNING id, version`, [`DO-pod-${runTag}`, userId])
    createdDoIds.push(rows[0].id)
    await expect(updateDeliveryOrder(op(), {
      deliveryOrderId: rows[0].id, version: rows[0].version, podReceivedAt: 'yesterday',
    })).rejects.toThrow(/ISO 8601/)
  })

  it('still accepts a browser datetime-local value and a full instant', async () => {
    const { rows } = await db.query<{ id: string; version: number }>(
      `INSERT INTO delivery_order (do_no, created_by, updated_by)
       VALUES ($1,$2,$2) RETURNING id, version`, [`DO-pod2-${runTag}`, userId])
    createdDoIds.push(rows[0].id)
    const after = await updateDeliveryOrder(op(), {
      deliveryOrderId: rows[0].id, version: rows[0].version, podReceivedAt: '2026-08-03T10:30',
    })
    await updateDeliveryOrder(op(), {
      deliveryOrderId: rows[0].id, version: after.version,
      podReceivedAt: '2026-08-03T10:30:00.000Z',
    })
  })
})
