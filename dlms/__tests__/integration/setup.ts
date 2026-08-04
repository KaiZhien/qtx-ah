import { Client } from 'pg'
import { AsyncLocalStorage } from 'node:async_hooks'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { installIncrementalCache } from './incrementalCache'

const TEST_DB = 'postgresql://postgres:testpw@localhost:55432/qtx_test'
process.env.TEST_DATABASE_URL = TEST_DB

// Next reads AsyncLocalStorage off the GLOBAL, not off `node:async_hooks`, and
// substitutes a FakeAsyncLocalStorage that throws from `run()` when it is absent
// (client/components/async-local-storage.js). The real Next server sets it during
// boot; nothing does under vitest, so `unstable_cache` blows up with "Invariant:
// AsyncLocalStorage accessed in runtime where it is not available" the moment it
// runs its callback. This is the same two lines Next's own
// server/node-environment.js runs, and it must happen HERE rather than in a test
// file: the fake is chosen once, at the module scope of the file above, so by the
// time a test imports anything from `next/cache` the choice is already made.
if (typeof (globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage !== 'function') {
  ;(globalThis as { AsyncLocalStorage?: unknown }).AsyncLocalStorage = AsyncLocalStorage
}

// `unstable_cache` (every dashboard widget is wrapped in one) throws outside a
// Next request unless a cache backend is present. See incrementalCache.ts for why
// this is a real in-memory backend rather than a bypass.
installIncrementalCache()

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
 *
 * `connectionString` is a parameter, and exported, for the ONE case that needs a
 * database of its own rather than the shared one: reconcileComponents.test.ts
 * counts the platform side globally (see scripts/reconcile.ts) and so cannot
 * tolerate component rows other test files leave in `public`. It stands up a
 * private database and bootstraps it through this same function, so the two can
 * never drift into being migrated differently.
 */
export async function migratePlatformSchema(connectionString: string = TEST_DB) {
  const client = new Client({ connectionString })
  await client.connect()
  try {
    const { rows } = await client.query(`SELECT to_regclass('public.role') AS reg`)
    if (rows[0].reg) return // already migrated by an earlier setup() run against this container

    // The platform migrations GRANT/REVOKE against Supabase's platform-provisioned
    // `anon`/`authenticated`/`service_role` roles, same as every pre-existing DLMS
    // migration in this directory — on a real Supabase project those roles always
    // already exist. The bare postgres:15-alpine test container has none of them,
    // so the test harness stands in minimal equivalents here rather than teaching
    // the migration itself to special-case a non-Supabase environment.
    //
    // service_role additionally gets BYPASSRLS: that is a real, load-bearing
    // property of Supabase's service_role (see this migration's own header comment
    // and 20260710120100_rls_defense_in_depth.sql's "the app talks to Postgres as
    // service_role, bypasses RLS") — every admin-client path in this codebase runs
    // as service_role and never gets blocked by RLS. Without it here, a service_role
    // INSERT that a REAL Supabase project allows (recordAuthEvent() on auth_event)
    // would instead fail on a ROW-level-security violation in this harness, masking
    // the actual property under test (the table-level GRANT).
    await client.query(`
      DO $$
      BEGIN
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
          CREATE ROLE anon NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
          CREATE ROLE authenticated NOLOGIN;
        END IF;
        IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN
          CREATE ROLE service_role NOLOGIN BYPASSRLS;
        END IF;
      END $$;
    `)

    // Reproduce this repo's real default-privilege bootstrap (mirrors
    // 20250101000008_grants.sql:20-24) BEFORE applying any migration below. On a
    // real Supabase project every public-schema table is born with these grants
    // already standing, including audit_log/auth_event — that pre-existing grant
    // is exactly what platform_audit's REVOKE statements claw back. Skip this step
    // and the harness proves nothing: `authenticated`/`service_role` would never
    // have held a grant on audit_log in the first place, so deleting the REVOKE
    // line entirely would leave every test green — the suite would be proving the
    // absence of a grant, not the presence of a revoke, and the exact class of
    // regression (Defect 1: service_role left un-revoked) would ship undetected
    // again. ALTER DEFAULT PRIVILEGES only binds tables the SAME role later
    // creates, so this must run on this same `client` connection (postgres) before
    // the migration files below run their CREATE TABLE statements as that role.
    await client.query(`
      ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT ON TABLES TO anon;
      ALTER DEFAULT PRIVILEGES IN SCHEMA public
        GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO authenticated, service_role;
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

await migratePlatformSchema(TEST_DB)
