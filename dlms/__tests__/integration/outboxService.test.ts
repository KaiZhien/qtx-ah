import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { PERMISSION_MATRIX } from '@/modules/shared/authz/catalog'
import type { Actor } from '@/modules/shared/authz/catalog'
import { getPool } from '@/lib/db/pool'
import { listAssignableUsers } from '@/app/(platform)/tasks/directory'
import {
  SYSTEM_ACTOR_ID as EXPORTED_SYSTEM_ACTOR_ID, loadSystemActor,
} from '@/modules/shared/authz/actor'
import { drainOutbox, MAX_ATTEMPTS } from '@/modules/shared/outbox/services/outboxService'
import { updateUserAccess } from '@/modules/admin/services/userService'

// actor.ts imports the Supabase server client for the HUMAN login path (loadActor).
// Nothing under test here goes near it, and importing next/headers in a bare node
// environment has no request to bind to — so stub it, exactly as taskService.test.ts does.
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

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
    const { rows } = await db.query<{ id: string; attempts: number; processed_at: string | null }>(
      `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload, created_by)
       VALUES ('device', gen_random_uuid(), 'device_status_changed', '{}'::jsonb, $1)
       RETURNING id, attempts, processed_at, occurred_at`, [SYSTEM_ACTOR_ID])
    expect(rows[0].attempts).toBe(0)
    expect(rows[0].processed_at).toBeNull()
    await db.query(`DELETE FROM outbox WHERE id = $1`, [rows[0].id])
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
   *
   * On a throwaway user, not the system actor: the guard trigger below now refuses ANY
   * non-NULL expires_at on the principal's revocations, so exercising this branch there would
   * mean fighting the guard (e.g. disabling it) to test something that has nothing to do with
   * the principal in the first place. This test is purely about fn_resolve_actor_by_user_id's
   * expiry filtering, which applies identically to every actor — pinning it on an ordinary
   * user keeps that distinction honest, and it is exactly this predicate that a prior pass
   * deleted from both subqueries while leaving the suite green.
   */
  it('stops applying a revocation once it has expired', async () => {
    await inRollback(async () => {
      const { rows: created } = await db.query<{ id: string }>(
        `INSERT INTO app_user (email, full_name, role_id, module_access, active)
         SELECT 'outbox-revoke-expiry@test.local', 'Revoke Expiry', r.id, ARRAY['tasks']::text[], true
           FROM role r WHERE r.key = 'viewer' RETURNING id`)
      const userId = created[0].id
      await db.query(
        `INSERT INTO user_permission_override
           (user_id, permission_id, granted, reason, expires_at, created_by)
         SELECT $1, p.id, false, 'lapsed revocation', now() - interval '1 minute', $1
           FROM permission p WHERE p.key = 'download_files'`, [userId])

      const { rows } = await db.query<ResolvedActor>(
        `SELECT * FROM fn_resolve_actor_by_user_id($1)`, [userId])
      expect(rows[0].revoked_overrides).toEqual([])
      expect(effectivePermissions(rows[0])).toContain('download_files')
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

  /**
   * ...and an expiry, the third way a standing revocation can quietly stop applying. The
   * guard trigger now refuses a non-NULL expires_at on the principal outright (see below), so
   * — same as the flip/soft-delete case above — getting the table into that corrupted state
   * at all means reaching deliberately past the guard: the healing defence must hold for
   * whatever state the row is already in (e.g. one written before this migration existed),
   * independent of whether the guard would have allowed writing it today.
   */
  it('heals a revocation that was given an expiry', async () => {
    await inRollback(async () => {
      await db.query(
        `ALTER TABLE user_permission_override DISABLE TRIGGER trg_forbid_system_actor_grant`)
      await db.query(
        `UPDATE user_permission_override SET expires_at = now() - interval '1 minute'
          WHERE user_id = $1 AND permission_id = $2`,
        [SYSTEM_ACTOR_ID, await permissionId('upload_files')])
      await db.query(
        `ALTER TABLE user_permission_override ENABLE TRIGGER trg_forbid_system_actor_grant`)
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

  /**
   * `expires_at` is a third widening route, alongside `granted` and a login path: an admin
   * can call roleService.addOverride with an expiry on one of the principal's EXISTING
   * revocations, and the permission returns the instant it lapses with nothing guaranteed to
   * heal it before then (only the next role_permission write or a manual re-seed does). For a
   * standing identity nobody logs in as and nobody watches, that is a scheduled privilege
   * escalation, not a legitimate configuration — so the guard refuses it outright, the same as
   * an outright grant.
   */
  it('refuses an expiring revocation on the principal', async () => {
    await expect(db.query(
      `UPDATE user_permission_override SET expires_at = now() + interval '1 day'
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

  /**
   * Fix 4, the hole the first three left open. Every guard above defends the OVERRIDES,
   * the role×permission matrix and the login path; none of them pinned `app_user.role_id`
   * — and the principal's authority is DERIVED from whichever role that column points at.
   * Re-pointing it at `super_admin` gave it sixteen permissions, and fn_seed_system_actor()
   * did not heal it, because the revocations it re-derives come from `operator`.
   *
   * Asserted at the schema level first (the trigger is the enforcement), then through the
   * console path that could actually reach it (below).
   */
  it('refuses to be re-pointed at another role', async () => {
    await expect(db.query(
      `UPDATE app_user SET role_id = (SELECT id FROM role WHERE key = 'super_admin')
        WHERE id = $1`, [SYSTEM_ACTOR_ID]))
      .rejects.toThrow(/automation principal/i)
  })

  /** Not only escalation: any role at all, including a narrower one, is refused. */
  it('refuses to be re-pointed at a narrower role either', async () => {
    await expect(db.query(
      `UPDATE app_user SET role_id = (SELECT id FROM role WHERE key = 'viewer')
        WHERE id = $1`, [SYSTEM_ACTOR_ID]))
      .rejects.toThrow(/automation principal/i)
  })

  /**
   * module_access is pinned by the same trigger because updateUserAccess writes it in the
   * same UPDATE. Removing a module does not widen the principal — it BREAKS it: a handoff
   * crosses departments by definition, so createTaskInTx would refuse every one of them.
   */
  it('refuses to have a module taken away', async () => {
    await expect(db.query(
      `UPDATE app_user SET module_access = ARRAY['tasks']::text[] WHERE id = $1`,
      [SYSTEM_ACTOR_ID]))
      .rejects.toThrow(/automation principal/i)
  })

  /** Compared as a SET, so re-ordering the same modules is not a change. */
  it('accepts the same modules in a different order', async () => {
    await inRollback(async () => {
      await expect(db.query(
        `UPDATE app_user SET module_access = ARRAY['admin','tasks','maintenance',
           'manufacturing','logistics','finance','engineering']::text[] WHERE id = $1`,
        [SYSTEM_ACTOR_ID]))
        .resolves.toBeDefined()
    })
  })

  /**
   * The pin must not brick ordinary maintenance on the row. Deactivating the principal is
   * a visible, recoverable stop (the drain throws, naming the migration) and stays legal;
   * the runbook tells an operator to reactivate it.
   */
  it('still allows the principal to be deactivated and reactivated', async () => {
    await inRollback(async () => {
      await expect(db.query(`UPDATE app_user SET active = false WHERE id = $1`, [SYSTEM_ACTOR_ID]))
        .resolves.toBeDefined()
      await expect(db.query(`UPDATE app_user SET active = true WHERE id = $1`, [SYSTEM_ACTOR_ID]))
        .resolves.toBeDefined()
    })
  })

  /** Targeted, not a blanket freeze: ordinary users are still re-roled from the console. */
  it('still allows an ordinary user to be re-roled', async () => {
    await inRollback(async () => {
      const { rows: created } = await db.query<{ id: string }>(
        `INSERT INTO app_user (email, full_name, role_id, module_access, active)
         SELECT 'outbox-role-pin@test.local', 'Role Pin', r.id, ARRAY['tasks']::text[], true
           FROM role r WHERE r.key = 'viewer' RETURNING id`)
      await expect(db.query(
        `UPDATE app_user SET role_id = (SELECT id FROM role WHERE key = 'operator')
          WHERE id = $1`, [created[0].id]))
        .resolves.toBeDefined()
    })
  })
})

/**
 * The route the pin above actually closes, exercised end to end.
 *
 * updateUserAccess is reachable by any holder of `manage_users` for ANY user id it is
 * given — assertNotSelfEscalation only compares against the ACTOR's own id — and
 * listUsers does not exclude the automation principal, so it is visible in the Super
 * Admin console's user table to pick. Before the pin, this exact call succeeded and left
 * the principal holding the full super_admin set; `roleKey === 'super_admin'` then
 * short-circuits moduleAllowed() in taskService and canSeeTask() in visibility.
 */
describe('the admin console cannot widen the system actor', () => {
  const superAdminActor = (id: string): Actor => ({
    id, roleKey: 'super_admin',
    permissions: new Set(['manage_users']), moduleAccess: new Set(['admin']),
    active: true,
  })

  it('refuses updateUserAccess re-roling the principal to super_admin', async () => {
    const saId = (await db.query<{ id: string }>(
      `SELECT u.id FROM app_user u JOIN role r ON r.id = u.role_id
        WHERE r.key = 'super_admin' AND u.active AND u.deleted_at IS NULL LIMIT 1`)).rows[0].id
    const version = (await db.query<{ version: number }>(
      `SELECT version FROM app_user WHERE id = $1`, [SYSTEM_ACTOR_ID])).rows[0].version

    await expect(updateUserAccess(
      superAdminActor(saId), SYSTEM_ACTOR_ID, { roleKey: 'super_admin' }, version))
      .rejects.toThrow(/automation principal/i)

    // ...and the refusal rolled the whole transaction back: unchanged, un-bumped.
    const after = await resolveSystemActor()
    expect(after.role_key).toBe('operator')
    expect(effectivePermissions(after)).toEqual([...SYSTEM_ACTOR_PERMISSIONS].sort())
    expect((await db.query<{ version: number }>(
      `SELECT version FROM app_user WHERE id = $1`, [SYSTEM_ACTOR_ID])).rows[0].version)
      .toBe(version)
  })

  it('refuses updateUserAccess narrowing the principal’s module access', async () => {
    const saId = (await db.query<{ id: string }>(
      `SELECT u.id FROM app_user u JOIN role r ON r.id = u.role_id
        WHERE r.key = 'super_admin' AND u.active AND u.deleted_at IS NULL LIMIT 1`)).rows[0].id
    const version = (await db.query<{ version: number }>(
      `SELECT version FROM app_user WHERE id = $1`, [SYSTEM_ACTOR_ID])).rows[0].version

    await expect(updateUserAccess(
      superAdminActor(saId), SYSTEM_ACTOR_ID, { moduleAccess: ['tasks'] }, version))
      .rejects.toThrow(/automation principal/i)

    expect((await resolveSystemActor()).module_access.sort()).toEqual([...ALL_MODULES].sort())
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

/**
 * loadSystemActor is the drain's only way in. Everything above proves the DATABASE
 * seeds the principal correctly; these prove the application resolves it correctly —
 * including the two deployment faults it must refuse to degrade around.
 */
describe('loadSystemActor', () => {
  it('exports the id the migration actually seeds', () => {
    expect(EXPORTED_SYSTEM_ACTOR_ID).toBe(SYSTEM_ACTOR_ID)
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20260731000000_platform_outbox.sql'), 'utf8')
    expect(sql).toContain(`'${EXPORTED_SYSTEM_ACTOR_ID}'`)
  })

  it('resolves to EXACTLY view_records + create_records, in every module', async () => {
    const actor = await loadSystemActor()
    expect(actor.id).toBe(SYSTEM_ACTOR_ID)
    expect(actor.roleKey).toBe('operator')
    expect([...actor.permissions].sort()).toEqual([...SYSTEM_ACTOR_PERMISSIONS].sort())
    expect([...actor.moduleAccess].sort()).toEqual([...ALL_MODULES].sort())
    expect(actor.active).toBe(true)
  })

  /**
   * An inactive principal is a deployment fault, not a degraded mode: `can()` returns
   * false for every permission of an inactive actor, so a drain that shrugged and carried
   * on would turn every event into a PermissionError and burn all five attempts on each.
   * Committed rather than rolled back, because loadSystemActor reads through the POOL —
   * a different connection, which cannot see an uncommitted change on `db`.
   */
  it('throws, naming the migration that seeds it, when the principal is inactive', async () => {
    await db.query(`UPDATE app_user SET active = false WHERE id = $1`, [SYSTEM_ACTOR_ID])
    try {
      await expect(loadSystemActor()).rejects.toThrow(/20260731000000_platform_outbox/)
    } finally {
      await db.query(`UPDATE app_user SET active = true WHERE id = $1`, [SYSTEM_ACTOR_ID])
    }
    expect((await loadSystemActor()).active).toBe(true)   // really restored
  })

  /**
   * The principal cannot simply be deleted to simulate this — app_user.id is referenced
   * by user_permission_override, audit_log and outbox.created_by. So make the resolver
   * itself return nothing, then restore it from the migration's own text (rather than a
   * hand-copied body, which could drift from what actually ships).
   */
  it('throws, naming the migration that seeds it, when the principal is missing', async () => {
    const sql = readFileSync(
      join(process.cwd(), 'supabase/migrations/20260731000000_platform_outbox.sql'), 'utf8')
    const original = sql.match(
      /CREATE OR REPLACE FUNCTION fn_resolve_actor_by_user_id[\s\S]*?\n\$\$;/)
    expect(original, 'could not extract fn_resolve_actor_by_user_id from the migration')
      .not.toBeNull()

    await db.query(`
      CREATE OR REPLACE FUNCTION fn_resolve_actor_by_user_id(p_app_user_id uuid)
      RETURNS TABLE (
        id uuid, role_key text, module_access text[], active boolean,
        role_permissions text[], granted_overrides text[], revoked_overrides text[]
      ) LANGUAGE sql STABLE SECURITY DEFINER SET search_path = public, pg_temp AS $fn$
        SELECT NULL::uuid, NULL::text, NULL::text[], NULL::boolean,
               NULL::text[], NULL::text[], NULL::text[] WHERE false;
      $fn$`)
    try {
      await expect(loadSystemActor()).rejects.toThrow(/20260731000000_platform_outbox/)
    } finally {
      await db.query(original![0])
    }
    expect((await loadSystemActor()).id).toBe(SYSTEM_ACTOR_ID)   // really restored
  })
})

/**
 * The drain (spec §5.5). Its whole reason to exist is EXACTLY ONCE: an event becomes a
 * handoff task, and it becomes exactly one handoff task, no matter how often the drain
 * runs or how it is interrupted.
 *
 * Every test here uses a fresh `gen_random_uuid()` as the device id and asserts through
 * the task_link, so tests cannot see each other's tasks in the shared database.
 */
describe('drainOutbox', () => {
  const HUMAN_NAME = 'Dana Drain'
  let humanId: string

  beforeAll(async () => {
    humanId = (await db.query<{ id: string }>(`
      INSERT INTO app_user (email, full_name, role_id, department, module_access, active)
      SELECT 'outbox-drain-human@test.local', $1, r.id, 'Manufacturing',
             ARRAY['manufacturing','tasks']::text[], true
        FROM role r WHERE r.key = 'operator' RETURNING id`, [HUMAN_NAME])).rows[0].id
  })

  /**
   * A drain claims from the whole table, so every case starts from an empty backlog — but
   * "empty" is scoped to THIS file's rows, keyed on the human actor created above and
   * therefore covering exactly what emit() writes. A table-global DELETE would also destroy
   * deviceWriteService.test.ts's outbox rows, which is only survivable while
   * `fileParallelism: false` holds and that file happens to clean up after itself; the
   * `parked` counts below are unaffected because no other file ever writes attempts > 0.
   */
  beforeEach(async () => { await db.query(`DELETE FROM outbox WHERE created_by = $1`, [humanId]) })

  const emit = async (opts: {
    templateKey?: string
    deviceSn?: string | null
    attempts?: number
    occurredAt?: string
    payload?: unknown
    aggregateType?: string
    eventType?: string
  } = {}) => {
    const deviceId = (await db.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0].id
    const payload = opts.payload ?? {
      taskTemplateKey: opts.templateKey ?? 'logistics_prepare_delivery',
      fromStatus: 'ready_for_delivery',
      toStatus: 'shipped',
      reason: 'buyer collected early',
      notifyRoles: ['manager'],
      deviceSn: opts.deviceSn === undefined ? `SN-${deviceId.slice(0, 8)}` : opts.deviceSn,
      pcbaASnLegacy: null,
    }
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload, created_by,
                           attempts, occurred_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6, COALESCE($7::timestamptz, now()))
       RETURNING id`,
      [opts.aggregateType ?? 'device', deviceId, opts.eventType ?? 'device_status_changed',
       JSON.stringify(payload), humanId, opts.attempts ?? 0, opts.occurredAt ?? null])
    return { outboxId: rows[0].id, deviceId }
  }

  const tasksFor = async (deviceId: string) => (await db.query<{
    id: string; title: string; description: string; department: string | null
    priority: string; status: string; assignee_id: string | null; created_by: string
    entity_type: string; module: string
  }>(
    `SELECT t.id, t.title, t.description, t.department, t.priority, t.status,
            t.assignee_id, t.created_by, l.entity_type, l.module
       FROM task t JOIN task_link l ON l.task_id = t.id
      WHERE l.entity_id = $1`, [deviceId])).rows

  const outboxRow = async (id: string) => (await db.query<{
    attempts: number; last_error: string | null; processed_at: string | null; created_by: string
  }>(
    `SELECT attempts, last_error, processed_at, created_by FROM outbox WHERE id = $1`,
    [id])).rows[0]

  it('turns an event into a department-queued task linked to the device', async () => {
    const { outboxId, deviceId } = await emit({ deviceSn: 'SN-HANDOFF-1' })

    const result = await drainOutbox()
    expect(result).toMatchObject({ claimed: 1, processed: 1, failed: 0, parked: 0 })
    expect(result.failures).toEqual([])

    const tasks = await tasksFor(deviceId)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      title: 'Prepare delivery for SN-HANDOFF-1',
      department: 'Logistics',
      module: 'logistics',
      entity_type: 'device',
      status: 'open',
      priority: 'normal',
      // The system principal holds create_records but deliberately NOT assign_tasks:
      // a handoff lands in a department queue, unassigned.
      assignee_id: null,
      created_by: SYSTEM_ACTOR_ID,
    })
    // changedByName is NOT carried in the payload — the drain must resolve it from
    // the outbox row's created_by. A name in the description is the proof.
    expect(tasks[0].description).toContain(HUMAN_NAME)
    expect(tasks[0].description).toContain('buyer collected early')

    const row = await outboxRow(outboxId)
    expect(row.processed_at).not.toBeNull()
    expect(row).toMatchObject({ attempts: 0, last_error: null, created_by: humanId })
  })

  it('does nothing on a second drain — a processed event is never redelivered', async () => {
    const { deviceId } = await emit()
    await drainOutbox()

    const second = await drainOutbox()
    expect(second).toMatchObject({ claimed: 0, processed: 0, failed: 0, parked: 0 })
    expect(await tasksFor(deviceId)).toHaveLength(1)
  })

  /**
   * THE exactly-once proof, and the reason createTask grew a Tx-accepting variant.
   *
   * withTransaction takes a SEPARATE pooled connection, so a drain that called the
   * transaction-owning createTask() would commit the task on one connection and stamp
   * processed_at on another. Interrupt the stamp and that split becomes visible: the task
   * survives, the event stays unprocessed, and the next drain hands off a SECOND time.
   *
   * The trigger below is that interruption, made deterministic. It fires only on the
   * transition to processed, so the drain's separate attempts/last_error write still lands.
   */
  it('creates the task and stamps processed_at in ONE transaction', async () => {
    const { outboxId, deviceId } = await emit()
    await db.query(`
      CREATE OR REPLACE FUNCTION test_block_processed_stamp() RETURNS trigger
      LANGUAGE plpgsql AS $fn$ BEGIN
        RAISE EXCEPTION 'simulated crash between the task insert and the processed stamp';
      END $fn$`)
    await db.query(`
      CREATE TRIGGER trg_test_block_processed_stamp BEFORE UPDATE ON outbox
        FOR EACH ROW WHEN (OLD.processed_at IS NULL AND NEW.processed_at IS NOT NULL)
        EXECUTE FUNCTION test_block_processed_stamp()`)
    try {
      const result = await drainOutbox()
      expect(result).toMatchObject({ claimed: 1, processed: 0, failed: 1 })
      expect(result.failures[0]).toMatchObject({ outboxId })
      expect(result.failures[0].error).toMatch(/simulated crash/)
    } finally {
      await db.query(`DROP TRIGGER IF EXISTS trg_test_block_processed_stamp ON outbox`)
      await db.query(`DROP FUNCTION IF EXISTS test_block_processed_stamp()`)
    }

    // The stamp rolled back, so the task must have rolled back WITH it. A task here
    // means the two writes were in different transactions — and the retry below would
    // then create a duplicate.
    expect(await tasksFor(deviceId)).toEqual([])
    expect(await outboxRow(outboxId)).toMatchObject({ attempts: 1, processed_at: null })

    // ...and the retry, now unobstructed, produces exactly ONE task.
    await drainOutbox()
    expect(await tasksFor(deviceId)).toHaveLength(1)
  })

  /**
   * A failed attempt is recorded in its OWN transaction, AFTER the row's transaction has
   * rolled back and released the row — so between the two, another claimant can take the
   * row and process it. An unguarded `attempts + 1, last_error = ...` then lands on an
   * already-processed row: exactly-once still holds (the handoff task is created once),
   * but the event is left permanently carrying a last_error it did not earn, and Task 5's
   * runbook triages on exactly that column.
   *
   * The interleave is real, not simulated. `rival` issues its stamp while the drain still
   * holds the row lock, so it sits in that lock's queue and is granted the instant the
   * drain's transaction rolls back — ahead of the drain, which still needs a connection, a
   * BEGIN and a set_config before its failure record can execute. The advisory lock is what
   * makes that window wide enough to arrange: it parks the drain mid-transaction, holding
   * the row, until this test has the rival queued behind it.
   */
  it('never records a failure against a row processed while the failure was in flight',
    async () => {
      const { outboxId, deviceId } = await emit({ deviceSn: 'SN-LATE-FAILURE' })
      const GATE = 918273645

      // Fails the drain at the task insert — AFTER it has claimed and locked the outbox
      // row. pg_advisory_xact_lock, not the session variant: it must be released by the
      // rollback below, or it would leak onto a pooled connection for every later test.
      await db.query(`
        CREATE OR REPLACE FUNCTION test_block_handoff_task() RETURNS trigger
        LANGUAGE plpgsql AS $fn$ BEGIN
          PERFORM pg_advisory_xact_lock(${GATE});
          RAISE EXCEPTION 'simulated failure while the row was still claimed';
        END $fn$`)
      await db.query(`
        CREATE TRIGGER trg_test_block_handoff_task BEFORE INSERT ON task
          FOR EACH ROW WHEN (NEW.title LIKE '%SN-LATE-FAILURE%')
          EXECUTE FUNCTION test_block_handoff_task()`)

      const until = async (predicate: string) => {
        for (let i = 0; i < 600; i++) {
          const { rows } = await db.query<{ ok: boolean }>(`SELECT (${predicate}) AS ok`)
          if (rows[0].ok) return
          await new Promise((r) => setTimeout(r, 25))
        }
        throw new Error(`timed out waiting for: ${predicate}`)
      }

      const rival = new Client({ connectionString: process.env.TEST_DATABASE_URL })
      await rival.connect()
      let drainP: Promise<Awaited<ReturnType<typeof drainOutbox>>> | undefined
      let rivalP: Promise<unknown> | undefined
      try {
        await db.query(`SELECT pg_advisory_lock(${GATE})`)
        drainP = drainOutbox()

        // 1. the drain is parked inside its transaction, still holding the outbox row
        await until(`EXISTS (SELECT 1 FROM pg_locks
                              WHERE locktype = 'advisory' AND objid = ${GATE} AND NOT granted)`)

        // 2. the rival's stamp is queued on that row lock (a wait on the holder's xid)
        rivalP = rival.query(
          `UPDATE outbox SET processed_at = now() WHERE id = $1 AND processed_at IS NULL`,
          [outboxId])
        await until(`EXISTS (SELECT 1 FROM pg_locks
                              WHERE locktype = 'transactionid' AND NOT granted)`)

        // 3. release: the drain raises and rolls back, the rival's stamp lands immediately,
        //    and only then does the drain get to record its failed attempt.
        await db.query(`SELECT pg_advisory_unlock(${GATE})`)

        const result = await drainP
        await rivalP
        expect(result).toMatchObject({ claimed: 1, processed: 0, failed: 1 })
        expect(result.failures[0]).toMatchObject({ outboxId })
        expect(result.failures[0].error).toMatch(/simulated failure/)
      } finally {
        await Promise.allSettled([drainP, rivalP])
        await db.query(`SELECT pg_advisory_unlock_all()`)
        await rival.end()
        await db.query(`DROP TRIGGER IF EXISTS trg_test_block_handoff_task ON task`)
        await db.query(`DROP FUNCTION IF EXISTS test_block_handoff_task()`)
      }

      // The row was processed, so it carries NO failure — not the attempt, not the error.
      const row = await outboxRow(outboxId)
      expect(row.processed_at).not.toBeNull()
      expect(row).toMatchObject({ attempts: 0, last_error: null })
      // ...and the drain's own half really did roll back.
      expect(await tasksFor(deviceId)).toEqual([])
    })

  /** FOR UPDATE SKIP LOCKED, from the other end: two drains, one event, one task. */
  it('never hands the same event to two concurrent drains', async () => {
    const { deviceId } = await emit()
    const [a, b] = await Promise.all([drainOutbox(), drainOutbox()])
    expect(a.processed + b.processed).toBe(1)
    expect(a.failed + b.failed).toBe(0)
    expect(await tasksFor(deviceId)).toHaveLength(1)
  })

  /**
   * A task_template_key in the status graph with no entry in the template registry means
   * the two have drifted apart. That is data, not a crash — record it, retry it, and let
   * the rest of the batch through.
   */
  it('records an unknown template key without stopping a good row in the same drain', async () => {
    const bad = await emit({ templateKey: 'no_such_template', occurredAt: '2026-01-01T00:00:00Z' })
    const good = await emit({ occurredAt: '2026-01-02T00:00:00Z' })

    const result = await drainOutbox()
    expect(result).toMatchObject({ claimed: 2, processed: 1, failed: 1 })
    expect(result.failures).toHaveLength(1)
    expect(result.failures[0].outboxId).toBe(bad.outboxId)
    expect(result.failures[0].error).toMatch(/no_such_template/)

    const badRow = await outboxRow(bad.outboxId)
    expect(badRow).toMatchObject({ attempts: 1, processed_at: null })
    expect(badRow.last_error).toMatch(/no handoff template registered/i)
    expect(await tasksFor(bad.deviceId)).toEqual([])   // nothing half-created

    expect((await outboxRow(good.outboxId)).processed_at).not.toBeNull()
    expect(await tasksFor(good.deviceId)).toHaveLength(1)
  })

  it('records a malformed payload as a retryable failure rather than throwing', async () => {
    const { outboxId, deviceId } = await emit({ payload: { fromStatus: 'ready_for_delivery' } })
    const result = await drainOutbox()
    expect(result).toMatchObject({ claimed: 1, processed: 0, failed: 1 })
    expect(await tasksFor(deviceId)).toEqual([])
    expect((await outboxRow(outboxId)).attempts).toBe(1)
  })

  it('records an event shape it does not handle rather than looping on it forever', async () => {
    const { outboxId } = await emit({ eventType: 'device_scrapped' })
    const result = await drainOutbox()
    expect(result).toMatchObject({ claimed: 1, processed: 0, failed: 1 })
    const row = await outboxRow(outboxId)
    expect(row).toMatchObject({ attempts: 1, processed_at: null })
    expect(row.last_error).toMatch(/device_scrapped/)
  })

  /**
   * A poison event must not consume every drain forever — and it must be VISIBLE while it
   * sits there, which is what `parked` is for. `parked` counts what the drain LEAVES
   * parked, so a row that hits the cap during this very drain is already included.
   */
  it('stops claiming a row at the attempts cap, and reports it as parked', async () => {
    const capped = await emit({ templateKey: 'no_such_template', attempts: MAX_ATTEMPTS })
    const nearlyCapped = await emit({
      templateKey: 'no_such_template', attempts: MAX_ATTEMPTS - 1 })

    const first = await drainOutbox()
    expect(first).toMatchObject({ claimed: 1, processed: 0, failed: 1, parked: 2 })
    expect(first.failures[0].outboxId).toBe(nearlyCapped.outboxId)
    expect(await outboxRow(capped.outboxId)).toMatchObject({
      attempts: MAX_ATTEMPTS, last_error: null,   // never touched: not claimed
    })
    expect(await outboxRow(nearlyCapped.outboxId)).toMatchObject({ attempts: MAX_ATTEMPTS })

    const second = await drainOutbox()
    expect(second).toMatchObject({ claimed: 0, processed: 0, failed: 0, parked: 2 })
    expect(await tasksFor(capped.deviceId)).toEqual([])
  })

  it('claims the oldest events first, up to the limit', async () => {
    const first = await emit({ occurredAt: '2026-01-01T00:00:00Z' })
    const second = await emit({ occurredAt: '2026-01-02T00:00:00Z' })
    const third = await emit({ occurredAt: '2026-01-03T00:00:00Z' })

    expect(await drainOutbox({ limit: 2 })).toMatchObject({ claimed: 2, processed: 2 })
    expect((await outboxRow(first.outboxId)).processed_at).not.toBeNull()
    expect((await outboxRow(second.outboxId)).processed_at).not.toBeNull()
    expect((await outboxRow(third.outboxId)).processed_at).toBeNull()

    expect(await drainOutbox()).toMatchObject({ claimed: 1, processed: 1 })
    expect((await outboxRow(third.outboxId)).processed_at).not.toBeNull()
  })

  /**
   * occurred_at alone is not a total order. now() is transaction-scoped, so every event
   * written by one transaction shares an identical timestamp — and with `ORDER BY
   * occurred_at ... LIMIT n` the cut between tied rows is then the planner's choice, which
   * is free to be the same choice every pass. Under sustained load a row on the wrong side
   * of it is deferred indefinitely. `ORDER BY occurred_at, id` makes the order total, so
   * these four drain in a fixed, exhaustive sequence.
   */
  it('breaks a tie on occurred_at so no row can be deferred forever', async () => {
    const tied = '2026-02-01T00:00:00Z'
    const emitted = []
    for (let i = 0; i < 4; i++) emitted.push(await emit({ occurredAt: tied }))

    const drainedOrder: string[] = []
    for (let i = 0; i < emitted.length; i++) {
      expect(await drainOutbox({ limit: 1 })).toMatchObject({ claimed: 1, processed: 1 })
      for (const e of emitted) {
        if (!drainedOrder.includes(e.outboxId)
            && (await outboxRow(e.outboxId)).processed_at !== null) {
          drainedOrder.push(e.outboxId)
        }
      }
      expect(drainedOrder).toHaveLength(i + 1)   // exactly one more row moved each pass
    }
    expect(drainedOrder).toEqual([...emitted.map((e) => e.outboxId)].sort())
  })

  /**
   * outbox has no updated_by, so with no app.actor_id GUC fn_audit falls back to
   * created_by — and every drain write would read as the human who changed the status.
   * The drain owes withTransaction(systemActorId, ...) precisely to prevent that.
   */
  it('attributes its writes to the automation principal, not to the human', async () => {
    const { outboxId, deviceId } = await emit()
    await drainOutbox()

    const { rows: stamp } = await db.query<{ actor_id: string }>(
      `SELECT actor_id FROM audit_log
        WHERE table_name = 'outbox' AND row_id = $1 AND action = 'update'`, [outboxId])
    expect(stamp).toHaveLength(1)
    expect(stamp[0].actor_id).toBe(SYSTEM_ACTOR_ID)

    const taskId = (await tasksFor(deviceId))[0].id
    const { rows: taskAudit } = await db.query<{ actor_id: string }>(
      `SELECT actor_id FROM audit_log WHERE table_name = 'task' AND row_id = $1`, [taskId])
    expect(taskAudit.map((a) => a.actor_id)).toEqual([SYSTEM_ACTOR_ID])

    // ...and the CAUSE is still recorded: the outbox row still names the human.
    expect((await outboxRow(outboxId)).created_by).toBe(humanId)
  })

  /**
   * The one thing that IS fatal. A drain that shrugged at an unresolvable principal would
   * either create nothing while reporting success, or burn every event's attempts against
   * a PermissionError until they all parked.
   */
  it('throws, and writes nothing, when the automation principal cannot be resolved', async () => {
    const { outboxId, deviceId } = await emit()
    await db.query(`UPDATE app_user SET active = false WHERE id = $1`, [SYSTEM_ACTOR_ID])
    try {
      await expect(drainOutbox()).rejects.toThrow(/20260731000000_platform_outbox/)
    } finally {
      await db.query(`UPDATE app_user SET active = true WHERE id = $1`, [SYSTEM_ACTOR_ID])
    }
    expect(await tasksFor(deviceId)).toEqual([])
    expect(await outboxRow(outboxId)).toMatchObject({ attempts: 0, processed_at: null })

    // The event survived the outage intact and drains normally afterwards.
    expect(await drainOutbox()).toMatchObject({ claimed: 1, processed: 1 })
    expect(await tasksFor(deviceId)).toHaveLength(1)
  })
})
