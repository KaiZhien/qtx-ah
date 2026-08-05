import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import { resolvePlatformLogin } from '@/modules/shared/auth/firstLogin'

/**
 * The unit test beside this one (__tests__/platform/auth/firstLogin.test.ts)
 * pins the SHAPE of the three statements. This one proves they mean what they
 * say against a real Postgres: that the link actually lands, that the audit
 * trigger attributes it to the user who just signed in (an FK to app_user that
 * a mocked tx cannot fail), and that the email match is genuinely
 * case-insensitive rather than incidentally so in a lowercase fixture.
 *
 * It stands up its OWN unlinked row rather than exercising the seeded bootstrap
 * Super Admin, even though that row is the real-world instance of this path:
 * forty-odd files share this database, several of them assert over the seeded
 * admin, and linking its auth_user_id here would leak into them.
 */

let db: Client
let unlinkedId: string
let retiredId: string

const AUTH_A = 'aaaaaaaa-0000-4000-8000-00000000000a'
const AUTH_B = 'bbbbbbbb-0000-4000-8000-00000000000b'

/** Mixed case on purpose — an admin types invites, Supabase Auth lowercases them. */
const EMAIL = 'First.Login@Test.Local'

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()

  const insertUnlinked = async (email: string, deleted: boolean) => (await db.query<{ id: string }>(
    `INSERT INTO app_user (email, full_name, role_id, module_access, active, invited_at, deleted_at)
     SELECT $1, 'First Login Test', r.id, ARRAY['manufacturing']::text[], true, now(),
            CASE WHEN $2 THEN now() ELSE NULL END
       FROM role r WHERE r.key = 'viewer' RETURNING id`,
    [email, deleted])).rows[0].id

  unlinkedId = await insertUnlinked(EMAIL, false)
  retiredId = await insertUnlinked('retired.login@test.local', true)
})

afterAll(async () => {
  await db.query(`DELETE FROM audit_log WHERE row_id = ANY($1::uuid[])`, [[unlinkedId, retiredId]])
  await db.query(`DELETE FROM app_user WHERE id = ANY($1::uuid[])`, [[unlinkedId, retiredId]])
  await db.end()
  await getPool().end()
})

/**
 * `last_login_at` is read as TEXT, and compared below in SQL rather than in JS.
 * Two consecutive logins against a local database land microseconds apart, and
 * both node-postgres' Date mapping and Date.parse round to whole milliseconds —
 * so a JS comparison reported the stamp as unchanged when it had in fact moved.
 */
const rowOf = async (id: string) => (await db.query<{
  auth_user_id: string | null; last_login_at: string | null; version: number
}>(`SELECT auth_user_id, last_login_at::text AS last_login_at, version
      FROM app_user WHERE id = $1`, [id])).rows[0]

describe('resolvePlatformLogin against a real database', () => {
  it('returns null for an address with no app_user row', async () => {
    expect(await resolvePlatformLogin(AUTH_A, 'nobody@test.local')).toBeNull()
  })

  it('refuses to adopt a SOFT-DELETED row — a retired employee is not a new hire', async () => {
    expect(await resolvePlatformLogin(AUTH_A, 'retired.login@test.local')).toBeNull()
    expect((await rowOf(retiredId)).auth_user_id).toBeNull()
  })

  it('links auth_user_id on the first login, matching the address case-insensitively', async () => {
    expect(await resolvePlatformLogin(AUTH_A, EMAIL.toLowerCase())).toBe(unlinkedId)

    const row = await rowOf(unlinkedId)
    expect(row.auth_user_id).toBe(AUTH_A)
    expect(row.last_login_at).not.toBeNull()
    // A login is not an admin edit: bumping version would stale out an admin's
    // open edit form every time its subject signed in.
    expect(row.version).toBe(1)
  })

  it('attributes the link to the user who signed in, not to nobody', async () => {
    const { rows } = await db.query<{ actor_id: string; changed_columns: string[] }>(
      `SELECT actor_id, changed_columns FROM audit_log
        WHERE table_name = 'app_user' AND row_id = $1
        ORDER BY occurred_at DESC LIMIT 1`, [unlinkedId])
    expect(rows[0].actor_id).toBe(unlinkedId)
    expect(rows[0].changed_columns).toContain('auth_user_id')
  })

  it('stamps the second login without touching the established link', async () => {
    const before = await rowOf(unlinkedId)
    expect(await resolvePlatformLogin(AUTH_A, EMAIL)).toBe(unlinkedId)

    const after = await rowOf(unlinkedId)
    expect(after.auth_user_id).toBe(AUTH_A)
    const { rows } = await db.query<{ moved: boolean }>(
      `SELECT $1::timestamptz > $2::timestamptz AS moved`,
      [after.last_login_at, before.last_login_at])
    expect(rows[0].moved).toBe(true)
  })

  it('refuses a DIFFERENT auth account claiming an address that is already linked', async () => {
    expect(await resolvePlatformLogin(AUTH_B, EMAIL)).toBeNull()
    expect((await rowOf(unlinkedId)).auth_user_id).toBe(AUTH_A)
  })
})
