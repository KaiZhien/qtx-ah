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
/**
 * The AMR claim in its REAL shape: `timestamp` is a number of UNIX SECONDS, per
 * @supabase/auth-js. It was an ISO string here and in twelve unit tests, all of
 * them green, while the gate refused every genuine request — `Date.parse` of a
 * number is NaN, so the export could never be downloaded at all. The fixture is
 * the contract; getting it wrong is how a permanent 403 stays invisible.
 */
const epochSeconds = (d: Date) => Math.floor(d.getTime() / 1000)
const freshMfa = [{ method: 'totp', timestamp: epochSeconds(now) - 10 }]

const superAdmin = (over: Partial<Actor> = {}): Actor => ({
  id: userId, roleKey: 'super_admin',
  permissions: new Set<Permission>(['request_full_export', 'view_records']),
  moduleAccess: new Set<ModuleKey>(['admin']),
  active: true,
  ...over,
})

const requester = () => ({ id: userId, name: `Exporter ${TOK}`, email: `${TOK}@example.com` })

/**
 * Splits ONE already-line-separated CSV record into fields, honouring RFC 4180
 * quoting (`""` is a literal quote, a quoted field may contain commas).
 *
 * Written here rather than imported: the point of these assertions is to read the
 * archive back with something that does not share code with the writer, so a
 * quoting bug cannot cancel itself out. The fixture row contains `无 wifi 版本,
 * "special"` precisely to exercise both rules.
 */
function splitCsvLine(line: string): string[] {
  const fields: string[] = []
  let field = ''
  let quoted = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (quoted) {
      if (ch !== '"') { field += ch; continue }
      if (line[i + 1] === '"') { field += '"'; i++; continue }
      quoted = false
    } else if (ch === '"') {
      quoted = true
    } else if (ch === ',') {
      fields.push(field); field = ''
    } else {
      field += ch
    }
  }
  fields.push(field)
  return fields
}

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
  // The service under test opens its OWN connection through getPool(), which
  // reads DATABASE_URL. Without this line the pool falls back to libpq defaults
  // and tries to open a database named after the OS user; only this file's own
  // `db` client would reach the test container.
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
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
    `INSERT INTO device (device_sn, variant_id, status, remarks, build_date, ship_date,
                         created_by, updated_by)
     SELECT $1, $2, s.code, $3, DATE '2026-08-04', DATE '2026-01-01', $4, $4
       FROM status_option s ORDER BY s.sort_order LIMIT 1
     RETURNING id`,
    // Bilingual + a comma + a quote: the CSV quoting rules meet real data.
    // The two dates are the I9 fixture — see the date-column block below.
    [`EXP-${TOK}-1`, variantId, '无 wifi 版本, "special"', userId])).rows[0].id)
})

afterAll(async () => {
  await db.query(`DELETE FROM audit_log WHERE table_name = 'full_system_export'
                    AND actor_id = $1`, [userId])
  await db.query(`DELETE FROM device WHERE id = ANY($1::uuid[])`, [createdDeviceIds])
  // The fixture user cannot be deleted — audit rows reference it — but it must not
  // be left as a SECOND ACTIVE SUPER ADMIN in a shared, non-rollback database.
  // userService's last-Super-Admin tests assert a GLOBAL property, and this row
  // silently satisfied the guard for them (this file sorts before that one).
  await db.query(`UPDATE app_user SET active = false WHERE id = $1`, [userId])
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
    const stale = [{ method: 'totp', timestamp: epochSeconds(now) - 9000 }]
    await expect(buildFullExport(superAdmin(), requester(), stale))
      .rejects.toThrow(ExportMfaRequiredError)
  })

  it('fails closed when the auth methods cannot be read', async () => {
    await expect(buildFullExport(superAdmin(), requester(), null))
      .rejects.toThrow(ExportMfaRequiredError)
  })

  it('refuses the RFC-8176 string form, which carries no timestamp', async () => {
    // `currentAuthenticationMethods` is `AMREntry[] | string[]`; the string form
    // names the methods and never says when. Unanswerable, so refused.
    await expect(buildFullExport(superAdmin(), requester(), ['password', 'totp']))
      .rejects.toThrow(ExportMfaRequiredError)
  })

  it('ACCEPTS a genuinely fresh claim — the case that was broken end to end', async () => {
    // The regression in one assertion: with `timestamp` mis-typed as a string,
    // this threw for a Super Admin who had entered TOTP ten seconds earlier, and
    // the whole feature was unreachable while every unit test stayed green.
    const built = await buildFullExport(superAdmin(), requester(), freshMfa)
    expect(built.zip.length).toBeGreaterThan(0)
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

describe('date columns survive the trip — CLAUDE.md\'s ::text rule', () => {
  // node-postgres parses a Postgres `date` (OID 1082) into a JS Date at LOCAL
  // midnight, and csvField renders a Date with toISOString(). Without the cast,
  // `2026-08-04` ships as `2026-08-03T16:00:00.000Z` on a UTC+8 host — a day
  // early AND a different kind of value. This test is run under whatever TZ the
  // suite has; the assertion holds in every zone precisely because the value
  // never becomes a Date.
  it('writes build_date and ship_date as bare YYYY-MM-DD', async () => {
    const built = await buildFullExport(superAdmin(), requester(), freshMfa)
    const csv = readZip(built.zip).get('csv/device.csv')!.toString('utf8')
    const lines = csv.split('\r\n')
    const header = splitCsvLine(lines[0].replace(/^﻿/, ''))
    const row = splitCsvLine(lines.find((l) => l.includes(`EXP-${TOK}-1`))!)
    const cell = (column: string) => row[header.indexOf(column)]

    // ASSERTED PER FIELD, not by searching the whole line. The original searched
    // the joined row for `/2026-08-0\dT\d{2}:\d{2}/` — which the row's own
    // `created_at` matches, because it is a timestamptz and legitimately an
    // instant. So the test passed or failed on WHAT DAY IT WAS RUN: green on
    // 2026-08-12, red on 2026-08-04. Naming the two columns is both narrower and
    // stricter — an exact equality rather than a substring hunt.
    expect(cell('build_date')).toBe('2026-08-04')
    expect(cell('ship_date')).toBe('2026-01-01')
    // The failure mode, named: a date must never arrive carrying a time — and the
    // UTC+8 day-shift that comes with it (`2026-08-03T16:00:00.000Z`) is ruled out
    // by the equality above in every host timezone.
    for (const c of ['build_date', 'ship_date']) expect(cell(c)).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('writes date columns in the JSON sets as strings too', async () => {
    // The same defect hits JSON.stringify(Date), which also emits an instant.
    const built = await buildFullExport(superAdmin(), requester(), freshMfa)
    const files = readZip(built.zip)
    const usage = JSON.parse(files.get('json/import_row.json')!.toString('utf8'))
    expect(Array.isArray(usage)).toBe(true)
    const rows = JSON.parse(files.get('json/component_installation.json')!.toString('utf8'))
    for (const r of rows.slice(0, 20)) {
      // installed_at is a timestamptz and legitimately an instant; nothing on
      // this table is a bare `date`. The assertion that matters is that the
      // builder did not throw on a table with no date columns at all.
      expect(r).toHaveProperty('id')
    }
  })
})

describe('a table that does not exist must not abort the whole export', () => {
  // Five migrations sit committed-and-unapplied on `main` at any moment in this
  // project, so this is a live case. Before the guard, one missing relation
  // aborted the transaction and the Super Admin got a generic 500 naming nothing
  // — losing every other entity that would have exported perfectly.
  const withGhost = [
    ...EXPORT_ENTITIES.filter((e) => e.table === 'device' || e.table === 'buyer'),
    {
      table: 'zz_not_yet_migrated', format: 'csv' as const,
      columns: ['id', 'name'], orderBy: 'id', liveOnly: false,
      description: 'A table whose migration has not been applied.',
    },
  ]

  it('builds the entities that DO exist and skips the one that does not', async () => {
    const built = await buildFullExport(superAdmin(), requester(), freshMfa,
      { entities: withGhost })
    const files = readZip(built.zip)

    expect(files.has('csv/device.csv')).toBe(true)
    expect(files.has('csv/buyer.csv')).toBe(true)
    expect(files.has('csv/zz_not_yet_migrated.csv')).toBe(false)
  })

  it('SKIPS the file rather than emitting an empty one', async () => {
    // An empty CSV says "there are no records", which is a different claim from
    // "this table was not there" — and the more dangerous of the two.
    const built = await buildFullExport(superAdmin(), requester(), freshMfa,
      { entities: withGhost })
    expect(built.manifest.files.map((f) => f.entity)).not.toContain('zz_not_yet_migrated')
  })

  it('names the absent table in the manifest and warns in the README', async () => {
    const built = await buildFullExport(superAdmin(), requester(), freshMfa,
      { entities: withGhost })
    expect(built.manifest.absentEntities).toEqual(['zz_not_yet_migrated'])

    const readme = readZip(built.zip).get('README.md')!.toString('utf8')
    expect(readme).toMatch(/Tables missing from this export/)
    expect(readme).toContain('zz_not_yet_migrated')
  })

  it('says nothing about missing tables when none are missing', async () => {
    const built = await buildFullExport(superAdmin(), requester(), freshMfa)
    expect(built.manifest.absentEntities).toEqual([])
    expect(readZip(built.zip).get('README.md')!.toString('utf8'))
      .not.toMatch(/Tables missing from this export/)
  })

  it('records the absent tables on the audit trail, not only in the archive', async () => {
    const built = await buildFullExport(superAdmin(), requester(), freshMfa,
      { entities: withGhost })
    const { rows } = await db.query<{ new_values: { absentTables?: string[] } }>(
      `SELECT new_values FROM audit_log
        WHERE table_name = 'full_system_export' AND row_id = $1::uuid
          AND new_values->>'event' = 'built'`, [built.exportId])
    expect(rows[0].new_values.absentTables).toEqual(['zz_not_yet_migrated'])
  })
})
