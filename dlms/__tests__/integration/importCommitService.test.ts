import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import ExcelJS from 'exceljs'
import { getPool } from '@/lib/db/pool'
import { stageImportFile } from '@/modules/manufacturing/services/importParseService'
import {
  commitImportBatch, getImportBatch, listImportRows, skipImportRow, cancelImportBatch,
  retryFailedRows,
} from '@/modules/manufacturing/services/importCommitService'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client
let userId: string

const runTag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
let seq = 0
const sn = (p: string) => `${p}-${runTag}-${String(++seq).padStart(4, '0')}`

const mgr = (): Actor => ({
  id: userId, roleKey: 'manager',
  permissions: new Set(['view_records', 'create_records', 'edit_records',
                        'change_device_status', 'import_data']),
  moduleAccess: new Set(['manufacturing']), active: true,
})
const importerNoStatus = (): Actor => ({
  id: userId, roleKey: 'manager',
  permissions: new Set(['view_records', 'create_records', 'edit_records', 'import_data']),
  moduleAccess: new Set(['manufacturing']), active: true,
})
// Seating a terminal status needs delete_records on top of change_device_status.
const importerWithDelete = (): Actor => ({
  id: userId, roleKey: 'manager',
  permissions: new Set(['view_records', 'create_records', 'edit_records',
                        'change_device_status', 'delete_records', 'import_data']),
  moduleAccess: new Set(['manufacturing']), active: true,
})
// Has import_data but not create_records: isolates the second authorize line,
// which the viewer below (missing both) cannot distinguish.
const importerNoCreate = (): Actor => ({
  id: userId, roleKey: 'manager',
  permissions: new Set(['view_records', 'edit_records', 'import_data']),
  moduleAccess: new Set(['manufacturing']), active: true,
})
const viewer = (): Actor => ({
  id: userId, roleKey: 'viewer', permissions: new Set(['view_records']),
  moduleAccess: new Set(['manufacturing']), active: true,
})

const HEADERS = ['PCBA-A S/N', 'PCBA-A HW Rev', 'PCBA-A BOM Rev', 'PCBA-A FW Ver',
                 'PCBA-B S/N', 'Status', 'Phase']

async function stage(rows: string[][], actor: Actor = mgr()) {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Traceability')
  ;[HEADERS, ...rows].forEach((r) => ws.addRow(r))
  const bytes = new Uint8Array(await wb.xlsx.writeBuffer() as ArrayBuffer)
  return stageImportFile(actor, {
    filename: 'batch.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro',
  })
}

/**
 * Block until some backend on this database is waiting on a lock.
 *
 * Used by the in-flight-cancel test to know that the commit pass has actually
 * reached the parked serial, rather than guessing with a sleep. Safe to read
 * globally because the integration config runs test files serially
 * (fileParallelism: false), so the only queries in flight are this file's.
 */
async function waitForLockWait(): Promise<void> {
  for (let i = 0; i < 200; i++) {
    const { rows } = await db.query(
      `SELECT 1 FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`)
    if (rows.length > 0) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error('the commit pass never blocked on the parked serial')
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  userId = (await db.query(
    `SELECT id FROM app_user WHERE email='reetmitra8@gmail.com'`)).rows[0].id
})
afterAll(async () => { await db.end(); await getPool().end() })

describe('commitImportBatch', () => {
  it('refuses an actor without import_data', async () => {
    const { batchId } = await stage([[sn('A'), 'V1', 'B1', '1.0', '', 'in_stock', 'production']])
    await expect(commitImportBatch(viewer(), { batchId })).rejects.toThrow(PermissionError)
  })

  it('refuses an actor who may import but may not create records', async () => {
    const { batchId } = await stage([[sn('A'), 'V1', 'B1', '1.0', '', 'in_stock', 'production']])
    await expect(commitImportBatch(importerNoCreate(), { batchId }))
      .rejects.toThrow(PermissionError)
  })

  it('creates a device, its component units and open installations', async () => {
    const a = sn('A'); const b = sn('B')
    const { batchId } = await stage([[a, 'V1.2', 'B3', '1.0.4', b, 'in_stock', 'production']])
    const res = await commitImportBatch(mgr(), { batchId })
    expect(res).toMatchObject({ committed: 1, failed: 0, remaining: 0 })

    const { rows } = await db.query<{ device_id: string }>(
      `SELECT device_id FROM import_row WHERE batch_id=$1 AND status='committed'`, [batchId])
    expect(rows).toHaveLength(1)
    const deviceId = rows[0].device_id

    const units = await db.query<{ serial_no: string; type_code: string; disposition: string }>(
      `SELECT cu.serial_no, ct.code AS type_code, cu.disposition
         FROM component_installation ci
         JOIN component_unit cu ON cu.id = ci.component_unit_id
         JOIN component_type ct ON ct.id = ci.component_type_id
        WHERE ci.device_id=$1 AND ci.removed_at IS NULL
        ORDER BY ct.sort`, [deviceId])
    expect(units.rows.map((r) => r.type_code)).toEqual(['pcba_a', 'pcba_b'])
    expect(units.rows.map((r) => r.serial_no)).toEqual([a, b])
    expect(units.rows.every((r) => r.disposition === 'installed')).toBe(true)

    const unit = await db.query<{ hw_rev: string; bom_rev: string; fw_ver: string }>(
      `SELECT hw_rev, bom_rev, fw_ver FROM component_unit WHERE serial_no=$1`, [a])
    expect(unit.rows[0]).toEqual({ hw_rev: 'V1.2', bom_rev: 'B3', fw_ver: '1.0.4' })
  })

  it('seats the device at the sheet status and writes its history row', async () => {
    const { batchId } = await stage([[sn('A'), 'V1', 'B1', '1.0', '', 'shipped', 'production']])
    await commitImportBatch(mgr(), { batchId })
    const { rows } = await db.query<{ status: string; device_id: string }>(
      `SELECT d.status, d.id AS device_id FROM device d
         JOIN import_row r ON r.device_id = d.id WHERE r.batch_id=$1`, [batchId])
    expect(rows[0].status).toBe('shipped')
    const hist = await db.query<{ from_status: string | null; to_status: string }>(
      `SELECT from_status, to_status FROM device_status_history WHERE device_id=$1`,
      [rows[0].device_id])
    expect(hist.rows).toEqual([{ from_status: null, to_status: 'shipped' }])
  })

  it('seats the device at the initial status when the sheet has none', async () => {
    const wb = new ExcelJS.Workbook()
    const ws = wb.addWorksheet('Traceability')
    ws.addRow(['PCBA-A S/N', 'PCBA-A HW Rev'])
    ws.addRow([sn('A'), 'V1'])
    const bytes = new Uint8Array(await wb.xlsx.writeBuffer() as ArrayBuffer)
    const { batchId } = await stageImportFile(mgr(), {
      filename: 'nostatus.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro' })
    await commitImportBatch(mgr(), { batchId })
    const { rows } = await db.query<{ status: string }>(
      `SELECT d.status FROM device d JOIN import_row r ON r.device_id=d.id WHERE r.batch_id=$1`,
      [batchId])
    expect(rows[0].status).toBe('in_production')
  })

  it('fails a row whose non-initial status the actor may not set, without writing a device', async () => {
    const a = sn('A')
    const { batchId } = await stage([[a, 'V1', 'B1', '1.0', '', 'shipped', 'production']])
    const res = await commitImportBatch(importerNoStatus(), { batchId })
    expect(res).toMatchObject({ committed: 0, failed: 1 })
    const units = await db.query(`SELECT 1 FROM component_unit WHERE serial_no=$1`, [a])
    expect(units.rows).toHaveLength(0)   // the whole row rolled back
  })

  it('needs delete_records as well as change_device_status to seat a terminal status', async () => {
    // 'retired' is is_terminal in the seeded vocabulary. change_device_status
    // alone is not enough for it — mgr() carries that and nothing else.
    const refusedSn = sn('A')
    const refused = await stage([[refusedSn, 'V1', 'B1', '1.0', '', 'retired', 'production']])
    expect(await commitImportBatch(mgr(), { batchId: refused.batchId }))
      .toMatchObject({ committed: 0, failed: 1, skipped: 0 })
    // Nothing at all was written: the refusal happens inside the row's
    // transaction, so the device and its units roll back with it.
    const refusedRows = await db.query<{ status: string; device_id: string | null }>(
      `SELECT status, device_id FROM import_row WHERE batch_id=$1`, [refused.batchId])
    expect(refusedRows.rows).toEqual([{ status: 'failed', device_id: null }])
    expect((await db.query(
      `SELECT 1 FROM component_unit WHERE serial_no=$1`, [refusedSn])).rows).toHaveLength(0)

    // The identical row, committed by an actor that also holds delete_records.
    // A fresh serial rather than literally the same row: the first attempt left
    // that row resting at 'failed', and only 'valid' rows are picked up.
    const allowed = await stage([[sn('A'), 'V1', 'B1', '1.0', '', 'retired', 'production']])
    expect(await commitImportBatch(importerWithDelete(), { batchId: allowed.batchId }))
      .toMatchObject({ committed: 1, failed: 0, skipped: 0 })
    const { rows } = await db.query<{ status: string; device_id: string }>(
      `SELECT d.status, d.id AS device_id FROM device d
         JOIN import_row r ON r.device_id = d.id WHERE r.batch_id=$1`, [allowed.batchId])
    expect(rows[0].status).toBe('retired')
    const hist = await db.query<{ from_status: string | null; to_status: string }>(
      `SELECT from_status, to_status FROM device_status_history WHERE device_id=$1`,
      [rows[0].device_id])
    expect(hist.rows).toEqual([{ from_status: null, to_status: 'retired' }])
  })

  it('skips a row whose serial already exists in the database', async () => {
    const a = sn('A')
    const first = await stage([[a, 'V1', 'B1', '1.0', '', 'in_stock', 'production']])
    await commitImportBatch(mgr(), { batchId: first.batchId })

    const second = await stage([[a, 'V1', 'B1', '1.0', '', 'in_stock', 'production']])
    const res = await commitImportBatch(mgr(), { batchId: second.batchId })
    expect(res).toMatchObject({ committed: 0, skipped: 1 })
    const { rows } = await db.query<{ errors: string[] }>(
      `SELECT errors FROM import_row WHERE batch_id=$1`, [second.batchId])
    expect(rows[0].errors[0]).toMatch(/already exists/i)
  })

  it('commits a serial that already exists under a different component type', async () => {
    // component_unit_sn is UNIQUE(component_type_id, serial_no), so the same
    // serial under two types is legitimate data. A pre-check matching on the
    // serial alone would skip this second row instead of committing it.
    const shared = sn('S')
    const first = await stage([[shared, 'V1', 'B1', '1.0', '', 'in_stock', 'production']])
    expect(await commitImportBatch(mgr(), { batchId: first.batchId }))
      .toMatchObject({ committed: 1, skipped: 0, failed: 0 })

    // The row carries its own fresh PCBA-A serial so that nothing collides
    // under pcba_a and the only interesting serial is the PCBA-B one.
    const second = await stage([[sn('A'), 'V1', 'B1', '1.0', shared, 'in_stock', 'production']])
    expect(await commitImportBatch(mgr(), { batchId: second.batchId }))
      .toMatchObject({ committed: 1, skipped: 0, failed: 0 })

    const units = await db.query<{ code: string }>(
      `SELECT ct.code FROM component_unit cu
         JOIN component_type ct ON ct.id = cu.component_type_id
        WHERE cu.serial_no=$1 ORDER BY ct.sort`, [shared])
    expect(units.rows.map((r) => r.code)).toEqual(['pcba_a', 'pcba_b'])
  })

  it('is resumable: a limited pass leaves the rest committable', async () => {
    const { batchId } = await stage([
      [sn('A'), 'V1', 'B1', '1.0', '', 'in_stock', 'production'],
      [sn('A'), 'V1', 'B1', '1.0', '', 'in_stock', 'production'],
      [sn('A'), 'V1', 'B1', '1.0', '', 'in_stock', 'production'],
    ])
    const first = await commitImportBatch(mgr(), { batchId, limit: 2 })
    expect(first).toMatchObject({ committed: 2, remaining: 1 })
    expect((await getImportBatch(mgr(), batchId))!.status).toBe('committing')

    const second = await commitImportBatch(mgr(), { batchId })
    expect(second).toMatchObject({ committed: 1, remaining: 0 })
    expect((await getImportBatch(mgr(), batchId))!.status).toBe('committed')
  })

  it('never commits the same row twice', async () => {
    const { batchId } = await stage([[sn('A'), 'V1', 'B1', '1.0', '', 'in_stock', 'production']])
    await commitImportBatch(mgr(), { batchId })
    const again = await commitImportBatch(mgr(), { batchId })
    expect(again).toMatchObject({ committed: 0, remaining: 0 })
    const { rows } = await db.query(
      `SELECT 1 FROM import_row WHERE batch_id=$1 AND status='committed'`, [batchId])
    expect(rows).toHaveLength(1)
  })

  it('commits a row exactly once under overlapping passes, and neither pass reports a failure', async () => {
    const { batchId } = await stage([[sn('A'), 'V1', 'B1', '1.0', '', 'in_stock', 'production']])

    // Two commit passes on the same batch, launched together. Whatever the
    // interleaving, exactly one of them may commit the row and NEITHER may
    // report a failure — nothing about this batch has failed. The loser reaches
    // one of two not-pending routes, both of which count nothing: it either
    // skips the row lock the winner holds (SKIP LOCKED) or acquires the lock
    // after the winner's transaction ends and finds the row no longer 'valid'.
    // The counter assertions are the point of the test: the row's own status was
    // already protected by markRow's status='valid' scope, but the reported
    // counts and the error log were not, so a losing pass claimed a phantom
    // failure and sent a reviewer hunting for a row that does not exist.
    const [a, b] = await Promise.all([
      commitImportBatch(mgr(), { batchId }),
      commitImportBatch(mgr(), { batchId }),
    ])
    expect(a.committed + b.committed).toBe(1)
    expect(a.failed + b.failed).toBe(0)
    expect(a.skipped + b.skipped).toBe(0)

    const { rows } = await db.query<{
      status: string; device_id: string | null
      committed_at: Date | null; errors: string[]
    }>(`SELECT status, device_id, committed_at, errors FROM import_row WHERE batch_id=$1`,
      [batchId])
    expect(rows).toHaveLength(1)
    expect(rows[0].status).toBe('committed')
    expect(rows[0].device_id).not.toBeNull()
    expect(rows[0].committed_at).not.toBeNull()
    expect(rows[0].errors).toEqual([])
  })

  it('does not stamp the batch committed when the pass committed nothing', async () => {
    // Every row invalid or needs_review: no valid rows remain, but nothing was
    // imported either, so 'committed' would be a lie on the review screen — and
    // it used to be a one-way door, because cancelImportBatch only accepted
    // draft/committing.
    const { batchId } = await stage([
      [sn('A'), 'V1', 'B1', '1.0', '', 'Teleported', 'production'],
      ['A-1 and A-2', 'V1', 'B1', '1.0', '', 'in_stock', 'production'],
    ])
    const res = await commitImportBatch(mgr(), { batchId })
    expect(res).toMatchObject({ committed: 0, failed: 0, skipped: 0, remaining: 0 })
    expect((await getImportBatch(mgr(), batchId))!.status).toBe('draft')

    await cancelImportBatch(mgr(), batchId)
    expect((await getImportBatch(mgr(), batchId))!.status).toBe('cancelled')
  })

  it('does not stamp the batch committed when its only row failed for a fixable reason', async () => {
    // A missing permission is fixable, so the batch must not be closed out as
    // 'committed': that both misreports the import and makes import_row's
    // documented retryable 'failed' state unreachable.
    const { batchId } = await stage([[sn('A'), 'V1', 'B1', '1.0', '', 'shipped', 'production']])
    expect(await commitImportBatch(importerNoStatus(), { batchId }))
      .toMatchObject({ committed: 0, failed: 1, remaining: 0 })
    expect((await getImportBatch(mgr(), batchId))!.status).toBe('draft')
    await cancelImportBatch(mgr(), batchId)
    expect((await getImportBatch(mgr(), batchId))!.status).toBe('cancelled')
  })

  it('refuses to cancel a batch that really did commit rows', async () => {
    const { batchId } = await stage([[sn('A'), 'V1', 'B1', '1.0', '', 'in_stock', 'production']])
    expect(await commitImportBatch(mgr(), { batchId })).toMatchObject({ committed: 1 })
    expect((await getImportBatch(mgr(), batchId))!.status).toBe('committed')

    await cancelImportBatch(mgr(), batchId)
    // Still 'committed': cancelling would claim a device that exists in the
    // registry was never imported.
    expect((await getImportBatch(mgr(), batchId))!.status).toBe('committed')
  })

  it('stops committing the rest of a pass when the batch is cancelled in flight', async () => {
    const parked = sn('A')
    const { batchId } = await stage([
      [parked, 'V1', 'B1', '1.0', '', 'in_stock', 'production'],
      [sn('A'), 'V1', 'B1', '1.0', '', 'in_stock', 'production'],
    ])

    // Park the first row on a lock: an *uncommitted* component_unit carrying
    // its serial makes component_unit_sn block that row's insert. The batched
    // pre-check cannot see an uncommitted row, so the pass walks straight into
    // it. That holds the pass open at a known point — no sleep-and-hope — long
    // enough to cancel the batch underneath it.
    const typeId = (await db.query<{ id: string }>(
      `SELECT id FROM component_type WHERE code='pcba_a'`)).rows[0].id
    await db.query('BEGIN')
    await db.query(
      `INSERT INTO component_unit (component_type_id, serial_no, created_by, updated_by)
       VALUES ($1,$2,$3,$3)`, [typeId, parked, userId])

    const pass = commitImportBatch(mgr(), { batchId })
    await waitForLockWait()
    await cancelImportBatch(mgr(), batchId)
    await db.query('ROLLBACK')      // releases row 1; its insert now succeeds

    const res = await pass
    // Row 1 read the batch as open at the start of its own transaction and is
    // allowed to finish. Row 2's transaction starts after the cancel committed,
    // sees it, and abandons the row — without stamping it failed, because a
    // cancel is not a data problem.
    expect(res).toMatchObject({ committed: 1, failed: 0, skipped: 0, remaining: 1 })

    const { rows } = await db.query<{ status: string; device_id: string | null }>(
      `SELECT status, device_id FROM import_row WHERE batch_id=$1 ORDER BY source_row_no`,
      [batchId])
    expect(rows.map((r) => r.status)).toEqual(['committed', 'valid'])
    expect(rows[1].device_id).toBeNull()
    // The cancel stands: the tail-of-pass status stamp never resurrects a
    // cancelled batch.
    expect((await getImportBatch(mgr(), batchId))!.status).toBe('cancelled')
  })

  it('leaves invalid and needs_review rows alone', async () => {
    const { batchId } = await stage([
      [sn('A'), 'V1', 'B1', '1.0', '', 'Teleported', 'production'],
      ['A-1 and A-2', 'V1', 'B1', '1.0', '', 'in_stock', 'production'],
    ])
    const res = await commitImportBatch(mgr(), { batchId })
    expect(res.committed).toBe(0)
    const summary = (await getImportBatch(mgr(), batchId))!
    expect(summary.counts.invalid).toBe(1)
    expect(summary.counts.needs_review).toBe(1)
  })
})

describe('listImportRows / skipImportRow / cancelImportBatch', () => {
  it('lists rows and filters by status', async () => {
    const { batchId } = await stage([
      [sn('A'), 'V1', 'B1', '1.0', '', 'in_stock', 'production'],
      [sn('A'), 'V1', 'B1', '1.0', '', 'Teleported', 'production'],
    ])
    expect(await listImportRows(mgr(), batchId)).toHaveLength(2)
    const invalid = await listImportRows(mgr(), batchId, 'invalid')
    expect(invalid).toHaveLength(1)
    expect(invalid[0].errors[0]).toMatch(/not in the vocabulary/)
  })

  it('skips a row so a commit pass ignores it', async () => {
    const { batchId } = await stage([[sn('A'), 'V1', 'B1', '1.0', '', 'in_stock', 'production']])
    const [row] = await listImportRows(mgr(), batchId, 'valid')
    await skipImportRow(mgr(), batchId, row.id)
    const res = await commitImportBatch(mgr(), { batchId })
    expect(res.committed).toBe(0)
  })

  it('is a no-op when the row id belongs to a different batch', async () => {
    const { batchId: batchA } = await stage(
      [[sn('A'), 'V1', 'B1', '1.0', '', 'in_stock', 'production']])
    const { batchId: batchB } = await stage(
      [[sn('A'), 'V1', 'B1', '1.0', '', 'in_stock', 'production']])
    const [rowA] = await listImportRows(mgr(), batchA, 'valid')

    await skipImportRow(mgr(), batchB, rowA.id)

    const [rowAAfter] = await listImportRows(mgr(), batchA, 'valid')
    expect(rowAAfter.id).toBe(rowA.id)
    expect(rowAAfter.status).toBe('valid')
  })

  it('refuses to commit a cancelled batch, leaving its rows untouched', async () => {
    const a = sn('A')
    const { batchId } = await stage([[a, 'V1', 'B1', '1.0', '', 'in_stock', 'production']])
    await cancelImportBatch(mgr(), batchId)
    expect((await getImportBatch(mgr(), batchId))!.status).toBe('cancelled')
    const res = await commitImportBatch(mgr(), { batchId })
    expect(res).toMatchObject({ committed: 0, failed: 0, skipped: 0, remaining: 0 })
    // The row is left alone rather than stamped failed — a cancelled batch is
    // not a data problem with its rows.
    const [row] = await listImportRows(mgr(), batchId)
    expect(row.status).toBe('valid')
    expect((await db.query(
      `SELECT 1 FROM component_unit WHERE serial_no=$1`, [a])).rows).toHaveLength(0)
  })

  it('returns null for a batch that does not exist', async () => {
    expect(await getImportBatch(mgr(), '00000000-0000-0000-0000-000000000000')).toBeNull()
  })

  it('treats a malformed batch id as not-found rather than a database error', async () => {
    expect(await getImportBatch(mgr(), 'not-a-uuid')).toBeNull()
    expect(await listImportRows(mgr(), 'not-a-uuid')).toEqual([])
  })
})

describe('retryFailedRows', () => {
  it('refuses an actor without import_data', async () => {
    const { batchId } = await stage([[sn('A'), 'V1', 'B1', '1.0', '', 'in_stock', 'production']])
    await expect(retryFailedRows(viewer(), batchId)).rejects.toThrow(PermissionError)
  })

  it('requeues a row that failed for a fixable reason, so the next pass commits it', async () => {
    // The commit pass reads status='valid', so without this route a row that
    // failed for a fixable reason — here, an actor who may not seat a
    // non-initial status — could never be re-attempted.
    const { batchId } = await stage([[sn('A'), 'V1', 'B1', '1.0', '', 'shipped', 'production']])
    expect(await commitImportBatch(importerNoStatus(), { batchId }))
      .toMatchObject({ committed: 0, failed: 1, remaining: 0 })

    expect(await retryFailedRows(mgr(), batchId)).toEqual({ requeued: 1 })
    const [requeued] = await listImportRows(mgr(), batchId, 'valid')
    expect(requeued.status).toBe('valid')
    // A stale message must not outlive the condition it named.
    expect(requeued.errors).toEqual([])

    // Same row, an actor who does hold the permission: it commits.
    expect(await commitImportBatch(mgr(), { batchId }))
      .toMatchObject({ committed: 1, failed: 0, skipped: 0, remaining: 0 })
    const { rows } = await db.query<{ status: string }>(
      `SELECT d.status FROM device d JOIN import_row r ON r.device_id=d.id WHERE r.batch_id=$1`,
      [batchId])
    expect(rows[0].status).toBe('shipped')
  })

  it('re-opens a batch that a mixed pass had already stamped committed', async () => {
    // The shape the retry route exists for, and the one a single-row batch can
    // never reach: one row commits, another fails for a fixable reason, so no
    // 'valid' rows remain AND something committed — which is exactly what earns
    // the batch 'committed'. Requeueing alone left the row stranded: 'committed'
    // is not an open status, so the next commit pass early-exits, the Import
    // button is disabled and the row sits at 'valid' forever under a header that
    // claims it is ready. The requeue must re-open the batch too.
    //
    // An empty Status cell seats the initial status, which importerNoStatus may
    // set; 'shipped' is the one it may not.
    const shippedSn = sn('A')
    const { batchId } = await stage([
      [sn('A'), 'V1', 'B1', '1.0', '', '', 'production'],
      [shippedSn, 'V1', 'B1', '1.0', '', 'shipped', 'production'],
    ])
    expect(await commitImportBatch(importerNoStatus(), { batchId }))
      .toMatchObject({ committed: 1, failed: 1, skipped: 0, remaining: 0 })
    expect((await getImportBatch(mgr(), batchId))!.status).toBe('committed')

    expect(await retryFailedRows(mgr(), batchId)).toEqual({ requeued: 1 })
    const after = (await getImportBatch(mgr(), batchId))!
    expect(after.status).toBe('committing')      // open again: Import re-enables
    expect(after.counts).toMatchObject({ valid: 1, committed: 1, failed: 0 })

    // And the pass that follows actually commits the requeued row rather than
    // early-exiting on a closed batch.
    expect(await commitImportBatch(mgr(), { batchId }))
      .toMatchObject({ committed: 1, failed: 0, skipped: 0, remaining: 0 })
    expect((await getImportBatch(mgr(), batchId))!.status).toBe('committed')
    const { rows } = await db.query<{ status: string }>(
      `SELECT d.status FROM device d
         JOIN component_installation ci ON ci.device_id = d.id
         JOIN component_unit cu ON cu.id = ci.component_unit_id
        WHERE cu.serial_no=$1`, [shippedSn])
    expect(rows.map((r) => r.status)).toEqual(['shipped'])
  })

  it('does not re-open a cancelled batch', async () => {
    // A retry must never resurrect a batch someone deliberately closed: the rows
    // go back in the pending pool, but the batch stays cancelled and the commit
    // pass still refuses it.
    const { batchId } = await stage([[sn('A'), 'V1', 'B1', '1.0', '', 'shipped', 'production']])
    expect(await commitImportBatch(importerNoStatus(), { batchId }))
      .toMatchObject({ committed: 0, failed: 1 })
    await cancelImportBatch(mgr(), batchId)
    expect((await getImportBatch(mgr(), batchId))!.status).toBe('cancelled')

    expect(await retryFailedRows(mgr(), batchId)).toEqual({ requeued: 1 })
    expect((await getImportBatch(mgr(), batchId))!.status).toBe('cancelled')
    expect(await commitImportBatch(mgr(), { batchId }))
      .toMatchObject({ committed: 0, failed: 0, skipped: 0, remaining: 0 })
  })

  it('leaves a draft batch in draft when it requeues rows', async () => {
    // The re-open is scoped to 'committed'. A batch that committed nothing stays
    // 'draft' — still cancellable, and already open to a commit pass.
    const { batchId } = await stage([[sn('A'), 'V1', 'B1', '1.0', '', 'shipped', 'production']])
    expect(await commitImportBatch(importerNoStatus(), { batchId }))
      .toMatchObject({ committed: 0, failed: 1 })
    expect((await getImportBatch(mgr(), batchId))!.status).toBe('draft')
    expect(await retryFailedRows(mgr(), batchId)).toEqual({ requeued: 1 })
    expect((await getImportBatch(mgr(), batchId))!.status).toBe('draft')
  })

  it('leaves the batch status alone when there is nothing to requeue', async () => {
    const { batchId } = await stage([[sn('A'), 'V1', 'B1', '1.0', '', 'in_stock', 'production']])
    expect(await commitImportBatch(mgr(), { batchId })).toMatchObject({ committed: 1 })
    expect((await getImportBatch(mgr(), batchId))!.status).toBe('committed')
    expect(await retryFailedRows(mgr(), batchId)).toEqual({ requeued: 0 })
    // No failed rows, so no re-open: a finished batch must not be dragged back
    // to 'committing' by a Retry click on a batch with nothing to retry.
    expect((await getImportBatch(mgr(), batchId))!.status).toBe('committed')
  })

  it('leaves invalid, needs_review, skipped and committed rows alone', async () => {
    const { batchId } = await stage([
      [sn('A'), 'V1', 'B1', '1.0', '', 'in_stock', 'production'],        // → committed
      [sn('A'), 'V1', 'B1', '1.0', '', 'in_stock', 'production'],        // → skipped
      [sn('A'), 'V1', 'B1', '1.0', '', 'Teleported', 'production'],      // → invalid
      ['A-1 and A-2', 'V1', 'B1', '1.0', '', 'in_stock', 'production'],  // → needs_review
    ])
    const pending = await listImportRows(mgr(), batchId, 'valid')
    expect(pending).toHaveLength(2)
    await skipImportRow(mgr(), batchId, pending[1].id)
    expect(await commitImportBatch(mgr(), { batchId })).toMatchObject({ committed: 1 })

    const before = (await getImportBatch(mgr(), batchId))!.counts
    expect(before).toMatchObject({
      valid: 0, invalid: 1, needs_review: 1, committed: 1, skipped: 1, failed: 0,
    })

    // Nothing rests at 'failed', so there is nothing to requeue — and none of
    // the other four resting states may be dragged back into the pending pool.
    expect(await retryFailedRows(mgr(), batchId)).toEqual({ requeued: 0 })
    expect((await getImportBatch(mgr(), batchId))!.counts).toEqual(before)
  })

  it('treats a malformed batch id as a no-op rather than a database error', async () => {
    expect(await retryFailedRows(mgr(), 'not-a-uuid')).toEqual({ requeued: 0 })
  })
})
