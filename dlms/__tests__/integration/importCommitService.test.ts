import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import ExcelJS from 'exceljs'
import { getPool } from '@/lib/db/pool'
import { stageImportFile } from '@/modules/manufacturing/services/importParseService'
import {
  commitImportBatch, getImportBatch, listImportRows, skipImportRow, cancelImportBatch,
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
    await skipImportRow(mgr(), row.id)
    const res = await commitImportBatch(mgr(), { batchId })
    expect(res.committed).toBe(0)
  })

  it('refuses to commit a cancelled batch', async () => {
    const { batchId } = await stage([[sn('A'), 'V1', 'B1', '1.0', '', 'in_stock', 'production']])
    await cancelImportBatch(mgr(), batchId)
    expect((await getImportBatch(mgr(), batchId))!.status).toBe('cancelled')
    const res = await commitImportBatch(mgr(), { batchId })
    expect(res).toMatchObject({ committed: 0, remaining: 0 })
  })

  it('returns null for a batch that does not exist', async () => {
    expect(await getImportBatch(mgr(), '00000000-0000-0000-0000-000000000000')).toBeNull()
  })
})
