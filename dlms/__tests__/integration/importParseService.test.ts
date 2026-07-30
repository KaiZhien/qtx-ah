import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import ExcelJS from 'exceljs'
import { getPool } from '@/lib/db/pool'
import { stageImportFile, ImportParseError } from '@/modules/manufacturing/services/importParseService'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
})
afterAll(async () => { await db.end(); await getPool().end() })

describe('import staging schema', () => {
  it('creates import_batch and import_row', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name IN ('import_batch','import_row')
        ORDER BY table_name`)
    expect(rows.map((r) => r.table_name)).toEqual(['import_batch', 'import_row'])
  })

  it('enforces the batch/source_row_no/unit_no uniqueness of a staged row', async () => {
    const userId = (await db.query(
      `SELECT id FROM app_user WHERE email='reetmitra8@gmail.com'`)).rows[0].id
    const variantId = (await db.query(
      `SELECT id FROM device_variant WHERE code='pro'`)).rows[0].id
    const batchId = (await db.query<{ id: string }>(
      `INSERT INTO import_batch (source_filename, source_sha256, source_kind,
                                 default_variant_id, created_by, updated_by)
       VALUES ('t.xlsx', repeat('a', 64), 'xlsx', $1, $2, $2) RETURNING id`,
      [variantId, userId])).rows[0].id

    const insert = () => db.query(
      `INSERT INTO import_row (batch_id, source_row_no, unit_no, raw, created_by)
       VALUES ($1, 5, 1, '{}'::jsonb, $2)`, [batchId, userId])

    await insert()
    await expect(insert()).rejects.toThrow(/import_row_unique/)
    await db.query(`DELETE FROM import_batch WHERE id=$1`, [batchId])
  })

  it('cascades row deletion when a batch is deleted', async () => {
    const userId = (await db.query(
      `SELECT id FROM app_user WHERE email='reetmitra8@gmail.com'`)).rows[0].id
    const variantId = (await db.query(
      `SELECT id FROM device_variant WHERE code='pro'`)).rows[0].id
    const batchId = (await db.query<{ id: string }>(
      `INSERT INTO import_batch (source_filename, source_sha256, source_kind,
                                 default_variant_id, created_by, updated_by)
       VALUES ('t2.xlsx', repeat('b', 64), 'xlsx', $1, $2, $2) RETURNING id`,
      [variantId, userId])).rows[0].id
    await db.query(
      `INSERT INTO import_row (batch_id, source_row_no, unit_no, raw, created_by)
       VALUES ($1, 1, 1, '{}'::jsonb, $2)`, [batchId, userId])
    await db.query(`DELETE FROM import_batch WHERE id=$1`, [batchId])
    const { rows } = await db.query(`SELECT 1 FROM import_row WHERE batch_id=$1`, [batchId])
    expect(rows).toHaveLength(0)
  })

  it('rejects an unknown row status', async () => {
    const userId = (await db.query(
      `SELECT id FROM app_user WHERE email='reetmitra8@gmail.com'`)).rows[0].id
    const variantId = (await db.query(
      `SELECT id FROM device_variant WHERE code='pro'`)).rows[0].id
    const batchId = (await db.query<{ id: string }>(
      `INSERT INTO import_batch (source_filename, source_sha256, source_kind,
                                 default_variant_id, created_by, updated_by)
       VALUES ('t3.xlsx', repeat('c', 64), 'xlsx', $1, $2, $2) RETURNING id`,
      [variantId, userId])).rows[0].id
    await expect(db.query(
      `INSERT INTO import_row (batch_id, source_row_no, unit_no, raw, status, created_by)
       VALUES ($1, 1, 1, '{}'::jsonb, 'bogus', $2)`, [batchId, userId]))
      .rejects.toThrow(/import_row_status/)
    await db.query(`DELETE FROM import_batch WHERE id=$1`, [batchId])
  })
})

const mgr = (userId: string): Actor => ({
  id: userId, roleKey: 'manager',
  permissions: new Set(['view_records', 'create_records', 'edit_records', 'import_data']),
  moduleAccess: new Set(['manufacturing']), active: true,
})
const viewer = (userId: string): Actor => ({
  id: userId, roleKey: 'viewer', permissions: new Set(['view_records']),
  moduleAccess: new Set(['manufacturing']), active: true,
})

async function sheetBytes(rows: string[][]): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet('Traceability')
  rows.forEach((r) => ws.addRow(r))
  const buf = await wb.xlsx.writeBuffer()
  return new Uint8Array(buf as ArrayBuffer)
}

const HEADERS = ['Device S/N', 'PCBA-A S/N', 'PCBA-A HW Rev', 'PCBA-A BOM Rev',
                 'PCBA-A FW Ver', 'Status', 'Phase']

describe('stageImportFile', () => {
  let userId: string
  const tag = () => `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

  // Reuses `db` from the file-level beforeAll above (outer hooks run first), so
  // the schema tests and these service tests share one connection.
  beforeAll(async () => {
    userId = (await db.query(
      `SELECT id FROM app_user WHERE email='reetmitra8@gmail.com'`)).rows[0].id
  })

  it('refuses an actor without import_data', async () => {
    const bytes = await sheetBytes([HEADERS, ['', `S-${tag()}`, 'V1', 'B1', '1.0', 'in_stock', 'production']])
    await expect(stageImportFile(viewer(userId), {
      filename: 'x.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro',
    })).rejects.toThrow(PermissionError)
  })

  it('stages valid rows with a parsed draft', async () => {
    const t = tag()
    const bytes = await sheetBytes([
      HEADERS,
      ['', `EE-A-${t}-0001`, 'V1.2', 'B3', '1.0.4', 'in_stock', 'production'],
    ])
    const staged = await stageImportFile(mgr(userId), {
      filename: 'ok.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro',
    })
    expect(staged.rowCount).toBe(1)
    expect(staged.valid).toBe(1)

    const { rows } = await db.query<{ status: string; parsed: { components: unknown[] } }>(
      `SELECT status, parsed FROM import_row WHERE batch_id=$1`, [staged.batchId])
    expect(rows[0].status).toBe('valid')
    expect(rows[0].parsed.components).toHaveLength(1)
  })

  it('fans a ranged serial into one row per unit', async () => {
    const t = tag()
    const bytes = await sheetBytes([
      HEADERS,
      ['', `EE-A-${t}-0001 to 0003`, 'V1', 'B1', '1.0', 'in_stock', 'production'],
    ])
    const staged = await stageImportFile(mgr(userId), {
      filename: 'range.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro',
    })
    expect(staged.rowCount).toBe(3)
    expect(staged.valid).toBe(3)
    const { rows } = await db.query<{ unit_no: number; source_row_no: number }>(
      `SELECT unit_no, source_row_no FROM import_row WHERE batch_id=$1 ORDER BY unit_no`,
      [staged.batchId])
    expect(rows.map((r) => r.unit_no)).toEqual([1, 2, 3])
    expect(new Set(rows.map((r) => r.source_row_no)).size).toBe(1)
  })

  it('routes unexpandable notation to needs_review', async () => {
    const bytes = await sheetBytes([
      HEADERS, ['', 'A-1 and A-2', 'V1', 'B1', '1.0', 'in_stock', 'production'],
    ])
    const staged = await stageImportFile(mgr(userId), {
      filename: 'amb.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro',
    })
    expect(staged.needsReview).toBe(1)
    expect(staged.valid).toBe(0)
  })

  it('marks a within-batch duplicate serial invalid', async () => {
    const t = tag()
    const sn = `EE-A-${t}-0009`
    const bytes = await sheetBytes([
      HEADERS,
      ['', sn, 'V1', 'B1', '1.0', 'in_stock', 'production'],
      ['', sn, 'V1', 'B1', '1.0', 'in_stock', 'production'],
    ])
    const staged = await stageImportFile(mgr(userId), {
      filename: 'dupe.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro',
    })
    expect(staged.valid).toBe(1)
    expect(staged.invalid).toBe(1)
    const { rows } = await db.query<{ errors: string[] }>(
      `SELECT errors FROM import_row WHERE batch_id=$1 AND status='invalid'`, [staged.batchId])
    expect(rows[0].errors[0]).toMatch(/duplicate/i)
  })

  it('reports headers it could not map', async () => {
    const t = tag()
    const bytes = await sheetBytes([
      [...HEADERS, 'Internal Notes'],
      ['', `EE-A-${t}-0004`, 'V1', 'B1', '1.0', 'in_stock', 'production', 'ignore me'],
    ])
    const staged = await stageImportFile(mgr(userId), {
      filename: 'extra.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro',
    })
    expect(staged.unmappedHeaders).toContain('Internal Notes')
  })

  it('rejects a sheet with no recognisable header row', async () => {
    const bytes = await sheetBytes([['Colour', 'Size'], ['red', 'L']])
    await expect(stageImportFile(mgr(userId), {
      filename: 'junk.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro',
    })).rejects.toThrow(ImportParseError)
  })

  it('rejects an unknown default variant', async () => {
    const bytes = await sheetBytes([HEADERS, ['', 'A-1', 'V1', 'B1', '1.0', 'in_stock', 'production']])
    await expect(stageImportFile(mgr(userId), {
      filename: 'v.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'deluxe',
    })).rejects.toThrow(ImportParseError)
  })

  it('parses a CSV body as well as a workbook', async () => {
    const t = tag()
    const csv = `${HEADERS.join(',')}\n,EE-A-${t}-0007,V1,B1,1.0,in_stock,production\n`
    const staged = await stageImportFile(mgr(userId), {
      filename: 'x.csv', kind: 'csv', bytes: new TextEncoder().encode(csv),
      defaultVariantCode: 'pro',
    })
    expect(staged.valid).toBe(1)
  })
})
