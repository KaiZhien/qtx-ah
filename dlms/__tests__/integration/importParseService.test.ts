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

/**
 * Rows are `unknown[]` rather than `string[]` so a test can hand ExcelJS a real
 * cell shape — a rich-text object, a hyperlink, a formula, a Date — which is the
 * only way to exercise cellText against what a real workbook actually carries.
 */
async function sheetBytes(rows: unknown[][], sheetName = 'Traceability'): Promise<Uint8Array> {
  const wb = new ExcelJS.Workbook()
  const ws = wb.addWorksheet(sheetName)
  rows.forEach((r) => ws.addRow(r))
  const buf = await wb.xlsx.writeBuffer()
  return new Uint8Array(buf as ArrayBuffer)
}

const HEADERS = ['Device S/N', 'PCBA-A S/N', 'PCBA-A HW Rev', 'PCBA-A BOM Rev',
                 'PCBA-A FW Ver', 'Status', 'Phase']
const COMPONENT_HEADERS = ['Device S/N', 'PCBA-A S/N', 'PCBA-B S/N', 'Screen S/N',
                           'Status', 'Phase']

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

  it('records the batch as a draft with its kind and row count', async () => {
    const t = tag()
    const bytes = await sheetBytes([
      HEADERS,
      ['', `EE-A-${t}-0001 to 0002`, 'V1', 'B1', '1.0', 'in_stock', 'production'],
    ])
    const staged = await stageImportFile(mgr(userId), {
      filename: 'batch.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro',
    })
    const { rows } = await db.query<{
      source_kind: string; row_count: number; status: string; source_filename: string
      source_sha256: string; rows_present: number }>(
      `SELECT b.source_kind, b.row_count, b.status, b.source_filename, b.source_sha256,
              (SELECT count(*)::int FROM import_row r WHERE r.batch_id = b.id) AS rows_present
         FROM import_batch b WHERE b.id = $1`, [staged.batchId])
    expect(rows[0].source_kind).toBe('xlsx')
    expect(rows[0].status).toBe('draft')
    expect(rows[0].row_count).toBe(2)
    expect(rows[0].rows_present).toBe(2)   // multi-row insert wrote every row
    expect(rows[0].source_filename).toBe('batch.xlsx')
    expect(rows[0].source_sha256).toMatch(/^[0-9a-f]{64}$/)

    const csv = `${HEADERS.join(',')}\n,EE-A-${t}-0003,V1,B1,1.0,in_stock,production\n`
    const csvStaged = await stageImportFile(mgr(userId), {
      filename: 'batch.csv', kind: 'csv', bytes: new TextEncoder().encode(csv),
      defaultVariantCode: 'pro',
    })
    const { rows: csvRows } = await db.query<{ source_kind: string; row_count: number }>(
      `SELECT source_kind, row_count FROM import_batch WHERE id=$1`, [csvStaged.batchId])
    expect(csvRows[0].source_kind).toBe('csv')
    expect(csvRows[0].row_count).toBe(1)
  })

  it('creates no device or component rows — staging is not committing', async () => {
    const t = tag()
    const sn = `EE-A-${t}-0100`
    const countOf = async (table: string) => (await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM ${table}`)).rows[0].n
    const before = { d: await countOf('device'), c: await countOf('component_unit') }

    const bytes = await sheetBytes([
      HEADERS, ['', sn, 'V1', 'B1', '1.0', 'in_stock', 'production'],
    ])
    const staged = await stageImportFile(mgr(userId), {
      filename: 'nodevices.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro',
    })
    expect(staged.valid).toBe(1)

    expect(await countOf('device')).toBe(before.d)
    expect(await countOf('component_unit')).toBe(before.c)
    const { rows } = await db.query(
      `SELECT 1 FROM component_unit WHERE serial_no = $1`, [sn.toUpperCase()])
    expect(rows).toHaveLength(0)
  })

  // ── Fix 1: ExcelJS cell shapes that String() renders as "[object Object]" ──

  it('reads a rich-text serial as its text, not "[object Object]"', async () => {
    const t = tag()
    const sn = `EE-A-${t}-0201`
    // A partly-bold serial: exactly what a hand-edited traceability sheet carries.
    const bytes = await sheetBytes([
      HEADERS,
      ['', { richText: [{ text: `EE-A-${t}-` }, { font: { bold: true }, text: '0201' }] },
       'V1', 'B1', '1.0', 'in_stock', 'production'],
    ])
    const staged = await stageImportFile(mgr(userId), {
      filename: 'rich.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro',
    })
    const { rows } = await db.query<{
      status: string; parsed: { components: Array<{ serialNo: string }> } | null }>(
      `SELECT status, parsed FROM import_row WHERE batch_id=$1`, [staged.batchId])
    expect(rows).toHaveLength(1)
    expect(rows[0].parsed?.components[0].serialNo).toBe(sn.toUpperCase())
    expect(JSON.stringify(rows[0])).not.toMatch(/object object/i)
    expect(rows[0].status).toBe('valid')
  })

  it('reads a hyperlink serial as its display text', async () => {
    const t = tag()
    const sn = `EE-A-${t}-0202`
    const bytes = await sheetBytes([
      HEADERS,
      ['', { text: sn, hyperlink: 'https://example.invalid/trace' },
       'V1', 'B1', '1.0', 'in_stock', 'production'],
    ])
    const staged = await stageImportFile(mgr(userId), {
      filename: 'link.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro',
    })
    const { rows } = await db.query<{
      status: string; parsed: { components: Array<{ serialNo: string }> } | null }>(
      `SELECT status, parsed FROM import_row WHERE batch_id=$1`, [staged.batchId])
    expect(rows[0].status).toBe('valid')
    expect(rows[0].parsed?.components[0].serialNo).toBe(sn.toUpperCase())
    expect(JSON.stringify(rows[0])).not.toMatch(/object object|https:/i)
  })

  it('fails closed on a formula with no cached result and on an error cell', async () => {
    // Both are unreadable, and a wrong serial is permanent — so the row must be
    // rejected as "serial missing" rather than staged with placeholder text.
    const bytes = await sheetBytes([
      HEADERS,
      ['', { formula: 'B3&"x"' }, 'V1', 'B1', '1.0', 'in_stock', 'production'],
      ['', { error: '#N/A' }, 'V1', 'B1', '1.0', 'in_stock', 'production'],
      ['', { formula: 'NA()', result: { error: '#N/A' } },
       'V1', 'B1', '1.0', 'in_stock', 'production'],
    ])
    const staged = await stageImportFile(mgr(userId), {
      filename: 'unreadable.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro',
    })
    expect(staged.valid).toBe(0)
    expect(staged.invalid).toBe(3)
    const { rows } = await db.query<{ errors: string[]; parsed: unknown }>(
      `SELECT errors, parsed FROM import_row WHERE batch_id=$1`, [staged.batchId])
    for (const row of rows) {
      expect(row.errors).toContain('PCBA-A S/N is required')
      expect(row.parsed).toBeNull()
    }
    expect(JSON.stringify(rows)).not.toMatch(/object object/i)
  })

  it('keeps a formula cell that does carry a cached result', async () => {
    const t = tag()
    const sn = `EE-A-${t}-0203`
    const bytes = await sheetBytes([
      HEADERS,
      ['', { formula: 'X1&"y"', result: sn }, 'V1', 'B1', '1.0', 'in_stock', 'production'],
    ])
    const staged = await stageImportFile(mgr(userId), {
      filename: 'formula.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro',
    })
    expect(staged.valid).toBe(1)
    const { rows } = await db.query<{ parsed: { components: Array<{ serialNo: string }> } }>(
      `SELECT parsed FROM import_row WHERE batch_id=$1`, [staged.batchId])
    expect(rows[0].parsed.components[0].serialNo).toBe(sn.toUpperCase())
  })

  // ── Fix 6: a date cell must not shift a day ──

  it('stores a date cell as the calendar day the sheet means, on any host', async () => {
    const t = tag()
    // ExcelJS turns a date serial into UTC midnight, so local getDate() reads the
    // previous day on every host west of UTC (the bug class commit 6b36485 fixed
    // elsewhere). Pinning TZ makes the assertion bite regardless of where the
    // suite runs, instead of passing by accident on a UTC+ machine.
    const originalTz = process.env.TZ
    process.env.TZ = 'America/Los_Angeles'
    try {
      const bytes = await sheetBytes([
        [...HEADERS, 'Build Date', 'Ship Date'],
        ['', `EE-A-${t}-0301`, 'V1', 'B1', '1.0', 'in_stock', 'production',
         new Date(Date.UTC(2026, 2, 15)), '01/12/2026'],
      ])
      const staged = await stageImportFile(mgr(userId), {
        filename: 'dates.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro',
      })
      const { rows } = await db.query<{
        parsed: { buildDate: string; shipDate: string }; raw: { build_date: string } }>(
        `SELECT parsed, raw FROM import_row WHERE batch_id=$1`, [staged.batchId])
      expect(rows[0].raw.build_date).toBe('15/03/2026')
      expect(rows[0].parsed.buildDate).toBe('2026-03-15')
      expect(rows[0].parsed.shipDate).toBe('2026-12-01')
    } finally {
      if (originalTz === undefined) delete process.env.TZ
      else process.env.TZ = originalTz
    }
  })

  // ── Fix 3: every component's serial is checked, not just PCBA-A ──

  it('catches a duplicate PCBA-B serial', async () => {
    const t = tag()
    const sharedB = `EE-B-${t}-0001`
    const bytes = await sheetBytes([
      COMPONENT_HEADERS,
      ['', `EE-A-${t}-0401`, sharedB, `EE-S-${t}-0401`, 'in_stock', 'production'],
      ['', `EE-A-${t}-0402`, sharedB, `EE-S-${t}-0402`, 'in_stock', 'production'],
    ])
    const staged = await stageImportFile(mgr(userId), {
      filename: 'dupe-b.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro',
    })
    expect(staged.valid).toBe(1)
    expect(staged.invalid).toBe(1)
    const { rows } = await db.query<{ errors: string[]; source_row_no: number }>(
      `SELECT errors, source_row_no FROM import_row
        WHERE batch_id=$1 AND status='invalid'`, [staged.batchId])
    expect(rows[0].source_row_no).toBe(3)
    expect(rows[0].errors[0]).toMatch(/duplicate pcba_b serial/i)
    expect(rows[0].errors[0]).toContain(sharedB.toUpperCase())
    expect(rows[0].errors[0]).toMatch(/sheet row 2, unit 1/)
  })

  it('catches a duplicate screen serial', async () => {
    const t = tag()
    const sharedScreen = `EE-S-${t}-0500`
    const bytes = await sheetBytes([
      COMPONENT_HEADERS,
      ['', `EE-A-${t}-0501`, `EE-B-${t}-0501`, sharedScreen, 'in_stock', 'production'],
      ['', `EE-A-${t}-0502`, `EE-B-${t}-0502`, sharedScreen, 'in_stock', 'production'],
    ])
    const staged = await stageImportFile(mgr(userId), {
      filename: 'dupe-screen.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro',
    })
    expect(staged.valid).toBe(1)
    expect(staged.invalid).toBe(1)
    const { rows } = await db.query<{ errors: string[] }>(
      `SELECT errors FROM import_row WHERE batch_id=$1 AND status='invalid'`, [staged.batchId])
    expect(rows[0].errors[0]).toMatch(/duplicate hmi_screen serial/i)
    expect(rows[0].errors[0]).toContain(sharedScreen.toUpperCase())
  })

  it('names the claiming unit of a fanned row, not just its sheet row', async () => {
    const t = tag()
    const bytes = await sheetBytes([
      HEADERS,
      ['', `EE-A-${t}-0601 to 0603`, 'V1', 'B1', '1.0', 'in_stock', 'production'],
      ['', `EE-A-${t}-0602`, 'V1', 'B1', '1.0', 'in_stock', 'production'],
    ])
    const staged = await stageImportFile(mgr(userId), {
      filename: 'dupe-fan.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro',
    })
    expect(staged.valid).toBe(3)
    expect(staged.invalid).toBe(1)
    const { rows } = await db.query<{ errors: string[] }>(
      `SELECT errors FROM import_row WHERE batch_id=$1 AND status='invalid'`, [staged.batchId])
    // unit 2 of sheet row 2 is what claimed …0602 — "row 2" alone would be ambiguous.
    expect(rows[0].errors[0]).toMatch(/sheet row 2, unit 2/)
  })

  // ── Fix 4: a header must look like a header, and a batch must have rows ──

  it('skips a banner that merely mentions a column name', async () => {
    const t = tag()
    const bytes = await sheetBytes([
      ['QTX Traceability Report — Device S/N master list'],
      HEADERS,
      ['', `EE-A-${t}-0701`, 'V1', 'B1', '1.0', 'in_stock', 'production'],
    ])
    const staged = await stageImportFile(mgr(userId), {
      filename: 'banner.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro',
    })
    expect(staged.rowCount).toBe(1)
    expect(staged.valid).toBe(1)
    const { rows } = await db.query<{ source_row_no: number }>(
      `SELECT source_row_no FROM import_row WHERE batch_id=$1`, [staged.batchId])
    expect(rows[0].source_row_no).toBe(3)
  })

  it('rejects a header-only sheet instead of staging an empty batch', async () => {
    // The filename is tagged so the "nothing survived" assertion cannot be
    // confused by a batch an earlier run of this suite left in the shared DB.
    const filename = `headeronly-${tag()}.xlsx`
    const bytes = await sheetBytes([HEADERS])
    await expect(stageImportFile(mgr(userId), {
      filename, kind: 'xlsx', bytes, defaultVariantCode: 'pro',
    })).rejects.toThrow(/no data rows/i)
    const { rows } = await db.query(
      `SELECT 1 FROM import_batch WHERE source_filename=$1`, [filename])
    expect(rows).toHaveLength(0)   // nothing survived the failed parse
  })

  it('rejects a semicolon-delimited CSV instead of staging an empty batch', async () => {
    const t = tag()
    const filename = `semi-${t}.csv`
    const csv = `${HEADERS.join(';')}\n;EE-A-${t}-0801;V1;B1;1.0;in_stock;production\n`
    await expect(stageImportFile(mgr(userId), {
      filename, kind: 'csv', bytes: new TextEncoder().encode(csv),
      defaultVariantCode: 'pro',
    })).rejects.toThrow(ImportParseError)
    const { rows } = await db.query(
      `SELECT 1 FROM import_batch WHERE source_filename=$1`, [filename])
    expect(rows).toHaveLength(0)
  })

  // ── Fix 5: source_row_no is the physical row number ──

  it('numbers xlsx rows by their physical sheet row, blank row included', async () => {
    const t = tag()
    const bytes = await sheetBytes([
      HEADERS,
      [],   // physically row 2, contentless
      ['', `EE-A-${t}-0901`, 'V1', 'B1', '1.0', 'in_stock', 'production'],
      ['', `EE-A-${t}-0902`, 'V1', 'B1', '1.0', 'in_stock', 'production'],
    ])
    const staged = await stageImportFile(mgr(userId), {
      filename: 'blank.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro',
    })
    expect(staged.rowCount).toBe(2)
    const { rows } = await db.query<{ source_row_no: number }>(
      `SELECT source_row_no FROM import_row WHERE batch_id=$1 ORDER BY source_row_no`,
      [staged.batchId])
    expect(rows.map((r) => r.source_row_no)).toEqual([3, 4])
  })

  it('numbers csv rows by their physical line, blank lines included', async () => {
    const t = tag()
    // Header on line 2, data on lines 3 and 5. Filtering the blank lines out
    // before numbering (the Fix-5 bug) reported these as rows 2 and 3.
    const csv = `\n${HEADERS.join(',')}\n,EE-A-${t}-1001,V1,B1,1.0,in_stock,production\n`
      + `\n,EE-A-${t}-1002,V1,B1,1.0,in_stock,production\n`
    const staged = await stageImportFile(mgr(userId), {
      filename: 'blank.csv', kind: 'csv', bytes: new TextEncoder().encode(csv),
      defaultVariantCode: 'pro',
    })
    expect(staged.rowCount).toBe(2)
    const { rows } = await db.query<{ source_row_no: number }>(
      `SELECT source_row_no FROM import_row WHERE batch_id=$1 ORDER BY source_row_no`,
      [staged.batchId])
    expect(rows.map((r) => r.source_row_no)).toEqual([3, 5])
  })

  it('keeps a quoted inch mark in a CSV cell and the rows after it', async () => {
    const t = tag()
    const headers = [...HEADERS, 'Screen Model']
    const csv = `${headers.join(',')}\n`
      + `,EE-A-${t}-1101,V1,B1,1.0,in_stock,production,10.1" HMI\n`
      + `,EE-A-${t}-1102,V1,B1,1.0,in_stock,production,7" HMI\n`
    const staged = await stageImportFile(mgr(userId), {
      filename: 'inch.csv', kind: 'csv', bytes: new TextEncoder().encode(csv),
      defaultVariantCode: 'pro',
    })
    expect(staged.rowCount).toBe(2)   // the second row used to vanish silently
    const { rows } = await db.query<{ raw: { screen_model: string } }>(
      `SELECT raw FROM import_row WHERE batch_id=$1 ORDER BY source_row_no`, [staged.batchId])
    expect(rows.map((r) => r.raw.screen_model)).toEqual(['10.1" HMI', '7" HMI'])
  })

  it('rejects a CSV with an unterminated quoted field', async () => {
    const t = tag()
    const csv = `${HEADERS.join(',')}\n,"EE-A-${t}-1201,V1,B1,1.0,in_stock,production\n`
    await expect(stageImportFile(mgr(userId), {
      filename: 'unterminated.csv', kind: 'csv', bytes: new TextEncoder().encode(csv),
      defaultVariantCode: 'pro',
    })).rejects.toThrow(ImportParseError)
  })

  // ── Fix 7: an unreadable upload is a user error, not a stack trace ──

  it('rejects a non-xlsx upload as an ImportParseError', async () => {
    const t = tag()
    const names = [`renamed-${t}.xlsx`, `random-${t}.xlsx`, `empty-${t}.xlsx`]
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      // A CSV renamed .xlsx, a PDF header, and a zero-byte upload: all three used
      // to surface JSZip's "Can't find end of central directory" verbatim.
      const notAWorkbook = new TextEncoder().encode('Device S/N,PCBA-A S/N\n,EE-A-1\n')
      await expect(stageImportFile(mgr(userId), {
        filename: names[0], kind: 'xlsx', bytes: notAWorkbook,
        defaultVariantCode: 'pro',
      })).rejects.toThrow(ImportParseError)
      await expect(stageImportFile(mgr(userId), {
        filename: names[1], kind: 'xlsx',
        bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x34]),
        defaultVariantCode: 'pro',
      })).rejects.toThrow(/real \.xlsx/i)
      await expect(stageImportFile(mgr(userId), {
        filename: names[2], kind: 'xlsx', bytes: new Uint8Array(0),
        defaultVariantCode: 'pro',
      })).rejects.toThrow(ImportParseError)
      expect(logged).toHaveBeenCalled()   // the library error is logged, not swallowed
    } finally {
      logged.mockRestore()
    }
    const { rows } = await db.query(
      `SELECT 1 FROM import_batch WHERE source_filename = ANY($1)`, [names])
    expect(rows).toHaveLength(0)
  })

  it('carries the underlying library error as the cause', async () => {
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      const err = await stageImportFile(mgr(userId), {
        filename: `cause-${tag()}.xlsx`, kind: 'xlsx',
        bytes: new TextEncoder().encode('not a workbook'), defaultVariantCode: 'pro',
      }).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(ImportParseError)
      expect((err as { cause?: unknown }).cause).toBeInstanceOf(Error)
    } finally {
      logged.mockRestore()
    }
  })

  // ── Fix 10: the preferred sheet is matched loosely ──

  it('prefers a traceability sheet whose name differs in case', async () => {
    const t = tag()
    const wb = new ExcelJS.Workbook()
    wb.addWorksheet('Cover').addRow(['Device S/N', 'PCBA-A S/N'])
    const ws = wb.addWorksheet(' traceability ')
    ws.addRow(HEADERS)
    ws.addRow(['', `EE-A-${t}-1301`, 'V1', 'B1', '1.0', 'in_stock', 'production'])
    const bytes = new Uint8Array(await wb.xlsx.writeBuffer() as ArrayBuffer)

    const staged = await stageImportFile(mgr(userId), {
      filename: 'case.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro',
    })
    expect(staged.valid).toBe(1)
    const { rows } = await db.query<{ parsed: { components: Array<{ serialNo: string }> } }>(
      `SELECT parsed FROM import_row WHERE batch_id=$1`, [staged.batchId])
    expect(rows[0].parsed.components[0].serialNo).toBe(`EE-A-${t}-1301`.toUpperCase())
  })

  // ── Vocabulary labels, and the parsed/status contract ──

  it('resolves human status and phase labels to their codes', async () => {
    const t = tag()
    const bytes = await sheetBytes([
      HEADERS,
      ['', `EE-A-${t}-1401`, 'V1', 'B1', '1.0', 'In Stock', 'Production'],
      ['', `EE-A-${t}-1402`, 'V1', 'B1', '1.0', 'In Production', 'Rework'],
      ['', `EE-A-${t}-1403`, 'V1', 'B1', '1.0', '库存', '量产'],
    ])
    const staged = await stageImportFile(mgr(userId), {
      filename: 'labels.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro',
    })
    expect(staged.valid).toBe(3)
    const { rows } = await db.query<{ parsed: { status: string; phase: string } }>(
      `SELECT parsed FROM import_row WHERE batch_id=$1 ORDER BY source_row_no`,
      [staged.batchId])
    expect(rows.map((r) => [r.parsed.status, r.parsed.phase])).toEqual([
      ['in_stock', 'production'],
      ['in_production', 'rework'],
      ['in_stock', 'production'],
    ])
  })

  it('leaves parsed NULL for invalid and needs_review rows', async () => {
    const t = tag()
    const bytes = await sheetBytes([
      HEADERS,
      ['', `EE-A-${t}-1501`, 'V1', 'B1', '1.0', 'in_stock', 'production'],   // valid
      ['', `EE-A-${t}-1502`, 'V1', 'B1', '1.0', 'Nonesuch', 'production'],   // invalid
      ['', 'A-1 and A-2', 'V1', 'B1', '1.0', 'in_stock', 'production'],      // needs_review
    ])
    const staged = await stageImportFile(mgr(userId), {
      filename: 'mixed.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro',
    })
    expect([staged.valid, staged.invalid, staged.needsReview]).toEqual([1, 1, 1])
    const { rows } = await db.query<{ status: string; parsed: unknown }>(
      `SELECT status, parsed FROM import_row WHERE batch_id=$1 ORDER BY source_row_no`,
      [staged.batchId])
    expect(rows.map((r) => r.status)).toEqual(['valid', 'invalid', 'needs_review'])
    expect(rows[0].parsed).not.toBeNull()
    expect(rows[1].parsed).toBeNull()
    expect(rows[2].parsed).toBeNull()
  })

  it('stages a batch larger than one insert chunk', async () => {
    const t = tag()
    // 600 units from one ranged row: crosses the 500-row chunk boundary, so a
    // chunking bug (dropped tail, duplicated chunk) shows up as a row-count miss.
    const bytes = await sheetBytes([
      HEADERS, ['', `EE-A-${t}-0001 to 0600`, 'V1', 'B1', '1.0', 'in_stock', 'production'],
    ])
    const staged = await stageImportFile(mgr(userId), {
      filename: 'chunked.xlsx', kind: 'xlsx', bytes, defaultVariantCode: 'pro',
    })
    expect(staged.rowCount).toBe(600)
    const { rows } = await db.query<{ n: number; units: number; statuses: string[] }>(
      `SELECT count(*)::int AS n, count(DISTINCT unit_no)::int AS units,
              array_agg(DISTINCT status) AS statuses
         FROM import_row WHERE batch_id=$1`, [staged.batchId])
    expect(rows[0].n).toBe(600)
    expect(rows[0].units).toBe(600)
    // The value, not just the cardinality: one distinct status could as easily be
    // 600 rows sitting on the column's 'needs_review' default.
    expect(rows[0].statuses).toEqual(['valid'])

    // Values and order across the boundary, not only the count: a chunking bug can
    // repeat chunk 1, drop chunk 2's tail, or misalign the parameter tuples — none
    // of which changes how many rows exist.
    const { rows: spans } = await db.query<{
      unit_no: number; parsed: { components: Array<{ serialNo: string }> } | null }>(
      `SELECT unit_no, parsed FROM import_row
        WHERE batch_id=$1 AND unit_no IN (500, 501, 600) ORDER BY unit_no`, [staged.batchId])
    expect(spans.map((r) => r.unit_no)).toEqual([500, 501, 600])
    expect(spans[1].parsed).not.toBeNull()
    expect(spans.map((r) => r.parsed?.components[0].serialNo)).toEqual([
      `EE-A-${t}-0500`.toUpperCase(),
      `EE-A-${t}-0501`.toUpperCase(),   // first row of the second chunk
      `EE-A-${t}-0600`.toUpperCase(),
    ])
  })

  // ── Fix pass 2: header detection, CSV padding, and true CSV line numbers ──

  it('accepts a minimal sheet whose only recognised column is a serial', async () => {
    const t = tag()
    const single = await stageImportFile(mgr(userId), {
      filename: 'minimal.xlsx', kind: 'xlsx', defaultVariantCode: 'pro',
      bytes: await sheetBytes([['PCBA-A S/N'], [`EE-A-${t}-1601`]]),
    })
    expect([single.rowCount, single.valid]).toEqual([1, 1])

    // A serial column plus one column this importer does not know is still a
    // header — the unknown one is reported, not a reason to reject the sheet.
    const withNotes = await stageImportFile(mgr(userId), {
      filename: 'minimal-notes.xlsx', kind: 'xlsx', defaultVariantCode: 'pro',
      bytes: await sheetBytes([['PCBA-A S/N', 'Notes'], [`EE-A-${t}-1602`, 'hand-built']]),
    })
    expect([withNotes.rowCount, withNotes.valid]).toEqual([1, 1])
    expect(withNotes.unmappedHeaders).toEqual(['Notes'])

    // Two headers that both resolve to the *same* field: a real bilingual sheet
    // that names one column twice. The row is invalid (no PCBA-A serial), which is
    // the point — the header row itself was accepted rather than the whole sheet
    // rejected as headerless.
    const bilingual = await stageImportFile(mgr(userId), {
      filename: 'minimal-bilingual.xlsx', kind: 'xlsx', defaultVariantCode: 'pro',
      bytes: await sheetBytes([['Device S/N', '设备序列号'], [`EE-D-${t}-1603`, '']]),
    })
    expect([bilingual.rowCount, bilingual.invalid]).toEqual([1, 1])
  })

  it('rejects a sheet whose only marker sits inside a prose banner', async () => {
    // The decoy: it contains "Device S/N" but is not a column header, so choosing
    // it would map zero columns and stage zero rows while reporting success.
    const filename = `bannerorphan-${tag()}.xlsx`
    const bytes = await sheetBytes([
      ['QTX Traceability Report — Device S/N master list'],
      ['Prepared by Manufacturing, 2026-07-30'],
      ['red', 'L'],
    ])
    await expect(stageImportFile(mgr(userId), {
      filename, kind: 'xlsx', bytes, defaultVariantCode: 'pro',
    })).rejects.toThrow(/could not find a header row/i)
    const { rows } = await db.query(
      `SELECT 1 FROM import_batch WHERE source_filename=$1`, [filename])
    expect(rows).toHaveLength(0)
  })

  it('keeps CSV columns aligned when a quoted cell is padded before its quote', async () => {
    const t = tag()
    // Remarks sits *between* two mapped columns, so a quote read as literal text
    // would shift Status onto the remark's tail — an invalid row at best, and a
    // wrong-but-plausible value at worst.
    const headers = ['Device S/N', 'PCBA-A S/N', 'Remarks', 'Status', 'Phase']
    const csv = `${headers.join(',')}\n`
      + `,EE-A-${t}-1701, "first batch, urgent" ,in_stock,production\n`
    const staged = await stageImportFile(mgr(userId), {
      filename: 'padded.csv', kind: 'csv', bytes: new TextEncoder().encode(csv),
      defaultVariantCode: 'pro',
    })
    expect([staged.rowCount, staged.valid]).toEqual([1, 1])
    const { rows } = await db.query<{
      raw: { remarks: string }; parsed: { remarks: string; status: string } }>(
      `SELECT raw, parsed FROM import_row WHERE batch_id=$1`, [staged.batchId])
    // The padding before the opening quote is syntax and is dropped; what follows
    // the closing quote is content, like any post-close character.
    expect(rows[0].raw.remarks).toBe('first batch, urgent ')
    expect(rows[0].parsed.remarks).toBe('first batch, urgent ')
    expect(rows[0].parsed.status).toBe('in_stock')
  })

  it('numbers a CSV row below a multi-line quoted remark by its physical line', async () => {
    const t = tag()
    // remarks is documented as bilingual and multiline, so this file is legal —
    // and its second data row starts on line 4, not line 3. Deriving
    // source_row_no from the record index reported it as 3, sending a reviewer
    // chasing "row 3" to the wrong line of the file.
    const headers = [...HEADERS, 'Remarks']
    const csv = `${headers.join(',')}\n`
      + `,EE-A-${t}-1801,V1,B1,1.0,in_stock,production,"首批出货\nfirst batch"\n`
      + `,EE-A-${t}-1802,V1,B1,1.0,in_stock,production,second batch\n`
    const staged = await stageImportFile(mgr(userId), {
      filename: 'multiline.csv', kind: 'csv', bytes: new TextEncoder().encode(csv),
      defaultVariantCode: 'pro',
    })
    expect([staged.rowCount, staged.valid]).toEqual([2, 2])
    const { rows } = await db.query<{
      source_row_no: number; parsed: { remarks: string } }>(
      `SELECT source_row_no, parsed FROM import_row WHERE batch_id=$1 ORDER BY source_row_no`,
      [staged.batchId])
    expect(rows.map((r) => r.source_row_no)).toEqual([2, 4])
    expect(rows[0].parsed.remarks).toBe('首批出货\nfirst batch')   // verbatim, newline kept
    expect(rows[1].parsed.remarks).toBe('second batch')
  })

  // ── Fix wave F1: every documented header alias finds the header row ──

  it('accepts documented header aliases and any casing of them', async () => {
    const t = tag()
    // Header detection used to require a cell to *contain* one of four
    // hardcoded, case-sensitive literals ('Device S/N', 'PCBA-A S/N' and their
    // Chinese forms) on top of resolving through COLUMN_ALIASES. Every sheet
    // below carries a column this importer documents as an alias, and every one
    // of them was rejected with "the sheet needs a 'Device S/N' or 'PCBA-A S/N'
    // column header" — about a sheet that has exactly that column. Bilingual
    // files passed only because the Chinese marker happened to match, which is
    // why no earlier test caught it.
    const noSlash = await stageImportFile(mgr(userId), {
      filename: 'alias-pcba.xlsx', kind: 'xlsx', defaultVariantCode: 'pro',
      bytes: await sheetBytes([['PCBA-A SN'], [`EE-A-${t}-1901`]]),
    })
    expect([noSlash.rowCount, noSlash.valid]).toEqual([1, 1])

    // 'Device SN' alone: the row is invalid (it carries no PCBA-A serial), which
    // is the point — the header row itself was recognised rather than the whole
    // sheet rejected as headerless.
    const deviceNoSlash = await stageImportFile(mgr(userId), {
      filename: 'alias-device.xlsx', kind: 'xlsx', defaultVariantCode: 'pro',
      bytes: await sheetBytes([['Device SN'], [`EE-D-${t}-1902`]]),
    })
    expect([deviceNoSlash.rowCount, deviceNoSlash.invalid]).toEqual([1, 1])

    const shouty = await stageImportFile(mgr(userId), {
      filename: 'alias-caps.xlsx', kind: 'xlsx', defaultVariantCode: 'pro',
      bytes: await sheetBytes([['DEVICE S/N'], [`EE-D-${t}-1903`]]),
    })
    expect([shouty.rowCount, shouty.invalid]).toEqual([1, 1])

    // And end to end: a mixed-case sheet whose columns both map, producing a
    // committable draft rather than merely an accepted header row.
    const mixed = await stageImportFile(mgr(userId), {
      filename: 'alias-mixed.xlsx', kind: 'xlsx', defaultVariantCode: 'pro',
      bytes: await sheetBytes([
        ['device s/n', 'PCBA-A Sn'], [`EE-D-${t}-1904`, `EE-A-${t}-1904`]]),
    })
    expect([mixed.rowCount, mixed.valid]).toEqual([1, 1])
    const { rows } = await db.query<{
      parsed: { deviceSn: string; components: Array<{ serialNo: string }> } }>(
      `SELECT parsed FROM import_row WHERE batch_id=$1`, [mixed.batchId])
    expect(rows[0].parsed.deviceSn).toBe(`EE-D-${t}-1904`)
    expect(rows[0].parsed.components[0].serialNo).toBe(`EE-A-${t}-1904`.toUpperCase())
  })

  // ── Fix wave F3: staging is bounded ──

  it('refuses a file that expands past the staged-row cap, staging nothing', async () => {
    const t = tag()
    const filename = `toobig-${t}.xlsx`
    // 11 rows at the largest expandable range (expandSerialRange caps one range
    // at 5000 units) is 55,000 drafts — past MAX_STAGED_ROWS. Unbounded, a file
    // like this is ~175 MB of live objects and then one transaction inserting all
    // of them: a function timeout mid-commit rather than anything the uploader
    // could act on. The cap trips during accumulation, so the memory is never
    // spent, and it says what to do about it.
    const rows = Array.from({ length: 11 }, (_, i) =>
      ['', `EE-A-${t}-${i}-0001 to 5000`, 'V1', 'B1', '1.0', 'in_stock', 'production'])
    await expect(stageImportFile(mgr(userId), {
      filename, kind: 'xlsx', defaultVariantCode: 'pro',
      bytes: await sheetBytes([HEADERS, ...rows]),
    })).rejects.toThrow(/expands to more than 50,000 device rows/i)

    const { rows: batches } = await db.query(
      `SELECT 1 FROM import_batch WHERE source_filename=$1`, [filename])
    expect(batches).toHaveLength(0)   // thrown before any transaction opened
  })

})
