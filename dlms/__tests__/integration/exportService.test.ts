// __tests__/integration/exportService.test.ts
//
// The full-system export (spec §12, D36) against a real database.
//
// THE CENTRAL ASSERTION IS THAT THE COLUMN REGISTRY MATCHES THE SCHEMA. Every
// entity in EXPORT_ENTITIES names its columns explicitly rather than SELECT *,
// which is the right call — but it means a column renamed by any module silently
// becomes a runtime failure in the one feature nobody exercises daily. The first
// test below compares the registry against information_schema, so that drift
// fails here instead of the first time a Super Admin asks for an export.
//
// Also proves the manifest actually certifies the archive: every digest is
// recomputed from the bytes inside the ZIP.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { inflateRawSync } from 'node:zlib'
import { createHash } from 'node:crypto'
import { getPool } from '@/lib/db/pool'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor, ModuleKey, Permission } from '@/modules/shared/authz/catalog'
import { EXPORT_ENTITIES } from '@/modules/shared/export/domain/entities'
import {
  buildFullExport, ExportMfaRequiredError,
} from '@/modules/shared/export/services/exportService'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client
let userId: string

const TOK = 'zzexp5510'
const createdDeviceIds: string[] = []

const now = new Date()
const freshMfa = [{ method: 'totp', timestamp: new Date(now.getTime() - 10_000).toISOString() }]

const superAdmin = (over: Partial<Actor> = {}): Actor => ({
  id: userId, roleKey: 'super_admin',
  permissions: new Set<Permission>(['request_full_export', 'view_records']),
  moduleAccess: new Set<ModuleKey>(['admin']),
  active: true,
  ...over,
})

const requester = () => ({ id: userId, name: `Exporter ${TOK}`, email: `${TOK}@example.com` })

/** Reads the ZIP back through its central directory — an independent parse. */
function readZip(zip: Buffer): Map<string, Buffer> {
  let eocd = -1
  for (let i = zip.length - 22; i >= 0; i--) {
    if (zip.readUInt32LE(i) === 0x06054b50) { eocd = i; break }
  }
  if (eocd < 0) throw new Error('no EOCD')
  const total = zip.readUInt16LE(eocd + 10)
  let p = zip.readUInt32LE(eocd + 16)
  const out = new Map<string, Buffer>()
  for (let i = 0; i < total; i++) {
    const method = zip.readUInt16LE(p + 10)
    const compSize = zip.readUInt32LE(p + 20)
    const nameLen = zip.readUInt16LE(p + 28)
    const extraLen = zip.readUInt16LE(p + 30)
    const commentLen = zip.readUInt16LE(p + 32)
    const localOffset = zip.readUInt32LE(p + 42)
    const name = zip.subarray(p + 46, p + 46 + nameLen).toString('utf8')
    const lNameLen = zip.readUInt16LE(localOffset + 26)
    const lExtraLen = zip.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + lNameLen + lExtraLen
    const stored = zip.subarray(start, start + compSize)
    out.set(name, method === 8 ? inflateRawSync(stored) : Buffer.from(stored))
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

beforeAll(async () => {
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()

  userId = (await db.query<{ id: string }>(
    `INSERT INTO app_user (email, full_name, role_id, module_access, active)
     SELECT $1, $2, r.id, ARRAY['admin']::text[], true FROM role r WHERE r.key = 'super_admin'
     ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
     RETURNING id`, [`${TOK}@example.com`, `Exporter ${TOK}`])).rows[0].id

  const variantId = (await db.query<{ id: string }>(
    `SELECT id FROM device_variant LIMIT 1`)).rows[0].id
  createdDeviceIds.push((await db.query<{ id: string }>(
    `INSERT INTO device (device_sn, variant_id, status, remarks, created_by, updated_by)
     SELECT $1, $2, s.code, $3, $4, $4 FROM status_option s ORDER BY s.sort_order LIMIT 1
     RETURNING id`,
    // Bilingual + a comma + a quote: the CSV quoting rules meet real data.
    [`EXP-${TOK}-1`, variantId, '无 wifi 版本, "special"', userId])).rows[0].id)
})

afterAll(async () => {
  await db.query(`DELETE FROM audit_log WHERE table_name = 'full_system_export'
                    AND actor_id = $1`, [userId])
  await db.query(`DELETE FROM device WHERE id = ANY($1::uuid[])`, [createdDeviceIds])
  await db.end()
  await getPool().end()
})

describe('EXPORT_ENTITIES matches the live schema', () => {
  it('names only tables that exist', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables WHERE table_schema = 'public'`)
    const live = new Set(rows.map((r) => r.table_name))
    for (const e of EXPORT_ENTITIES) {
      expect(live.has(e.table), `EXPORT_ENTITIES names missing table ${e.table}`).toBe(true)
    }
  })

  it('names only columns that exist — the drift guard for every module', async () => {
    // This is the test that earns its keep. Columns are enumerated rather than
    // SELECT *, so a rename anywhere in the app turns the export into a runtime
    // error that nobody meets until they need a backup.
    const { rows } = await db.query<{ table_name: string; column_name: string }>(
      `SELECT table_name, column_name FROM information_schema.columns
        WHERE table_schema = 'public'`)
    const live = new Map<string, Set<string>>()
    for (const r of rows) {
      if (!live.has(r.table_name)) live.set(r.table_name, new Set())
      live.get(r.table_name)!.add(r.column_name)
    }
    const missing: string[] = []
    for (const e of EXPORT_ENTITIES) {
      for (const c of e.columns) {
        if (!live.get(e.table)?.has(c)) missing.push(`${e.table}.${c}`)
      }
    }
    expect(missing).toEqual([])
  })

  it('carries the BOM effectivity columns, which changed under this feature', async () => {
    const bom = EXPORT_ENTITIES.find((e) => e.table === 'variant_bom_line')!
    expect(bom.columns).toContain('effective_to_date')
    expect(bom.columns).toContain('superseded_by_eco_id')
  })
})

describe('the export ceremony', () => {
  it('refuses an actor without request_full_export', async () => {
    const plain = superAdmin({
      roleKey: 'operator', permissions: new Set<Permission>(['view_records']),
    })
    await expect(buildFullExport(plain, requester(), freshMfa)).rejects.toThrow(PermissionError)
  })

  it('refuses a permitted actor whose second factor is stale', async () => {
    const stale = [{ method: 'totp', timestamp: new Date(now.getTime() - 9e6).toISOString() }]
    await expect(buildFullExport(superAdmin(), requester(), stale))
      .rejects.toThrow(ExportMfaRequiredError)
  })

  it('fails closed when the auth methods cannot be read', async () => {
    await expect(buildFullExport(superAdmin(), requester(), null))
      .rejects.toThrow(ExportMfaRequiredError)
  })
})

describe('the built archive', () => {
  it('contains every entity plus the four documents, and a verifiable manifest', async () => {
    const built = await buildFullExport(superAdmin(), requester(), freshMfa)
    const files = readZip(built.zip)

    for (const e of EXPORT_ENTITIES) {
      expect(files.has(`${e.format}/${e.table}.${e.format}`), `missing ${e.table}`).toBe(true)
    }
    for (const doc of ['manifest.json', 'schema.md', 'relationships.md', 'README.md']) {
      expect(files.has(doc), `missing ${doc}`).toBe(true)
    }

    // Every manifest digest recomputed from the bytes actually in the archive.
    const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8'))
    for (const f of manifest.files) {
      const data = files.get(f.path)
      expect(data, `manifest names ${f.path}, archive does not have it`).toBeDefined()
      expect(createHash('sha256').update(data!).digest('hex')).toBe(f.sha256)
      expect(data!.length).toBe(f.bytes)
    }

    // A file cannot carry its own digest.
    expect(manifest.files.map((f: { path: string }) => f.path)).not.toContain('manifest.json')
    expect(manifest.totals.files).toBe(manifest.files.length)
  })

  it('reports a row count per entity that matches the database', async () => {
    const built = await buildFullExport(superAdmin(), requester(), freshMfa)
    const files = readZip(built.zip)
    const manifest = JSON.parse(files.get('manifest.json')!.toString('utf8'))

    const deviceEntry = manifest.files.find((f: { entity: string }) => f.entity === 'device')
    const { rows } = await db.query<{ n: string }>(`SELECT count(*)::text AS n FROM device`)
    expect(deviceEntry.rowCount).toBe(Number(rows[0].n))
  })

  it('writes CSV with a BOM and CRLF, preserving bilingual content verbatim', async () => {
    const built = await buildFullExport(superAdmin(), requester(), freshMfa)
    const csv = readZip(built.zip).get('csv/device.csv')!
    expect(csv.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]))
    const text = csv.toString('utf8')
    expect(text).toContain('\r\n')
    expect(text).toContain(`EXP-${TOK}-1`)
    // The remarks field holds a comma and a quote — RFC 4180 quoting, doubled quote.
    expect(text).toContain('"无 wifi 版本, ""special"""')
  })

  it('writes JSON sets as parseable arrays', async () => {
    const built = await buildFullExport(superAdmin(), requester(), freshMfa)
    const files = readZip(built.zip)
    for (const e of EXPORT_ENTITIES.filter((x) => x.format === 'json')) {
      const parsed = JSON.parse(files.get(`json/${e.table}.json`)!.toString('utf8'))
      expect(Array.isArray(parsed), `${e.table} is not an array`).toBe(true)
    }
  })

  it('documents the joins an analyst needs', async () => {
    const built = await buildFullExport(superAdmin(), requester(), freshMfa)
    const rel = readZip(built.zip).get('relationships.md')!.toString('utf8')
    expect(rel).toContain('stable UUID')
    expect(rel).toMatch(/`repair\.device_id`[^\n]*`device\.id`/)
    expect(rel).toMatch(/effective_to_serial IS NULL/)
  })

  it('audit-logs the request, the build and the download', async () => {
    // spec §12: "request, build and download each audit-logged". fn_audit is a
    // trigger on table WRITES and an export only reads, so without the explicit
    // records the one operation that copies every record out would leave no trace.
    const before = (await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log
        WHERE table_name = 'full_system_export' AND actor_id = $1`, [userId])).rows[0].n

    const built = await buildFullExport(superAdmin(), requester(), freshMfa)

    const { rows } = await db.query<{ new_values: { event: string }; row_id: string }>(
      `SELECT new_values, row_id::text AS row_id FROM audit_log
        WHERE table_name = 'full_system_export' AND actor_id = $1
          AND row_id = $2::uuid
        ORDER BY occurred_at`, [userId, built.exportId])

    expect(rows.map((r) => r.new_values.event)).toEqual(['requested', 'built'])
    expect(Number(before)).toBeLessThan(
      Number((await db.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM audit_log
          WHERE table_name = 'full_system_export' AND actor_id = $1`, [userId])).rows[0].n))
  })

  it('gives the archive a dated, export-id-stamped filename', async () => {
    const built = await buildFullExport(superAdmin(), requester(), freshMfa)
    expect(built.filename).toMatch(/^qtx-export-\d{4}-\d{2}-\d{2}-[0-9a-f]{8}\.zip$/)
  })
})
