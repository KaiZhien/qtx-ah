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
// 2025010* migrations). Per the implementation plan
// (docs/superpowers/plans/2026-07-17-weeks-1-2-foundation-and-demo.md, line 54),
// every platform-schema migration is dated 2026-07-18 or later; every legacy DLMS
// migration (including several also dated 2026-07-06 through 2026-07-16) is dated
// strictly earlier. That is the real boundary — filtering by a bare `202607`
// prefix (as an earlier draft of this file did) would also sweep up those legacy
// 2026-07-06..16 DLMS migrations, which reference tables (`device`, DLMS's own
// `app_user`) that don't exist in this bare test database and would fail immediately.
const PLATFORM_MIGRATIONS_FROM = '20260718000000'

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

    const dir = join(process.cwd(), 'supabase/migrations')
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql') && f >= PLATFORM_MIGRATIONS_FROM)
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
