import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

// Task R1 (spec §11.1): the qtx-ops-platform schema is live on a cloud Supabase
// project, where every public-schema table is exposed via the auto-generated
// PostgREST API to anyone holding the anon key UNLESS RLS is enabled. This file
// proves the migration's deny-via-REST posture actually denies REST-equivalent
// access (SET ROLE anon / authenticated against this harness's own anon/
// authenticated roles — see setup.ts for why those roles and their default
// privileges exist here) while leaving the owner connection — the only path the
// app itself uses (withTransaction) — untouched.

let db: Client
let userId: string
let variantId: string
let deviceId: string
let taskId: string

// Only these four are exercised for SELECT-denial: brief calls out device, task,
// app_user, and role_permission by name as the representative sample (a plain
// table, a table with FK-heavy children, the identity table, and the most
// security-sensitive table). The posture group below separately checks the whole
// derived population, to catch a table accidentally left out of a migration.
const SELECT_DENIAL_TABLES = ['device', 'task', 'app_user', 'role_permission']

// ---------------------------------------------------------------------------
// THE POPULATION IS DERIVED FROM THE MIGRATIONS, NOT LISTED HERE.
//
// This file used to carry a hand-written `ALL_14_TABLES` — the original R1 set.
// The schema grew to 51 platform tables and the list never moved, so 37 tables
// were asserted nowhere by the pin that exists to assert exactly this. Per-slice
// tests happened to cover most of them; six (`import_batch`, `import_row`,
// `root_cause_option`, `failure_investigation`, `failure_status_history`,
// `ec_affected_item`) were covered by nothing at all. Every one of them is
// CORRECT today — the defect was never a missing `ENABLE ROW LEVEL SECURITY`,
// it was that a future migration forgetting one would fail no test and re-trip
// the cloud `rls_disabled` ERROR advisor, which is the regression R1 exists to
// prevent.
//
// Adding six names would have fixed today and rotted again by the next slice.
// So the population is read out of the migrations, exactly as
// __tests__/platform/export/entities.test.ts does for the export registry: a new
// table is covered the day it is created, by whoever creates it, without anyone
// remembering this file.
//
// The regex matches setup.ts's PLATFORM_MIGRATION_RE, and for its reasons: the
// `platform_` prefix — not a date range — is what distinguishes these migrations
// from the legacy DLMS ones sharing the directory.
// ---------------------------------------------------------------------------
const MIGRATIONS = join(__dirname, '../../supabase/migrations')
const PLATFORM_MIGRATION_RE = /^\d{14}_platform_.*\.sql$/

/**
 * Tables a platform migration creates that are exempt from the posture check.
 *
 * SHIPPED EMPTY, AND THAT IS THE POINT — the same contract entities.test.ts's
 * EXPECTED_ABSENT carries. Every entry must earn itself with a written reason,
 * because "we just never checked it" is precisely the failure this test exists
 * to catch, and an exclusion list is the only place that decision can be
 * recorded. Note what an entry costs: the table is then exempt from RLS-enabled
 * too, so it is REST-readable by anyone holding the anon key.
 */
const POSTURE_EXCLUSIONS: Record<string, string> = {}

/**
 * The two tables that deliberately carry a permissive `authenticated` SELECT
 * policy, quoted from 20260718000001_platform_audit.sql.
 *
 * NOT AN EXCLUSION LIST — it does not exempt anything. These tables still must
 * have RLS enabled, still must be NOT FORCE, still must expose nothing to
 * `anon`, and still must grant no WRITE to either role. This list only says
 * which tables may carry an authenticated READ, and a third table acquiring one
 * fails the assertion below rather than joining them silently. That is the whole
 * value: R1's own header calls this a follow-up to tighten when the audit UI
 * lands, and a follow-up nothing enforces is a comment.
 */
const DOCUMENTED_AUTHENTICATED_READS: Record<string, string> = {
  audit_log: 'Task 2 (20260718000001_platform_audit.sql) granted a permissive authenticated '
    + 'SELECT policy in anticipation of an audit UI. Tightening it belongs to that task.',
  auth_event: 'Same decision, same migration, same follow-up.',
}

/** Every table a `*_platform_*.sql` migration creates, sorted. */
function platformTables(): string[] {
  const files = readdirSync(MIGRATIONS).filter((f) => PLATFORM_MIGRATION_RE.test(f))
  const found = new Set<string>()
  for (const f of files) {
    const sql = readFileSync(join(MIGRATIONS, f), 'utf8')
    for (const m of sql.matchAll(/^CREATE TABLE (?:IF NOT EXISTS )?([a-z_][a-z0-9_]*)\s*\(/gmi)) {
      found.add(m[1])
    }
  }
  // No platform migration drops or renames a table, so "created" and "exists"
  // are the same set; the existence assertion below is what keeps that true.
  return [...found].filter((t) => !(t in POSTURE_EXCLUSIONS)).sort()
}

const PLATFORM_TABLES = platformTables()

/** Runs `fn` with the connection's role temporarily switched, always resetting after. */
async function asRole<T>(role: 'anon' | 'authenticated', fn: () => Promise<T>): Promise<T> {
  await db.query(`SET ROLE ${role}`)
  try {
    return await fn()
  } finally {
    await db.query('RESET ROLE')
  }
}

beforeAll(async () => {
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  userId = (await db.query(`SELECT id FROM app_user WHERE email = 'reetmitra8@gmail.com'`)).rows[0].id
  variantId = (await db.query(`SELECT id FROM device_variant WHERE code = 'basic'`)).rows[0].id

  // A per-run serial, not the fixed 'QTX-RLS-00001' this file used to insert.
  // The suite shares a NON-ROLLBACK database, and the fixed serial made a second
  // run against an already-populated container fail on `device_sn_unique` — one
  // of the eleven files named in the carried re-runnability finding. Every
  // assertion below is already scoped by id, so the serial only ever needed to be
  // unique.
  const runSn = `QTX-RLS-${Date.now().toString(36).toUpperCase()}`

  const { rows: deviceRows } = await db.query(
    `INSERT INTO device (device_sn, variant_id, status, created_by, updated_by)
     VALUES ($3, $1, 'in_stock', $2, $2) RETURNING id`,
    [variantId, userId, runSn],
  )
  deviceId = deviceRows[0].id

  const { rows: taskRows } = await db.query(
    `INSERT INTO task (title, status, created_by) VALUES ('RLS probe task', 'open', $1) RETURNING id`,
    [userId],
  )
  taskId = taskRows[0].id
})
afterAll(async () => { await db.end() })

describe('platform RLS — deny-via-REST posture (Task R1)', () => {
  describe('anon is denied all reads', () => {
    for (const table of SELECT_DENIAL_TABLES) {
      it(`sees zero rows in ${table}, though rows exist as owner`, async () => {
        const n = await asRole('anon', async () => {
          const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${table}`)
          return rows[0].n
        })
        expect(n).toBe(0)
      })
    }
  })

  describe('authenticated is denied all reads', () => {
    // The app never runs as authenticated against these tables (only
    // supabase.auth.getUser() uses that JWT, never a table read) — denying
    // this path is correct, not a regression.
    for (const table of SELECT_DENIAL_TABLES) {
      it(`sees zero rows in ${table}, though rows exist as owner`, async () => {
        const n = await asRole('authenticated', async () => {
          const { rows } = await db.query(`SELECT count(*)::int AS n FROM ${table}`)
          return rows[0].n
        })
        expect(n).toBe(0)
      })
    }
  })

  describe('authenticated cannot write via the REST-equivalent path', () => {
    it('rejects an INSERT into device (no INSERT policy exists)', async () => {
      await db.query('SET ROLE authenticated')
      try {
        await expect(
          db.query(
            `INSERT INTO device (device_sn, variant_id, status, created_by) VALUES ($1, $2, 'in_stock', $3)`,
            ['QTX-RLS-REJECT', variantId, userId],
          ),
        ).rejects.toThrow(/row-level security/i)
      } finally {
        await db.query('RESET ROLE')
      }
    })

    it('silently updates zero rows on an existing device (row is invisible under RLS)', async () => {
      await db.query('SET ROLE authenticated')
      let result
      try {
        result = await db.query(
          `UPDATE device SET remarks = 'tampered-by-authenticated' WHERE id = $1`,
          [deviceId],
        )
      } finally {
        await db.query('RESET ROLE')
      }
      expect(result.rowCount).toBe(0)

      // Confirm as owner the row genuinely wasn't touched — proves the zero
      // rowCount above means "denied", not "coincidentally matched nothing".
      const { rows } = await db.query(`SELECT remarks FROM device WHERE id = $1`, [deviceId])
      expect(rows[0].remarks).not.toBe('tampered-by-authenticated')
    })

    it('silently deletes zero rows on an existing device (row is invisible under RLS)', async () => {
      await db.query('SET ROLE authenticated')
      let result
      try {
        result = await db.query(`DELETE FROM device WHERE id = $1`, [deviceId])
      } finally {
        await db.query('RESET ROLE')
      }
      expect(result.rowCount).toBe(0)

      const { rows } = await db.query(`SELECT count(*)::int AS n FROM device WHERE id = $1`, [deviceId])
      expect(rows[0].n).toBe(1)
    })
  })

  describe('the owner connection is unaffected — this is the app path', () => {
    it('still sees the seeded device row by id', async () => {
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM device WHERE id = $1`, [deviceId])
      expect(rows[0].n).toBe(1)
    })

    it('still sees the seeded task row by id', async () => {
      const { rows } = await db.query(`SELECT count(*)::int AS n FROM task WHERE id = $1`, [taskId])
      expect(rows[0].n).toBe(1)
    })
  })

  describe('the deny-via-REST posture holds on EVERY table a platform migration creates', () => {
    it('finds the migrations at all — an empty scan must not pass vacuously', () => {
      // A broken glob or a moved directory would otherwise make every assertion
      // below trivially true, which is the worst way for a security pin to fail.
      // The floor is well above the 14 this file used to list, so the old shape
      // could not satisfy it either.
      expect(PLATFORM_TABLES.length).toBeGreaterThan(45)
      expect(PLATFORM_TABLES).toContain('device')
      expect(PLATFORM_TABLES).toContain('approval')
      // The six that were asserted NOWHERE before this rewrite, named so that a
      // regression in the scan is legible rather than just a smaller number.
      for (const t of [
        'import_batch', 'import_row', 'root_cause_option',
        'failure_investigation', 'failure_status_history', 'ec_affected_item',
      ]) expect(PLATFORM_TABLES).toContain(t)
    })

    it('creates every one of them for real — the scan and the schema agree', async () => {
      // Guards the derivation itself: a table renamed by a later migration, or a
      // CREATE TABLE the regex mis-parses, would otherwise be silently asserted
      // about nothing at all (pg_class returns no row → `undefined`, and a
      // toBe(true) on undefined would fail, but a "no policies" check would PASS).
      const { rows } = await db.query(
        `SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1::text[])`,
        [PLATFORM_TABLES],
      )
      const live = new Set(rows.map((r) => r.relname as string))
      const missing = PLATFORM_TABLES.filter((t) => !live.has(t))
      expect(missing, `a platform migration creates these but they are not in the schema: ${missing.join(', ')}`)
        .toEqual([])
    })

    it('has RLS ENABLED on every one — this is the cloud rls_disabled ERROR advisor', async () => {
      const { rows } = await db.query(
        `SELECT relname, relrowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname = ANY($1::text[])`,
        [PLATFORM_TABLES],
      )
      const off = rows.filter((r) => r.relrowsecurity !== true).map((r) => r.relname)
      expect(off, `RLS is disabled on: ${off.join(', ')} — these are readable through PostgREST `
        + 'by anyone holding the anon key').toEqual([])
    })

    it('is NOT FORCE on every one — FORCE would break the app, not secure it', async () => {
      // FORCE ROW LEVEL SECURITY applies RLS to the table OWNER too. The owner
      // connection is the only path the app itself uses (withTransaction), and
      // fn_audit's SECURITY DEFINER writes run as the function owner — so a
      // well-meaning FORCE added by a future migration would take the whole
      // application down while looking like a hardening step.
      const { rows } = await db.query(
        `SELECT relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
          WHERE n.nspname = 'public' AND c.relkind = 'r'
            AND c.relforcerowsecurity = true AND c.relname = ANY($1::text[])`,
        [PLATFORM_TABLES],
      )
      expect(rows.map((r) => r.relname)).toEqual([])
    })

    it('exposes NOTHING to anon — no policy names that role', async () => {
      const { rows } = await db.query(
        `SELECT tablename, policyname, cmd, roles::text[] AS roles FROM pg_policies
          WHERE schemaname = 'public' AND tablename = ANY($1::text[])`,
        [PLATFORM_TABLES],
      )
      const anonPolicies = rows.filter(
        (r) => (r.roles as string[]).some((x) => x === 'anon' || x === 'public'))
      expect(anonPolicies.map((r) => `${r.tablename}.${r.policyname}`),
        'a policy admits anon (or PUBLIC, which includes anon)').toEqual([])
    })

    it('grants NO WRITE to anon or authenticated anywhere', async () => {
      // RLS enabled + no matching policy = deny, so the posture is normally
      // "no policies at all". The two audit tables are the documented exception
      // and they are SELECT-only; a policy admitting INSERT/UPDATE/DELETE/ALL to
      // either role would be a REST write path into the platform's own records.
      const { rows } = await db.query(
        `SELECT tablename, policyname, cmd, roles::text[] AS roles FROM pg_policies
          WHERE schemaname = 'public' AND tablename = ANY($1::text[]) AND cmd <> 'SELECT'`,
        [PLATFORM_TABLES],
      )
      const writable = rows.filter(
        (r) => (r.roles as string[]).some(
          (x) => x === 'anon' || x === 'authenticated' || x === 'public'))
      expect(writable.map((r) => `${r.tablename}.${r.policyname} (${r.cmd})`)).toEqual([])
    })

    it('lets only the two DOCUMENTED tables carry an authenticated read', async () => {
      const { rows } = await db.query(
        `SELECT tablename, policyname, roles::text[] AS roles FROM pg_policies
          WHERE schemaname = 'public' AND tablename = ANY($1::text[]) AND cmd = 'SELECT'`,
        [PLATFORM_TABLES],
      )
      const undocumented = rows
        .filter((r) => (r.roles as string[]).includes('authenticated'))
        .map((r) => r.tablename as string)
        .filter((t) => !(t in DOCUMENTED_AUTHENTICATED_READS))
      expect([...new Set(undocumented)],
        'a table grew an authenticated SELECT policy without a recorded reason').toEqual([])
    })

    // The two lists are the weak point of this pin, so they are themselves
    // pinned — an allowlist rots in exactly two ways, and both are checkable.
    describe('the lists stay honest', () => {
      it('ships POSTURE_EXCLUSIONS empty', () => {
        // Not a style assertion. Every name here is a platform table deliberately
        // left REST-readable; if that is ever genuinely right, deleting this
        // assertion is the deliberate act that admits it.
        expect(Object.keys(POSTURE_EXCLUSIONS)).toEqual([])
      })

      it.each(Object.keys(POSTURE_EXCLUSIONS))(
        'excludes %s with a reason, and only if a migration creates it', (t) => {
          expect(POSTURE_EXCLUSIONS[t].trim().length).toBeGreaterThan(20)
          expect(platformTables().concat(Object.keys(POSTURE_EXCLUSIONS))).toContain(t)
        })

      it.each(Object.keys(DOCUMENTED_AUTHENTICATED_READS))(
        '%s still actually has the authenticated read it is documented for', async (t) => {
          // A stale entry reads as a deliberate exposure that no longer exists,
          // which sends the next reader hunting a hole that was already closed —
          // and quietly widens what the assertion above will tolerate.
          const { rows } = await db.query(
            `SELECT 1 FROM pg_policies WHERE schemaname = 'public' AND tablename = $1
              AND cmd = 'SELECT' AND 'authenticated' = ANY(roles::text[])`, [t])
          expect(rows.length, `${t} is documented as carrying an authenticated SELECT policy, `
            + 'but has none — delete the entry').toBe(1)
        })
    })
  })
})
