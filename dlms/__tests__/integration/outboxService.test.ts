import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PERMISSION_MATRIX } from '@/modules/shared/authz/catalog'
import type { Actor } from '@/modules/shared/authz/catalog'
import { getPool } from '@/lib/db/pool'
import { listAssignableUsers } from '@/app/(platform)/tasks/directory'

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
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL   // for getPool() in the directory read
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
})
afterAll(async () => { await db.end(); await getPool().end() })

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

/**
 * Runs `fn` inside a transaction that is always rolled back.
 *
 * Every test below that corrupts the principal — grants the operator role a permission,
 * flips a revocation, expires one, soft-deletes the actor — has to do so against the
 * SHARED test database. Wrapping in an aborted transaction is what keeps those tests from
 * being order-dependent landmines for every later file in the suite.
 */
const inRollback = async (fn: () => Promise<void>): Promise<void> => {
  await db.query('BEGIN')
  try {
    await fn()
  } finally {
    await db.query('ROLLBACK')
  }
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

  /**
   * Asserting merely that SOME non-internal trigger exists proves nothing: swapping
   * fn_attach_audit('outbox') for any unrelated trigger keeps that green. Name the
   * trigger, then prove it actually reaches audit_log.
   */
  it('is audit-attached, and the trigger really writes to audit_log', async () => {
    const { rows: triggers } = await db.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'public.outbox'::regclass AND NOT tgisinternal`)
    expect(triggers.map((t) => t.tgname)).toContain('trg_audit_outbox')

    const { rows: inserted } = await db.query<{ id: string }>(
      `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload, created_by)
       VALUES ('device', gen_random_uuid(), 'device_status_changed', '{}'::jsonb, $1)
       RETURNING id`, [SYSTEM_ACTOR_ID])
    const { rows: audit } = await db.query<{ action: string }>(
      `SELECT action FROM audit_log WHERE table_name = 'outbox' AND row_id = $1`,
      [inserted[0].id])
    expect(audit.map((a) => a.action)).toEqual(['insert'])
    await db.query(`DELETE FROM outbox WHERE id = $1`, [inserted[0].id])
  })

  /**
   * last_error is the drain's record of WHY a row is still unprocessed. Dropping the
   * column entirely left every other assertion in this file green, so exercise the
   * failed-attempt write the drain will actually perform: attempts up, error recorded,
   * processed_at still NULL so the row stays in the partial index for the next pass.
   */
  it('records a failed attempt without marking the row processed', async () => {
    const { rows: inserted } = await db.query<{ id: string }>(
      `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload, created_by)
       VALUES ('device', gen_random_uuid(), 'device_status_changed', '{}'::jsonb, $1)
       RETURNING id`, [SYSTEM_ACTOR_ID])
    const { rows } = await db.query<{
      attempts: number; last_error: string; processed_at: string | null
    }>(
      `UPDATE outbox SET attempts = attempts + 1, last_error = $2
        WHERE id = $1 RETURNING attempts, last_error, processed_at`,
      [inserted[0].id, 'no task_template_key on this transition'])
    expect(rows[0]).toMatchObject({
      attempts: 1,
      last_error: 'no task_template_key on this transition',
      processed_at: null,
    })
    await db.query(`DELETE FROM outbox WHERE id = $1`, [inserted[0].id])
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

  /** A caller must be able to tell "no such actor" from "an actor with no permissions". */
  it('returns no row at all for an unknown user id', async () => {
    const { rows } = await db.query(
      `SELECT * FROM fn_resolve_actor_by_user_id('00000000-0000-0000-0000-000000000000')`)
    expect(rows).toEqual([])
  })

  /**
   * `active` is `u.active AND u.deleted_at IS NULL` in both this function and its
   * fn_resolve_actor sibling. Dropping the deleted_at half left this file green, which is
   * exactly the divergence-from-sibling the mirror was written to prevent — so pin both
   * halves independently.
   */
  it('reports a soft-deleted actor as inactive', async () => {
    await inRollback(async () => {
      await db.query(`UPDATE app_user SET deleted_at = now() WHERE id = $1`, [SYSTEM_ACTOR_ID])
      expect((await resolveSystemActor()).active).toBe(false)
    })
  })

  it('reports a deactivated actor as inactive', async () => {
    await inRollback(async () => {
      await db.query(`UPDATE app_user SET active = false WHERE id = $1`, [SYSTEM_ACTOR_ID])
      expect((await resolveSystemActor()).active).toBe(false)
    })
  })

  /**
   * Both override subqueries filter `expires_at IS NULL OR expires_at > now()`, so a lapsed
   * override stops applying immediately rather than waiting for the hourly sweep. Every
   * seeded override has a NULL expiry, so without this case deleting the predicate from
   * both subqueries changes nothing observable.
   */
  it('stops applying a revocation once it has expired', async () => {
    await inRollback(async () => {
      await db.query(
        `UPDATE user_permission_override SET expires_at = now() - interval '1 minute'
          WHERE user_id = $1
            AND permission_id = (SELECT id FROM permission WHERE key = 'edit_records')`,
        [SYSTEM_ACTOR_ID])
      const actor = await resolveSystemActor()
      expect(actor.revoked_overrides).not.toContain('edit_records')
      expect(effectivePermissions(actor)).toContain('edit_records')
    })
  })

  /**
   * The grant-folding branch is never exercised by the system actor — it is forbidden from
   * holding a granted override at all (see the guard trigger below) — so prove it on an
   * ordinary user, where an additive override is the legitimate spec §3.4 mechanism.
   */
  it('folds an additive override into an ordinary user’s permissions', async () => {
    await inRollback(async () => {
      const { rows: created } = await db.query<{ id: string }>(
        `INSERT INTO app_user (email, full_name, role_id, module_access, active)
         SELECT 'outbox-grant-fold@test.local', 'Grant Fold', r.id, ARRAY['tasks']::text[], true
           FROM role r WHERE r.key = 'viewer' RETURNING id`)
      const userId = created[0].id
      await db.query(
        `INSERT INTO user_permission_override (user_id, permission_id, granted, reason, created_by)
         SELECT $1, p.id, true, 'exercises the grant-folding branch', $1
           FROM permission p WHERE p.key = 'export_data'`, [userId])

      const { rows } = await db.query<ResolvedActor>(
        `SELECT * FROM fn_resolve_actor_by_user_id($1)`, [userId])
      expect(rows).toHaveLength(1)
      expect(rows[0].granted_overrides).toEqual(['export_data'])
      expect(rows[0].revoked_overrides).toEqual([])
      expect(effectivePermissions(rows[0]))
        .toEqual([...PERMISSION_MATRIX.viewer, 'export_data'].sort())
    })
  })

  /** An expired GRANT must stop applying too — the same predicate, the other subquery. */
  it('stops applying an additive override once it has expired', async () => {
    await inRollback(async () => {
      const { rows: created } = await db.query<{ id: string }>(
        `INSERT INTO app_user (email, full_name, role_id, module_access, active)
         SELECT 'outbox-grant-expiry@test.local', 'Grant Expiry', r.id, ARRAY['tasks']::text[], true
           FROM role r WHERE r.key = 'viewer' RETURNING id`)
      const userId = created[0].id
      await db.query(
        `INSERT INTO user_permission_override
           (user_id, permission_id, granted, reason, expires_at, created_by)
         SELECT $1, p.id, true, 'lapsed additive override', now() - interval '1 minute', $1
           FROM permission p WHERE p.key = 'export_data'`, [userId])

      const { rows } = await db.query<ResolvedActor>(
        `SELECT * FROM fn_resolve_actor_by_user_id($1)`, [userId])
      expect(rows[0].granted_overrides).toEqual([])
      expect(effectivePermissions(rows[0])).not.toContain('export_data')
    })
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

  /**
   * The productive branch of fn_seed_system_actor() — the one the migration's own
   * `SELECT fn_seed_system_actor();` takes on the cloud project, where `operator` already
   * exists. The harness only ever exercises the NULL branch from that call site (migrations
   * apply before the seed), so derive it here from an empty override set instead.
   */
  it('rebuilds the revocations from nothing, as the migration call site does on cloud', async () => {
    await inRollback(async () => {
      await db.query(`DELETE FROM user_permission_override WHERE user_id = $1`, [SYSTEM_ACTOR_ID])
      const stripped = await resolveSystemActor()
      expect(stripped.revoked_overrides).toEqual([])
      expect(effectivePermissions(stripped)).toEqual([...PERMISSION_MATRIX.operator].sort())

      const { rows } = await db.query<{ id: string }>(`SELECT fn_seed_system_actor() AS id`)
      expect(rows[0].id).toBe(SYSTEM_ACTOR_ID)
      expect(effectivePermissions(await resolveSystemActor()))
        .toEqual([...SYSTEM_ACTOR_PERMISSIONS].sort())
    })
  })

  /** ...and that the migration really carries that call, not just the function definition. */
  it('is called by the migration itself, not merely defined there', async () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20260731000000_platform_outbox.sql'), 'utf8')
    expect(sql).toMatch(/^SELECT fn_seed_system_actor\(\);\s*$/m)
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

/**
 * The narrowness above is only worth asserting if it is ENFORCED rather than merely
 * initialized. Roles, permissions and overrides are all runtime-editable data
 * (20260718000000_platform_rbac.sql), and the Super Admin console edits them through
 * modules/admin/services/roleService.ts — so every one of these is a path a real admin
 * can take, by ticking one box, without ever intending to touch automation.
 */
describe('the system actor cannot be widened at runtime', () => {
  const permissionId = async (key: string) =>
    (await db.query<{ id: string }>(`SELECT id FROM permission WHERE key = $1`, [key])).rows[0].id

  /**
   * Fix 1: roleService.setRolePermission's INSERT, verbatim. Nothing re-runs the seed
   * afterwards — trg_reconcile_system_actor has to have produced the matching revocation
   * inside the very same transaction, or the principal has silently gained delete_records.
   */
  it('revokes a permission the operator role newly gains, with no re-seed', async () => {
    await inRollback(async () => {
      await db.query(
        `INSERT INTO role_permission (role_id, permission_id)
         SELECT r.id, p.id FROM role r, permission p
          WHERE r.key = 'operator' AND p.key = 'delete_records'`)

      const actor = await resolveSystemActor()
      expect(actor.role_permissions).toContain('delete_records')     // the role really widened
      expect(actor.revoked_overrides).toContain('delete_records')    // ...and was matched
      expect(effectivePermissions(actor)).toEqual([...SYSTEM_ACTOR_PERMISSIONS].sort())
    })
  })

  /**
   * The same, through the UPDATE arm of the trigger: re-pointing an existing grant at
   * `operator`. restore_records is held by admin and not by operator, so this widens the
   * role without inserting a row — the case an INSERT-only trigger would miss.
   */
  it('revokes a permission moved onto the operator role by UPDATE', async () => {
    await inRollback(async () => {
      await db.query(
        `UPDATE role_permission SET role_id = (SELECT id FROM role WHERE key = 'operator')
          WHERE role_id = (SELECT id FROM role WHERE key = 'admin')
            AND permission_id = $1`, [await permissionId('restore_records')])
      const actor = await resolveSystemActor()
      expect(actor.role_permissions).toContain('restore_records')
      expect(actor.revoked_overrides).toContain('restore_records')
      expect(effectivePermissions(actor)).toEqual([...SYSTEM_ACTOR_PERMISSIONS].sort())
    })
  })

  /**
   * Fix 2, repair half. The documented contract for user_permission_override is that
   * writers upsert — "removal is a soft delete ... re-granting resurrects the same row via
   * UPSERT". With ON CONFLICT DO NOTHING the seed skipped any conflicting row, so a
   * revocation that had been flipped or soft-deleted survived every re-run forever.
   */
  it('heals a revocation that was flipped to granted or soft-deleted', async () => {
    await inRollback(async () => {
      // Reach deliberately past the guard trigger: the two defences are independent, and
      // this one must hold for whatever state the table is already in — including a row
      // the guard would now refuse to create (e.g. one written before this migration).
      await db.query(
        `ALTER TABLE user_permission_override DISABLE TRIGGER trg_forbid_system_actor_grant`)
      await db.query(
        `UPDATE user_permission_override SET granted = true, deleted_at = NULL
          WHERE user_id = $1 AND permission_id = $2`,
        [SYSTEM_ACTOR_ID, await permissionId('assign_tasks')])
      await db.query(
        `UPDATE user_permission_override SET deleted_at = now()
          WHERE user_id = $1 AND permission_id = $2`,
        [SYSTEM_ACTOR_ID, await permissionId('edit_records')])
      await db.query(
        `ALTER TABLE user_permission_override ENABLE TRIGGER trg_forbid_system_actor_grant`)

      expect(effectivePermissions(await resolveSystemActor()))
        .toEqual([...SYSTEM_ACTOR_PERMISSIONS, 'assign_tasks', 'edit_records'].sort())

      await db.query(`SELECT fn_seed_system_actor()`)
      expect(effectivePermissions(await resolveSystemActor()))
        .toEqual([...SYSTEM_ACTOR_PERMISSIONS].sort())
    })
  })

  /** ...and an expiry, the third way a standing revocation can quietly stop applying. */
  it('heals a revocation that was given an expiry', async () => {
    await inRollback(async () => {
      await db.query(
        `UPDATE user_permission_override SET expires_at = now() - interval '1 minute'
          WHERE user_id = $1 AND permission_id = $2`,
        [SYSTEM_ACTOR_ID, await permissionId('upload_files')])
      expect(effectivePermissions(await resolveSystemActor())).toContain('upload_files')

      await db.query(`SELECT fn_seed_system_actor()`)
      expect(effectivePermissions(await resolveSystemActor()))
        .toEqual([...SYSTEM_ACTOR_PERMISSIONS].sort())
    })
  })

  /**
   * Fix 2, prevention half. Healing makes a widening temporary; this makes it
   * unreachable. Both arms matter: addOverride's upsert INSERTs when no row exists and
   * UPDATEs (setting granted = EXCLUDED.granted, deleted_at = NULL) when one does.
   */
  it('refuses an additive override on the principal — INSERT arm', async () => {
    await expect(db.query(
      `INSERT INTO user_permission_override (user_id, permission_id, granted, reason, created_by)
       SELECT $1, p.id, true, 'widening the automation principal', $1
         FROM permission p WHERE p.key = 'delete_records'`, [SYSTEM_ACTOR_ID]))
      .rejects.toThrow(/automation principal/i)
  })

  it('refuses an additive override on the principal — UPDATE arm', async () => {
    await expect(db.query(
      `UPDATE user_permission_override SET granted = true, deleted_at = NULL
        WHERE user_id = $1
          AND permission_id = (SELECT id FROM permission WHERE key = 'assign_tasks')`,
      [SYSTEM_ACTOR_ID]))
      .rejects.toThrow(/automation principal/i)
  })

  /** The guard is targeted, not a blanket ban: ordinary users keep spec §3.4 overrides. */
  it('still allows an additive override on an ordinary user', async () => {
    await inRollback(async () => {
      const { rows: created } = await db.query<{ id: string }>(
        `INSERT INTO app_user (email, full_name, role_id, module_access, active)
         SELECT 'outbox-guard-scope@test.local', 'Guard Scope', r.id, ARRAY['tasks']::text[], true
           FROM role r WHERE r.key = 'viewer' RETURNING id`)
      await expect(db.query(
        `INSERT INTO user_permission_override (user_id, permission_id, granted, reason, created_by)
         SELECT $1, p.id, true, 'ordinary per-user exception', $1
           FROM permission p WHERE p.key = 'export_data'`, [created[0].id]))
        .resolves.toBeDefined()
    })
  })

  /**
   * Fix 3. "auth_user_id stays NULL: this principal must have NO login path" was a comment,
   * not a rule — the UPDATE below used to succeed. platform_seed.sql plans a first-login
   * linking path, so the day it lands, an auth.users row for system@qtx.internal must not
   * be able to turn the automation principal into somebody's account.
   */
  it('refuses to be given a login path', async () => {
    await expect(db.query(
      `UPDATE app_user SET auth_user_id = gen_random_uuid() WHERE id = $1`, [SYSTEM_ACTOR_ID]))
      .rejects.toThrow(/app_user_system_actor_has_no_login/)
  })

  it('still allows an ordinary user to be linked to a login', async () => {
    await inRollback(async () => {
      const { rows: created } = await db.query<{ id: string }>(
        `INSERT INTO app_user (email, full_name, role_id, module_access, active)
         SELECT 'outbox-login-link@test.local', 'Login Link', r.id, ARRAY['tasks']::text[], true
           FROM role r WHERE r.key = 'viewer' RETURNING id`)
      await expect(db.query(
        `UPDATE app_user SET auth_user_id = gen_random_uuid() WHERE id = $1`, [created[0].id]))
        .resolves.toBeDefined()
    })
  })
})

/**
 * The principal is an ordinary active app_user row, so every "list the staff" query in the
 * app now sees it. The task assignee picker is the one that matters: it is offered to
 * anyone holding assign_tasks, and a task assigned to an identity nobody logs in as would
 * sit in its queue forever.
 */
describe('the assignee directory', () => {
  const assigner: Actor = {
    id: '00000000-0000-0000-0000-0000000000aa', roleKey: 'manager',
    permissions: new Set(['assign_tasks']), moduleAccess: new Set(['tasks']), active: true,
  }

  it('never offers the automation principal as an assignee', async () => {
    const options = await listAssignableUsers(assigner)
    expect(options.length).toBeGreaterThan(0)   // the exclusion did not empty the picker
    expect(options.map((o) => o.id)).not.toContain(SYSTEM_ACTOR_ID)
    expect(options.map((o) => o.name)).not.toContain('QTX Automation (system)')
  })
})
