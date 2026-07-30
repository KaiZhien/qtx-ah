import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'

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
