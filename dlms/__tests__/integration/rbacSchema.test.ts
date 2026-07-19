import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'

let db: Client
let superAdminId: string

// The exact §3.2 role -> permission-key matrix. Pinning the FULL sorted set per role (not just
// per-role or aggregate counts) is what catches a misdirected grant: swapping one permission
// between two roles leaves every count-based assertion untouched but changes this comparison.
const EXPECTED_ROLE_PERMISSIONS: Record<string, string[]> = {
  super_admin: [
    'view_records', 'create_records', 'edit_records', 'delete_records', 'restore_records',
    'change_device_status', 'assign_tasks', 'approve_requests', 'sign_off_repairs',
    'upload_files', 'download_files', 'export_data', 'import_data', 'view_finance',
    'manage_finance', 'view_buyer_details', 'log_usage_service', 'view_audit_record',
    'view_full_audit', 'manage_users', 'manage_roles_permissions', 'manage_vocabularies',
    'manage_settings', 'request_full_export',
  ],
  admin: [
    'view_records', 'create_records', 'edit_records', 'delete_records', 'restore_records',
    'change_device_status', 'assign_tasks', 'approve_requests', 'sign_off_repairs',
    'upload_files', 'download_files', 'export_data', 'import_data', 'view_finance',
    'manage_finance', 'view_buyer_details', 'log_usage_service', 'view_audit_record',
    'view_full_audit', 'manage_vocabularies',
  ],
  manager: [
    'view_records', 'create_records', 'edit_records', 'delete_records', 'change_device_status',
    'assign_tasks', 'approve_requests', 'sign_off_repairs', 'upload_files', 'download_files',
    'export_data', 'import_data', 'view_finance', 'view_buyer_details', 'log_usage_service',
    'view_audit_record',
  ],
  operator: [
    'view_records', 'create_records', 'edit_records', 'change_device_status', 'assign_tasks',
    'upload_files', 'download_files', 'view_buyer_details', 'log_usage_service', 'view_audit_record',
  ],
  finance: [
    'view_records', 'create_records', 'edit_records', 'assign_tasks', 'upload_files',
    'download_files', 'export_data', 'view_finance', 'manage_finance', 'view_buyer_details',
    'view_audit_record',
  ],
  viewer: ['view_records', 'download_files'],
}

/** Inserts a throwaway viewer-role app_user row for use as an fn_audit test subject/actor. */
async function seedTestUser(label: string): Promise<string> {
  const { rows } = await db.query(
    `INSERT INTO app_user (email, full_name, role_id, department, module_access)
     SELECT $1, $2, r.id, 'Engineering', '{}'
     FROM role r WHERE r.key = 'viewer'
     RETURNING id`,
    [`fn-audit-${label}@example.com`, `Test Subject (${label})`],
  )
  return rows[0].id as string
}

beforeAll(async () => {
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  const { rows } = await db.query(`SELECT id FROM app_user WHERE email = 'reetmitra8@gmail.com'`)
  superAdminId = rows[0].id
})
afterAll(async () => { await db.end() })

describe('platform RBAC schema', () => {
  it('seeds exactly the six roles from spec §3.1', async () => {
    const { rows } = await db.query('SELECT key FROM role ORDER BY key')
    expect(rows.map((r) => r.key)).toEqual([
      'admin', 'finance', 'manager', 'operator', 'super_admin', 'viewer',
    ])
  })

  it('seeds exactly the 24 permissions from spec §3.2', async () => {
    const { rows } = await db.query('SELECT count(*)::int AS n FROM permission')
    expect(rows[0].n).toBe(24)
  })

  it('grants super_admin every permission', async () => {
    const { rows } = await db.query(`
      SELECT count(*)::int AS n FROM role_permission rp
      JOIN role r ON r.id = rp.role_id WHERE r.key = 'super_admin'`)
    expect(rows[0].n).toBe(24)
  })

  it('refuses to delete a system role', async () => {
    await expect(db.query(`DELETE FROM role WHERE key = 'super_admin'`))
      .rejects.toThrow(/system role/i)
  })

  it('requires a reason on every permission override', async () => {
    // created_by is supplied so the CHECK on `reason` is the only thing wrong with this row —
    // previously the test passed because created_by (NOT NULL) was omitted, never exercising
    // the reason CHECK at all.
    await expect(db.query(
      `INSERT INTO user_permission_override (user_id, permission_id, granted, reason, created_by)
       SELECT u.id, p.id, true, NULL, $1
       FROM app_user u, permission p WHERE u.id = $1 AND p.key = 'view_records'`,
      [superAdminId],
    )).rejects.toThrow(/reason/)
  })

  it('rejects a reason below the 3-character lower bound', async () => {
    await expect(db.query(
      `INSERT INTO user_permission_override (user_id, permission_id, granted, reason, created_by)
       SELECT u.id, p.id, true, 'ab', $1
       FROM app_user u, permission p WHERE u.id = $1 AND p.key = 'create_records'`,
      [superAdminId],
    )).rejects.toThrow(/reason/)
  })

  it('accepts a reason exactly at the 3-character lower bound', async () => {
    const { rows } = await db.query(
      `INSERT INTO user_permission_override (user_id, permission_id, granted, reason, created_by)
       SELECT u.id, p.id, true, 'abc', $1
       FROM app_user u, permission p WHERE u.id = $1 AND p.key = 'edit_records'
       RETURNING id`,
      [superAdminId],
    )
    expect(rows).toHaveLength(1)
  })

  // Locks the §3.2 matrix total so a future edit to the seed is caught here rather
  // than discovered downstream. Verified against local Docker Postgres per-role:
  // super_admin=24, admin=20, manager=16, operator=10, finance=11, viewer=2 → 83.
  it('grants exactly 83 role_permission rows across the seeded matrix', async () => {
    const { rows } = await db.query('SELECT count(*)::int AS n FROM role_permission')
    expect(rows[0].n).toBe(83)
  })

  it('grants each role exactly its spec-defined permission set', async () => {
    // Aggregate counts (24/20/16/10/11/2, and the 83 total above) are invariant under a swap:
    // seeding viewer with manage_users instead of download_files leaves every count-based
    // assertion passing. Comparing the exact sorted permission-key set per role is what
    // actually catches a misdirected grant.
    const { rows } = await db.query(`
      SELECT r.key AS role_key, p.key AS perm_key
      FROM role_permission rp
      JOIN role r ON r.id = rp.role_id
      JOIN permission p ON p.id = rp.permission_id`)

    const actual: Record<string, string[]> = {}
    for (const { role_key, perm_key } of rows) {
      (actual[role_key] ??= []).push(perm_key)
    }

    for (const roleKey of Object.keys(EXPECTED_ROLE_PERMISSIONS)) {
      expect(actual[roleKey]?.slice().sort()).toEqual(
        EXPECTED_ROLE_PERMISSIONS[roleKey].slice().sort(),
      )
    }
  })
})

describe('fn_audit()', () => {
  it('attributes the actor from the app.actor_id GUC when set', async () => {
    const subjectId = await seedTestUser('guc-path')
    await db.query(`SELECT set_config('app.actor_id', $1, false)`, [superAdminId])
    try {
      await db.query(`UPDATE app_user SET full_name = 'GUC-attributed update' WHERE id = $1`, [subjectId])
      const { rows } = await db.query(
        `SELECT actor_id FROM audit_log WHERE table_name = 'app_user' AND row_id = $1
         ORDER BY occurred_at DESC LIMIT 1`,
        [subjectId],
      )
      expect(rows[0].actor_id).toBe(superAdminId)
    } finally {
      await db.query(`SELECT set_config('app.actor_id', '', false)`)
    }
  })

  it('falls back to the updated_by/created_by row columns when no GUC is set', async () => {
    const subjectId = await seedTestUser('column-fallback')
    const columnActorId = await seedTestUser('column-fallback-actor')
    // No GUC set for this test (reset defensively in case a prior test left one behind).
    await db.query(`SELECT set_config('app.actor_id', '', false)`)

    await db.query(
      `UPDATE app_user SET full_name = 'Column-attributed update', updated_by = $2 WHERE id = $1`,
      [subjectId, columnActorId],
    )
    const { rows } = await db.query(
      `SELECT actor_id FROM audit_log WHERE table_name = 'app_user' AND row_id = $1
       ORDER BY occurred_at DESC LIMIT 1`,
      [subjectId],
    )
    expect(rows[0].actor_id).toBe(columnActorId)
  })

  it('prefers the GUC over the row column when both are present', async () => {
    const subjectId = await seedTestUser('guc-precedence')
    const columnActorId = await seedTestUser('guc-precedence-column-actor')
    await db.query(`SELECT set_config('app.actor_id', $1, false)`, [superAdminId])
    try {
      await db.query(
        `UPDATE app_user SET full_name = 'GUC beats column', updated_by = $2 WHERE id = $1`,
        [subjectId, columnActorId],
      )
      const { rows } = await db.query(
        `SELECT actor_id FROM audit_log WHERE table_name = 'app_user' AND row_id = $1
         ORDER BY occurred_at DESC LIMIT 1`,
        [subjectId],
      )
      expect(rows[0].actor_id).toBe(superAdminId)
      expect(rows[0].actor_id).not.toBe(columnActorId)
    } finally {
      await db.query(`SELECT set_config('app.actor_id', '', false)`)
    }
  })

  it('writes zero audit rows for a no-op update', async () => {
    const subjectId = await seedTestUser('no-op')
    const { rows: before } = await db.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE table_name = 'app_user' AND row_id = $1`,
      [subjectId],
    )
    await db.query(`UPDATE app_user SET full_name = full_name WHERE id = $1`, [subjectId])
    const { rows: after } = await db.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE table_name = 'app_user' AND row_id = $1`,
      [subjectId],
    )
    expect(after[0].n).toBe(before[0].n)
  })

  it('discriminates soft_delete from an ordinary update', async () => {
    const subjectId = await seedTestUser('action-discrimination')

    await db.query(`UPDATE app_user SET full_name = 'Ordinary update' WHERE id = $1`, [subjectId])
    const { rows: updateRows } = await db.query(
      `SELECT action FROM audit_log WHERE table_name = 'app_user' AND row_id = $1
       ORDER BY occurred_at DESC LIMIT 1`,
      [subjectId],
    )
    expect(updateRows[0].action).toBe('update')

    await db.query(`UPDATE app_user SET deleted_at = now() WHERE id = $1 AND deleted_at IS NULL`, [subjectId])
    const { rows: softDeleteRows } = await db.query(
      `SELECT action FROM audit_log WHERE table_name = 'app_user' AND row_id = $1
       ORDER BY occurred_at DESC LIMIT 1`,
      [subjectId],
    )
    expect(softDeleteRows[0].action).toBe('soft_delete')
  })

  it('lists exactly the changed columns', async () => {
    const subjectId = await seedTestUser('changed-columns')
    await db.query(
      `UPDATE app_user SET full_name = 'Changed columns update', department = 'Finance' WHERE id = $1`,
      [subjectId],
    )
    const { rows } = await db.query(
      `SELECT changed_columns FROM audit_log WHERE table_name = 'app_user' AND row_id = $1
       ORDER BY occurred_at DESC LIMIT 1`,
      [subjectId],
    )
    expect((rows[0].changed_columns as string[]).slice().sort()).toEqual(['department', 'full_name'])
  })
})

describe('audit_log immutability', () => {
  it('rejects direct INSERT, UPDATE, and DELETE as a non-owner role, while the fn_audit trigger path still succeeds', async () => {
    const subjectId = await seedTestUser('immutability')

    // `authenticated` did not exist in the bare test container, so __tests__/integration/setup.ts
    // creates a minimal NOLOGIN stand-in before applying migrations (see setup.ts for why).
    await db.query('SET ROLE authenticated')
    try {
      // authenticated holds SELECT only on audit_log — no INSERT grant exists, so a bare
      // INSERT must be rejected. This is the forgery hole the fix closes: without this,
      // any authenticated caller could fabricate audit rows implicating someone else.
      // Matcher is anchored to the table name: `/permission denied/` alone matches
      // "permission denied for schema public" just as readily as "for table audit_log",
      // so an un-anchored matcher wouldn't actually prove the audit_log grant is the
      // thing being enforced.
      await expect(
        db.query(`INSERT INTO audit_log (table_name, action) VALUES ('manual_test', 'insert')`),
      ).rejects.toThrow(/permission denied for table audit_log/)

      // UPDATE and DELETE were revoked from every role — both must be rejected.
      await expect(
        db.query(
          `UPDATE audit_log SET reason = 'tampered' WHERE table_name = 'app_user' AND row_id = $1`,
          [subjectId],
        ),
      ).rejects.toThrow(/permission denied for table audit_log/)

      await expect(
        db.query(`DELETE FROM audit_log WHERE table_name = 'app_user' AND row_id = $1`, [subjectId]),
      ).rejects.toThrow(/permission denied for table audit_log/)
    } finally {
      await db.query('RESET ROLE')
    }

    // The SECURITY DEFINER path proves the lockdown costs nothing: fn_audit's trigger still
    // writes a correctly-attributed audit_log row for an ordinary app_user UPDATE, even though
    // NO role — including whatever role performs this UPDATE — holds an INSERT grant on
    // audit_log any more. (app_user itself carries no grant to `authenticated` yet — that's a
    // separate, not-yet-built piece of the RBAC rollout — so this step runs as the test's
    // normal privileged connection, same as the other fn_audit() tests above; the property
    // under test is audit_log's own grants, which fn_audit's SECURITY DEFINER bypasses
    // regardless of which role fired the triggering statement.)
    const { rows: before } = await db.query(
      `SELECT count(*)::int AS n FROM audit_log WHERE table_name = 'app_user' AND row_id = $1`,
      [subjectId],
    )
    await db.query(`SELECT set_config('app.actor_id', $1, false)`, [superAdminId])
    try {
      await db.query(`UPDATE app_user SET full_name = 'Immutability trigger check' WHERE id = $1`, [subjectId])
    } finally {
      await db.query(`SELECT set_config('app.actor_id', '', false)`)
    }
    const { rows: after } = await db.query(
      `SELECT count(*)::int AS n, (array_agg(actor_id ORDER BY occurred_at DESC))[1] AS last_actor
       FROM audit_log WHERE table_name = 'app_user' AND row_id = $1`,
      [subjectId],
    )
    expect(after[0].n).toBe(before[0].n + 1)
    expect(after[0].last_actor).toBe(superAdminId)
  })

  it('rejects service_role on INSERT/UPDATE/DELETE of audit_log', async () => {
    // This is the assertion that would have caught Defect 1: the migration originally
    // REVOKEd from PUBLIC, anon, and authenticated but left service_role un-revoked.
    // On a real Supabase project service_role is NOT a passive default — every new
    // public-schema table is born with service_role already holding full DML (see
    // 20250101000008_grants.sql's ALTER DEFAULT PRIVILEGES, reproduced for this test
    // database in setup.ts) — and service_role is BYPASSRLS, so the RLS policies above
    // cannot backstop it. If the audit_log REVOKE ever regresses to omit service_role,
    // this is the test that fails.
    const subjectId = await seedTestUser('service-role-audit-log')

    await db.query('SET ROLE service_role')
    try {
      await expect(
        db.query(`INSERT INTO audit_log (table_name, action) VALUES ('manual_test', 'insert')`),
      ).rejects.toThrow(/permission denied for table audit_log/)

      await expect(
        db.query(
          `UPDATE audit_log SET reason = 'tampered-by-service-role' WHERE table_name = 'app_user' AND row_id = $1`,
          [subjectId],
        ),
      ).rejects.toThrow(/permission denied for table audit_log/)

      await expect(
        db.query(`DELETE FROM audit_log WHERE table_name = 'app_user' AND row_id = $1`, [subjectId]),
      ).rejects.toThrow(/permission denied for table audit_log/)
    } finally {
      await db.query('RESET ROLE')
    }
  })

  it('lets service_role INSERT auth_event (recordAuthEvent depends on it) but rejects UPDATE/DELETE', async () => {
    // Positive-direction counterpart to the test above: auth_event deliberately grants
    // service_role INSERT (recordAuthEvent() writes through the service-role client, a
    // direct DML path with no SECURITY DEFINER function to bypass grants for it) but
    // never UPDATE or DELETE — once written, an auth_event row is as immutable as an
    // audit_log row.
    let eventId: string | undefined
    await db.query('SET ROLE service_role')
    try {
      const { rows } = await db.query(
        `INSERT INTO auth_event (event_type, email) VALUES ('login_success', 'service-role-test@example.com')
         RETURNING id`,
      )
      expect(rows).toHaveLength(1)
      eventId = rows[0].id as string

      await expect(
        db.query(`UPDATE auth_event SET detail = '{}'::jsonb WHERE id = $1`, [eventId]),
      ).rejects.toThrow(/permission denied for table auth_event/)

      await expect(
        db.query(`DELETE FROM auth_event WHERE id = $1`, [eventId]),
      ).rejects.toThrow(/permission denied for table auth_event/)
    } finally {
      await db.query('RESET ROLE')
    }
    // service_role can't clean up its own row (no DELETE grant) — do it as the test's
    // normal privileged connection so this test doesn't leak rows into later ones.
    if (eventId) {
      await db.query(`DELETE FROM auth_event WHERE id = $1`, [eventId])
    }
  })

  it('lets authenticated SELECT from audit_log', async () => {
    // The positive direction: without this, misdirecting the SELECT grant to anon
    // instead of authenticated (or omitting it entirely) would pass every other test
    // in this file unnoticed, since they only ever assert that writes are rejected.
    await db.query('SET ROLE authenticated')
    try {
      await expect(db.query(`SELECT count(*)::int AS n FROM audit_log`)).resolves.toBeDefined()
    } finally {
      await db.query('RESET ROLE')
    }
  })

  it('rejects anon entirely on audit_log', async () => {
    await db.query('SET ROLE anon')
    try {
      await expect(
        db.query(`SELECT count(*)::int AS n FROM audit_log`),
      ).rejects.toThrow(/permission denied for table audit_log/)
    } finally {
      await db.query('RESET ROLE')
    }
  })
})
