import { Client } from 'pg'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

const TEST_DB = 'postgresql://postgres:testpw@localhost:55432/qtx_test'
process.env.TEST_DATABASE_URL = TEST_DB

// The new "operations platform" schema (roles, permissions, app_user, audit_log, ...)
// lives in the SAME dlms/supabase/migrations directory as the pre-existing DLMS
// device-tracking migrations, but the two are destined for different Supabase
// projects (DLMS's `bkvbqopcebfjfiemqdvk` vs. the new `qtx-ops-platform` — see
// docs/superpowers/specs/2026-07-17-ops-platform-design.md). They also collide by
// name: DLMS already has its own `app_user` and `audit_log` tables (from the
// 2025010* migrations).
//
// Provenance, not a date range, is what actually distinguishes platform migrations
// from legacy DLMS ones: every platform migration carries a `platform_` prefix
// after its timestamp (this task's two, plus `20260718000002_platform_resolve_actor.sql`
// renamed to preserve the convention, and more to come). A date-based filter
// (`f >= '20260718000000'`, as an earlier draft of this file used) has two bugs:
// JS string comparison means ANY letter-initial filename (e.g. a hypothetical
// `rollback.sql` or `seed_dev.sql` dropped into this directory) also passes the
// comparison since letters sort after digits; and DLMS is a live codebase still
// receiving its own migrations, so its first migration dated on or after
// 2026-07-18 would get swept into this platform test database and collide on
// `app_user`/`audit_log` with the legacy DLMS schema those migrations expect.
// Matching the `platform_` prefix directly closes both holes regardless of when
// either migration set is dated.
const PLATFORM_MIGRATION_RE = /^\d{14}_platform_.*\.sql$/

/**
 * Applies every platform migration, in filename order, plus the deterministic
 * seed, to the ephemeral qtx_test database.
 *
 * Vitest's `setupFiles` only evaluates the module body — it does not call any
 * export automatically. So this file performs the migration itself at module
 * scope (top-level await) rather than exporting a `setup()` for something else
 * to invoke; nothing else needs to import from this file for it to take effect.
 *
 * Idempotent by design (checks whether `role` already exists before applying
 * anything): if a future integration-test file shares this setupFiles entry and
 * Vitest re-evaluates this module for that file against the same live Postgres
 * container, re-running `CREATE TABLE` would otherwise fail with "already exists".
 */
async function migratePlatformSchema() {
  const client = new Client({ connectionString: TEST_DB })
  await client.connect()
  try {
    const { rows } = await client.query(`SELECT to_regclass('public.role') AS reg`)
    if (rows[0].reg) return // already migrated by an earlier setup() run against this container

    // The platform migrations GRANT/REVOKE against Supabase's platform-provisioned
    // `anon`/`authenticated` roles, same as every pre-existing DLMS migration in
    // this directory — on a real Supabase project those roles always already
    // exist. The bare postgres:15-alpine test container has neither, so the test
    // harness stands in minimal equivalents here rather than teaching the
    // migration itself to special-case a non-Supabase environment.
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated NOLOGIN;
        END IF;
      END $$;
    `)

    const dir = join(process.cwd(), 'supabase/migrations')
    const files = readdirSync(dir)
      .filter((f) => PLATFORM_MIGRATION_RE.test(f))
      .sort()
    for (const f of files) {
      await client.query(readFileSync(join(dir, f), 'utf8'))
    }
    await client.query(readFileSync(join(process.cwd(), 'supabase/seed/platform_seed.sql'), 'utf8'))
  } finally {
    await client.end()
  }
}

await migratePlatformSchema()
