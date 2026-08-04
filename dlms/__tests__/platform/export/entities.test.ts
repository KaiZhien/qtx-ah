import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { EXPORT_ENTITIES } from '@/modules/shared/export/domain/entities'

/**
 * "FULL-SYSTEM" HAS TO MEAN FULL, AND NOTHING WAS CHECKING THAT.
 *
 * The integration suite already asserts the registry ⊆ the schema — every table
 * and column it names exists. The MISSING direction is the dangerous one: a
 * module ships a table, nobody adds it here, and the export goes on succeeding.
 * There is no error, no empty file, no warning in `manifest.json` — the archive
 * is simply smaller than the system, and the only moment anyone finds out is a
 * restore. Thirteen tables had accumulated that way.
 *
 * So this reads the platform migrations and demands that every table they create
 * is either exported or named in EXPECTED_ABSENT with a reason. It is a unit test
 * on purpose: it must run in the ordinary `npm test` pass that everybody runs,
 * not only in the dockerized integration suite.
 *
 * SCOPE: `*platform*.sql` only. The legacy DLMS app's own tables live in the same
 * migrations directory and are not part of this platform's record — the retired
 * app under `/legacy/*` owns them, and spec §12's export is of the platform.
 */

const MIGRATIONS = join(__dirname, '../../../supabase/migrations')

/**
 * Tables a platform migration creates that the export deliberately omits.
 *
 * EMPTY, AND THAT IS THE POINT. Every entry here has to earn itself with a
 * reason, because the alternative — "we just never added it" — is precisely the
 * failure mode this test exists to catch, and an exclusion list is the only place
 * that decision can be written down.
 */
const EXPECTED_ABSENT: Record<string, string> = {}

function platformTables(): string[] {
  const files = readdirSync(MIGRATIONS).filter((f) => f.includes('platform') && f.endsWith('.sql'))
  const found = new Set<string>()
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), 'utf8')
    for (const m of sql.matchAll(/^CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)\s*\(/gmi)) {
      found.add(m[1])
    }
  }
  return [...found].sort()
}

describe('EXPORT_ENTITIES covers the whole platform schema', () => {
  it('finds the migrations at all — an empty scan must not pass vacuously', () => {
    // A broken glob or a moved directory would otherwise make every assertion
    // below trivially true, which is the worst way for this guard to fail.
    const tables = platformTables()
    expect(tables.length).toBeGreaterThan(40)
    expect(tables).toContain('device')
    expect(tables).toContain('audit_log')
  })

  it('exports every table a platform migration creates', () => {
    const exported = new Set(EXPORT_ENTITIES.map((e) => e.table))
    const missing = platformTables()
      .filter((t) => !exported.has(t) && !(t in EXPECTED_ABSENT))
    expect(missing, `not exported and not explained: ${missing.join(', ')}`).toEqual([])
  })

  it('keeps the exclusion list honest — no entry for a table that IS exported', () => {
    // A stale exclusion reads as a deliberate omission of something that is in
    // fact present, which sends the next reader looking for a bug that is not there.
    const exported = new Set(EXPORT_ENTITIES.map((e) => e.table))
    for (const t of Object.keys(EXPECTED_ABSENT)) {
      expect(exported.has(t), `${t} is exported but listed as absent`).toBe(false)
    }
  })

  it('keeps the exclusion list honest — no entry for a table that does not exist', () => {
    const live = new Set(platformTables())
    for (const t of Object.keys(EXPECTED_ABSENT)) {
      expect(live.has(t), `${t} is excluded but no migration creates it`).toBe(true)
    }
  })
})

describe('EXPORT_ENTITIES internal consistency', () => {
  it('names each table exactly once', () => {
    const seen = EXPORT_ENTITIES.map((e) => e.table)
    expect(seen).toHaveLength(new Set(seen).size)
  })

  it('lists id first wherever the table has one', () => {
    // The UUIDs are the join keys relationships.md documents; `id` leading is what
    // makes a CSV readable at a glance.
    for (const e of EXPORT_ENTITIES) {
      if (e.columns.includes('id')) expect(e.columns[0], e.table).toBe('id')
    }
  })

  it('only filters on deleted_at where the column exists', () => {
    // `liveOnly` becomes `WHERE deleted_at IS NULL`, so setting it on a table
    // without the column is a runtime error inside a build nobody runs daily.
    for (const e of EXPORT_ENTITIES) {
      if (e.liveOnly) expect(e.columns, e.table).toContain('deleted_at')
    }
  })

  it('gives every entity a non-empty description and orderBy', () => {
    // orderBy is what makes two exports of unchanged data byte-identical, which
    // is the property the manifest digests are worth having.
    for (const e of EXPORT_ENTITIES) {
      expect(e.orderBy.trim().length, e.table).toBeGreaterThan(0)
      expect(e.description.trim().length, e.table).toBeGreaterThan(0)
    }
  })

  it('ships every jsonb-bearing set as JSON, never as CSV', () => {
    // A jsonb column flattened into a CSV cell is a quoted blob no spreadsheet can
    // use and nothing can reliably parse back — the split spec §12 asks for.
    const JSONB_SETS = ['audit_log', 'approval', 'outbox', 'import_row']
    for (const t of JSONB_SETS) {
      const e = EXPORT_ENTITIES.find((x) => x.table === t)!
      expect(e, t).toBeDefined()
      expect(e.format, t).toBe('json')
    }
  })
})
