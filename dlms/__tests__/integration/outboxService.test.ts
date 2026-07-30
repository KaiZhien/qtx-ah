import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import { PERMISSION_MATRIX } from '@/modules/shared/authz/catalog'

/**
 * Schema-level contract for the transactional outbox (spec §5.5) and for the
 * automation principal that drains it.
 *
 * The system actor exists because a cross-department handoff cannot run as the
 * human who triggered it: a manufacturing operator moving a device
 * ready_for_delivery → shipped spawns a LOGISTICS task, and taskService
 * refuses to link a task into a module the actor cannot enter. So the drain
 * needs its own principal — and the point of these assertions is that its
 * resolved authority is exactly two permissions, not "operator minus whatever
 * the migration remembered to revoke".
 */
const SYSTEM_ACTOR_ID = '22222222-2222-2222-2222-222222222222'
const SYSTEM_ACTOR_PERMISSIONS = ['create_records', 'view_records']
const ALL_MODULES = [
  'engineering', 'finance', 'logistics', 'manufacturing', 'maintenance', 'tasks', 'admin',
]

type ResolvedActor = {
  id: string
  role_key: string
  module_access: string[]
  active: boolean
  role_permissions: string[]
  granted_overrides: string[]
  revoked_overrides: string[]
}

let db: Client

beforeAll(async () => {
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
})
afterAll(async () => { await db.end() })

/** Folds overrides into the role grants exactly as modules/shared/authz/actor.ts does. */
const effectivePermissions = (row: ResolvedActor): string[] => {
  const set = new Set(row.role_permissions)
  for (const p of row.granted_overrides) set.add(p)
  for (const p of row.revoked_overrides) set.delete(p)
  return [...set].sort()
}

const resolveSystemActor = async (): Promise<ResolvedActor> => {
  const { rows } = await db.query<ResolvedActor>(
    `SELECT * FROM fn_resolve_actor_by_user_id($1)`, [SYSTEM_ACTOR_ID])
  expect(rows).toHaveLength(1)
  return rows[0]
}

describe('outbox schema', () => {
  it('creates the outbox table', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name='outbox'`)
    expect(rows.map((r) => r.table_name)).toEqual(['outbox'])
  })

  it('starts a new event unprocessed with zero attempts', async () => {
    const { rows } = await db.query<{ attempts: number; processed_at: string | null }>(
      `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload, created_by)
       VALUES ('device', gen_random_uuid(), 'device_status_changed', '{}'::jsonb, $1)
       RETURNING attempts, processed_at, occurred_at`, [SYSTEM_ACTOR_ID])
    expect(rows[0].attempts).toBe(0)
    expect(rows[0].processed_at).toBeNull()
    await db.query(`DELETE FROM outbox`)
  })

  it('records the human who caused the event, not just the effect', async () => {
    const { rows } = await db.query<{ column_name: string; is_nullable: string }>(
      `SELECT column_name, is_nullable FROM information_schema.columns
        WHERE table_schema='public' AND table_name='outbox' AND column_name='created_by'`)
    expect(rows[0]).toMatchObject({ column_name: 'created_by', is_nullable: 'NO' })
  })

  it('indexes only the unprocessed rows, ordered for the drain', async () => {
    const { rows } = await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='outbox'`)
    const partial = rows.find((r) => /WHERE \(processed_at IS NULL\)/.test(r.indexdef))
    expect(partial, `no partial index found in:\n${rows.map((r) => r.indexdef).join('\n')}`)
      .toBeDefined()
    expect(partial!.indexdef).toMatch(/\(occurred_at\)/)
  })

  it('denies REST access via RLS with no policy', async () => {
    const { rows } = await db.query<{ relrowsecurity: boolean; policies: string }>(
      `SELECT c.relrowsecurity,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::text AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname='public' AND c.relname='outbox'`)
    expect(rows[0].relrowsecurity).toBe(true)
    expect(rows[0].policies).toBe('0')
  })

  it('is audit-attached', async () => {
    const { rows } = await db.query(
      `SELECT 1 FROM pg_trigger WHERE tgrelid = 'public.outbox'::regclass AND NOT tgisinternal`)
    expect(rows.length).toBeGreaterThan(0)
  })
})

describe('fn_resolve_actor_by_user_id', () => {
  it('returns the identical row shape as fn_resolve_actor', async () => {
    const { rows } = await db.query<{ fname: string; result: string }>(
      `SELECT p.proname AS fname, pg_get_function_result(p.oid) AS result
         FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
        WHERE n.nspname='public'
          AND p.proname IN ('fn_resolve_actor','fn_resolve_actor_by_user_id')
        ORDER BY p.proname`)
    expect(rows).toHaveLength(2)
    expect(rows[0].result).toBe(rows[1].result)
  })

  it('is not executable by PUBLIC, anon or authenticated', async () => {
    const { rows } = await db.query<{ grantee: string; ok: boolean }>(
      `SELECT g AS grantee,
              has_function_privilege(g, 'public.fn_resolve_actor_by_user_id(uuid)', 'EXECUTE') AS ok
         FROM unnest(ARRAY['anon','authenticated','service_role']) AS g`)
    const by = Object.fromEntries(rows.map((r) => [r.grantee, r.ok]))
    expect(by.anon).toBe(false)
    expect(by.authenticated).toBe(false)
    expect(by.service_role).toBe(true)
  })
})

describe('the automation system actor', () => {
  it('has no login path', async () => {
    const { rows } = await db.query<{ auth_user_id: string | null; active: boolean }>(
      `SELECT auth_user_id, active FROM app_user WHERE id = $1`, [SYSTEM_ACTOR_ID])
    expect(rows).toHaveLength(1)
    expect(rows[0].auth_user_id).toBeNull()
    expect(rows[0].active).toBe(true)
  })

  it('resolves to EXACTLY view_records + create_records', async () => {
    const actor = await resolveSystemActor()
    expect(actor.role_key).toBe('operator')
    expect(effectivePermissions(actor)).toEqual([...SYSTEM_ACTOR_PERMISSIONS].sort())
  })

  it('narrows the operator role by revocation, leaving nothing un-revoked', async () => {
    const actor = await resolveSystemActor()
    // Every operator permission is either kept on purpose or explicitly revoked.
    const expectedRevokes = PERMISSION_MATRIX.operator
      .filter((p) => !SYSTEM_ACTOR_PERMISSIONS.includes(p))
      .sort()
    expect([...actor.revoked_overrides].sort()).toEqual(expectedRevokes)
    expect(actor.granted_overrides).toEqual([])
  })

  it('can enter every module, so a handoff can cross any department boundary', async () => {
    const actor = await resolveSystemActor()
    expect([...actor.module_access].sort()).toEqual([...ALL_MODULES].sort())
  })

  /**
   * fn_seed_system_actor() is called from BOTH the migration and platform_seed.sql
   * (the migration applies before the seed, so its own call finds no `operator` role
   * and no-ops). That dual call site is only safe because the function is idempotent
   * — so assert it, rather than assuming it.
   */
  it('is seeded idempotently, which is what makes the dual call site safe', async () => {
    const snapshot = async () => ({
      user: (await db.query(
        `SELECT id, auth_user_id, email, full_name, role_id, module_access, active,
                created_by, updated_by, version
           FROM app_user WHERE id = $1`, [SYSTEM_ACTOR_ID])).rows,
      overrides: (await db.query(
        `SELECT p.key, o.granted, o.reason, o.expires_at, o.deleted_at, o.version
           FROM user_permission_override o JOIN permission p ON p.id = o.permission_id
          WHERE o.user_id = $1 ORDER BY p.key`, [SYSTEM_ACTOR_ID])).rows,
      audit: (await db.query(
        `SELECT count(*)::int AS n FROM audit_log
          WHERE table_name IN ('app_user','user_permission_override')`)).rows[0].n,
    })

    const before = await snapshot()
    expect(before.user).toHaveLength(1)
    expect(before.overrides.length).toBeGreaterThan(0)

    const { rows } = await db.query<{ id: string }>(`SELECT fn_seed_system_actor() AS id`)
    expect(rows[0].id).toBe(SYSTEM_ACTOR_ID)   // reports what it resolved, for psql debugging

    expect(await snapshot()).toEqual(before)   // no new rows, no new audit noise
  })

  it('no-ops instead of erroring when the operator role does not exist yet', async () => {
    // The migration's own call site hits exactly this case on a from-scratch database:
    // it runs before platform_seed.sql has created any role. Simulated by hiding the
    // `operator` key rather than deleting the row — app_user.role_id and audit_log
    // both reference it, and the guard reads the key, so this exercises the same branch.
    await db.query('BEGIN')
    try {
      await db.query(`UPDATE role SET key = 'operator__hidden' WHERE key = 'operator'`)
      const { rows } = await db.query<{ id: string | null }>(
        `SELECT fn_seed_system_actor() AS id`)
      expect(rows[0].id).toBeNull()
    } finally {
      await db.query('ROLLBACK')   // leave the shared database exactly as found
    }
  })
})
