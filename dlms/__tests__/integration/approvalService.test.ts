// __tests__/integration/approvalService.test.ts
//
// Schema assertions for 20260802000000_platform_approvals.sql (spec §6.3):
// the polymorphic `approval` record and the `app_setting` runtime-knob store
// the Finance approval threshold lives in.
//
// Task 3 of the approvals plan extends this file with the behaviour of
// modules/shared/approvals/services/approvalService.ts; everything here is
// schema, in the idiom of componentSchema.test.ts / outboxService.test.ts:
// raw SQL against the shared platform test database, tag rows per run, clean
// up in afterAll.
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'

let db: Client
let userId: string

const createdApprovalIds: string[] = []

/** Every probe setting this file writes starts with this, so teardown is one predicate. */
const PROBE_PREFIX = 'zz_probe_'

/**
 * Inserts an approval with the minimum NOT NULL set, and records it for cleanup.
 * `entity_id` defaults to a fresh random uuid that matches no row anywhere — which
 * is itself part of the contract: the polymorphic pair carries no FK.
 */
async function makeApproval(over: Record<string, unknown> = {}) {
  const cols: Record<string, unknown> = {
    entity_type: 'sales_invoice',
    entity_id: null,
    module: 'finance',
    kind: 'invoice',
    snapshot: JSON.stringify({ total_sgd: '12000.00', buyer_id: 'b-1' }),
    requested_by: userId,
    created_by: userId,
    ...over,
  }
  if (cols.entity_id === null) {
    cols.entity_id = (await db.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0].id
  }
  const keys = Object.keys(cols)
  const { rows } = await db.query(
    `INSERT INTO approval (${keys.join(',')})
     VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')})
     RETURNING id, entity_id, status, version`,
    Object.values(cols),
  )
  createdApprovalIds.push(rows[0].id)
  return rows[0] as { id: string; entity_id: string; status: string; version: number }
}

/** Stamps a decision on a pending approval, the way approvalService will. */
async function decide(id: string, status: 'approved' | 'rejected', note: string | null = null) {
  await db.query(
    `UPDATE approval SET status=$2, decided_by=$3, decided_at=now(), decision_note=$4,
            updated_at=now(), updated_by=$3, version=version+1
      WHERE id=$1`,
    [id, status, userId, note],
  )
}

beforeAll(async () => {
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  userId = (await db.query(`SELECT id FROM app_user WHERE email = 'reetmitra8@gmail.com'`)).rows[0].id
})

afterAll(async () => {
  // Rows FIRST, then their trail: fn_audit is attached to DELETE too, so clearing
  // audit_log before the row leaves the delete's own audit row behind — which then
  // shows up as a phantom 'delete' action in the next run against a reused container.
  await db.query(`DELETE FROM app_setting WHERE key LIKE $1`, [`${PROBE_PREFIX}%`])
  if (createdApprovalIds.length) {
    await db.query(`DELETE FROM approval WHERE id = ANY($1)`, [createdApprovalIds])
    await db.query(`DELETE FROM audit_log WHERE table_name='approval' AND row_id = ANY($1)`,
      [createdApprovalIds])
  }
  // app_setting is text-keyed, so its audit rows carry row_id NULL — find them by key.
  await db.query(
    `DELETE FROM audit_log WHERE table_name='app_setting'
       AND coalesce(new_values->>'key', old_values->>'key') LIKE $1`, [`${PROBE_PREFIX}%`])
  await db.end()
})

// ═══════════════════════════════════════════════════════════════════════════
describe('app_setting', () => {
  it('exists, keyed on `key`, with a jsonb value', async () => {
    const { rows } = await db.query<{ column_name: string; data_type: string; is_nullable: string }>(
      `SELECT column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema='public' AND table_name='app_setting'
          AND column_name IN ('key','value') ORDER BY column_name`)
    expect(rows).toEqual([
      { column_name: 'key', data_type: 'text', is_nullable: 'NO' },
      { column_name: 'value', data_type: 'jsonb', is_nullable: 'NO' },
    ])

    const { rows: pk } = await db.query<{ attname: string }>(
      `SELECT a.attname FROM pg_constraint c
         JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = ANY(c.conkey)
        WHERE c.conrelid='public.app_setting'::regclass AND c.contype='p'`)
    expect(pk.map((r) => r.attname)).toEqual(['key'])
  })

  it('carries the audit columns and version — a settings change is an auditor question', async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='app_setting'`)
    expect(rows.map((r) => r.column_name)).toEqual(expect.arrayContaining([
      'created_at', 'created_by', 'updated_at', 'updated_by', 'version',
    ]))
  })

  it('seeds the admin-tunable Finance approval threshold as a JSON number', async () => {
    const { rows } = await db.query<{ value: unknown; version: number }>(
      `SELECT value, version FROM app_setting WHERE key='finance_approval_threshold_sgd'`)
    expect(rows).toHaveLength(1)
    expect(typeof rows[0].value).toBe('number')
    expect(rows[0].value).toBeGreaterThan(0)
    expect(rows[0].version).toBe(1)
  })

  it('refuses a JSON null value — an unset knob must be an absent row, not a null one', async () => {
    await expect(db.query(
      `INSERT INTO app_setting (key, value) VALUES ($1, 'null'::jsonb)`,
      [`${PROBE_PREFIX}null_value`])).rejects.toThrow(/check constraint/i)
  })

  it('refuses a key that is not a snake_case identifier', async () => {
    await expect(db.query(
      `INSERT INTO app_setting (key, value) VALUES ('Finance Threshold', '1'::jsonb)`))
      .rejects.toThrow(/check constraint/i)
  })

  it('denies REST access via RLS with no policy', async () => {
    const { rows } = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean; policies: string }>(
      `SELECT c.relrowsecurity, c.relforcerowsecurity,
              (SELECT count(*) FROM pg_policy p WHERE p.polrelid = c.oid)::text AS policies
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname='public' AND c.relname='app_setting'`)
    expect(rows[0].relrowsecurity).toBe(true)
    expect(rows[0].relforcerowsecurity).toBe(false)
    expect(rows[0].policies).toBe('0')
  })

  /**
   * Naming the trigger AND proving it reaches audit_log: "some non-internal trigger
   * exists" is satisfiable by anything. app_setting is the first AUDITED text-keyed
   * table in this schema, so its trail carries row_id NULL — the key is recoverable
   * from new_values, which is what this asserts.
   */
  it('is audit-attached, and the trigger really writes to audit_log', async () => {
    const { rows: triggers } = await db.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger
        WHERE tgrelid='public.app_setting'::regclass AND NOT tgisinternal`)
    expect(triggers.map((t) => t.tgname)).toContain('trg_audit_app_setting')

    const key = `${PROBE_PREFIX}audit`
    await db.query(`INSERT INTO app_setting (key, value, created_by) VALUES ($1,'1'::jsonb,$2)`,
      [key, userId])
    await db.query(
      `UPDATE app_setting SET value='2'::jsonb, updated_at=now(), updated_by=$2, version=version+1
        WHERE key=$1`, [key, userId])

    const { rows } = await db.query<{ action: string; row_id: string | null; actor_id: string; changed_columns: string[] }>(
      `SELECT action, row_id, actor_id, changed_columns FROM audit_log
        WHERE table_name='app_setting' AND coalesce(new_values->>'key', old_values->>'key')=$1
        ORDER BY occurred_at`, [key])
    expect(rows.map((r) => r.action)).toEqual(['insert', 'update'])
    expect(rows[0].row_id).toBeNull()
    expect(rows[0].actor_id).toBe(userId)
    expect(rows[1].changed_columns).toEqual(expect.arrayContaining(['value', 'version']))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('approval', () => {
  it('exists', async () => {
    const { rows } = await db.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema='public' AND table_name='approval'`)
    expect(rows.map((r) => r.table_name)).toEqual(['approval'])
  })

  it('attaches to any module\'s record — entity_id carries NO foreign key', async () => {
    const { rows } = await db.query<{ conname: string; referenced: string }>(
      `SELECT conname, confrelid::regclass::text AS referenced FROM pg_constraint
        WHERE conrelid='public.approval'::regclass AND contype='f'`)
    // Every FK on this table points at app_user (the four actor stamps) and nothing else.
    expect(rows.map((r) => r.referenced)).toEqual(rows.map(() => 'app_user'))

    // …and an entity_id matching no row anywhere still inserts.
    const row = await makeApproval({ entity_type: 'not_a_real_table' })
    expect(row.id).toBeTruthy()
  })

  it('defaults a new request to pending, undecided, version 1', async () => {
    const row = await makeApproval()
    const { rows } = await db.query(
      `SELECT status, decided_by, decided_at, decision_note, version FROM approval WHERE id=$1`,
      [row.id])
    expect(rows[0]).toMatchObject({
      status: 'pending', decided_by: null, decided_at: null, decision_note: null, version: 1,
    })
  })

  it('requires a snapshot — the immutable record of what was approved', async () => {
    const { rows } = await db.query<{ is_nullable: string; data_type: string }>(
      `SELECT is_nullable, data_type FROM information_schema.columns
        WHERE table_schema='public' AND table_name='approval' AND column_name='snapshot'`)
    expect(rows[0]).toMatchObject({ is_nullable: 'NO', data_type: 'jsonb' })

    await expect(makeApproval({ snapshot: null })).rejects.toThrow(/not-null/i)
  })

  it('refuses a snapshot that authorises nothing (non-object, or empty)', async () => {
    await expect(makeApproval({ snapshot: JSON.stringify([1, 2]) }))
      .rejects.toThrow(/check constraint/i)
    await expect(makeApproval({ snapshot: JSON.stringify({}) }))
      .rejects.toThrow(/check constraint/i)
  })

  it('fences `kind` to the spec §6.3 set', async () => {
    await expect(makeApproval({ kind: 'purchase_order' })).rejects.toThrow(/check constraint/i)
    for (const kind of ['eco', 'invoice', 'repair_signoff']) {
      const module = kind === 'eco' ? 'engineering' : kind === 'invoice' ? 'finance' : 'maintenance'
      await expect(makeApproval({ kind, module })).resolves.toBeTruthy()
    }
  })

  it('fences `status` to pending/approved/rejected', async () => {
    await expect(makeApproval({ status: 'withdrawn' })).rejects.toThrow(/check constraint/i)
  })

  it('fences `module` to the seven platform modules', async () => {
    await expect(makeApproval({ module: 'marketing' })).rejects.toThrow(/check constraint/i)
  })

  it('requires a decision to be complete: both stamps, or neither', async () => {
    await expect(makeApproval({ decided_by: userId })).rejects.toThrow(/check constraint/i)
    await expect(makeApproval({ status: 'approved' })).rejects.toThrow(/check constraint/i)
    await expect(makeApproval({ decided_at: new Date().toISOString(), decided_by: userId }))
      .rejects.toThrow(/check constraint/i)   // still `pending`
  })

  it('requires a note on a rejection — a rejection nobody can act on is worse than none',
    async () => {
      await expect(makeApproval({
        status: 'rejected', decided_by: userId, decided_at: new Date().toISOString(),
      })).rejects.toThrow(/check constraint/i)

      await expect(makeApproval({
        status: 'rejected', decided_by: userId, decided_at: new Date().toISOString(),
        decision_note: 'Total exceeds the quoted amount.',
      })).resolves.toBeTruthy()
    })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('approval indexes', () => {
  /**
   * The double-click guard. Both halves matter: refusing the second PENDING row is
   * the point, and PERMITTING a second row once the first is decided is what proves
   * the index is PARTIAL rather than a plain unique constraint that would make a
   * rejected request un-re-requestable forever.
   */
  it('refuses a second PENDING approval for the same (entity_type, entity_id, kind)', async () => {
    const first = await makeApproval()
    await expect(makeApproval({ entity_id: first.entity_id }))
      .rejects.toThrow(/duplicate key value violates unique constraint/i)
  })

  it('permits a second approval once the first is decided', async () => {
    const first = await makeApproval()
    await decide(first.id, 'rejected', 'Numbers changed; re-submit.')
    await expect(makeApproval({ entity_id: first.entity_id })).resolves.toBeTruthy()
  })

  it('scopes the guard to the kind — a different kind on the same record is allowed',
    async () => {
      const first = await makeApproval()
      await expect(makeApproval({
        entity_id: first.entity_id, kind: 'repair_signoff', module: 'maintenance',
      })).resolves.toBeTruthy()
    })

  it('enforces one-pending with a PARTIAL UNIQUE index over the polymorphic triple',
    async () => {
      const { rows } = await db.query<{ indexdef: string }>(
        `SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='approval'`)
      // …not `approval_pkey`, which is also a UNIQUE index: the one under test is the
      // PARTIAL one, so require the WHERE clause as part of finding it.
      const unique = rows.find((r) => /CREATE UNIQUE INDEX/.test(r.indexdef) && / WHERE /.test(r.indexdef))
      expect(unique, `no partial unique index in:\n${rows.map((r) => r.indexdef).join('\n')}`)
        .toBeDefined()
      expect(unique!.indexdef).toMatch(/\(entity_type, entity_id, kind\)/)
      expect(unique!.indexdef).toMatch(/WHERE .*status = 'pending'/)
    })

  it('serves the queue query shape: pending approvals, newest first', async () => {
    const { rows } = await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='approval'`)
    const queue = rows.find((r) =>
      !/UNIQUE/.test(r.indexdef)
      && /created_at DESC/.test(r.indexdef)
      && /WHERE .*status = 'pending'/.test(r.indexdef))
    expect(queue, `no pending-newest-first index in:\n${rows.map((r) => r.indexdef).join('\n')}`)
      .toBeDefined()
  })

  it('indexes the polymorphic pair for the record panel / getApprovalFor lookup', async () => {
    const { rows } = await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='approval'`)
    expect(rows.some((r) =>
      !/UNIQUE/.test(r.indexdef) && /\(entity_type, entity_id\)/.test(r.indexdef))).toBe(true)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('approval immutability (spec §6.4: immutable post-decision)', () => {
  it('refuses to change what was approved', async () => {
    const row = await makeApproval()
    await expect(db.query(
      `UPDATE approval SET snapshot='{"total_sgd":"1.00"}'::jsonb WHERE id=$1`, [row.id]))
      .rejects.toThrow(/immutable/i)
    await expect(db.query(`UPDATE approval SET kind='eco' WHERE id=$1`, [row.id]))
      .rejects.toThrow(/immutable/i)
  })

  it('refuses to re-decide a decided approval', async () => {
    const row = await makeApproval()
    await decide(row.id, 'approved')
    await expect(decide(row.id, 'rejected', 'changed my mind')).rejects.toThrow(/already approved/i)
  })

  it('still allows a pending approval to be decided exactly once', async () => {
    const row = await makeApproval()
    await expect(decide(row.id, 'approved', 'Matches the quote.')).resolves.toBeUndefined()
    const { rows } = await db.query(`SELECT status, decided_by FROM approval WHERE id=$1`, [row.id])
    expect(rows[0]).toMatchObject({ status: 'approved', decided_by: userId })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('platform table conventions', () => {
  const NEW_TABLES = ['app_setting', 'approval']

  it('has RLS enabled and NOT forced on every new table', async () => {
    const { rows } = await db.query<{ relname: string; relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relname, relrowsecurity, relforcerowsecurity FROM pg_class
        WHERE relname = ANY($1) AND relkind='r' ORDER BY relname`, [NEW_TABLES])
    expect(rows.map((r) => r.relname)).toEqual(NEW_TABLES)
    expect(rows.every((r) => r.relrowsecurity === true)).toBe(true)
    expect(rows.every((r) => r.relforcerowsecurity === false)).toBe(true)
  })

  it('has NO policy on either (deny-via-REST)', async () => {
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_policies
        WHERE schemaname='public' AND tablename = ANY($1)`, [NEW_TABLES])
    expect(rows[0].n).toBe(0)
  })

  it('attaches the audit trigger by name on every new table', async () => {
    const { rows } = await db.query<{ tgname: string }>(
      `SELECT tgname FROM pg_trigger
        WHERE tgrelid = ANY(ARRAY['app_setting'::regclass,'approval'::regclass])
          AND NOT tgisinternal ORDER BY tgname`)
    expect(rows.map((r) => r.tgname)).toEqual(expect.arrayContaining([
      'trg_audit_app_setting', 'trg_audit_approval',
    ]))
  })

  it('actually writes an audit_log row on insert and update of an approval', async () => {
    const row = await makeApproval()
    const inserted = await db.query<{ action: string; actor_id: string }>(
      `SELECT action, actor_id FROM audit_log WHERE table_name='approval' AND row_id=$1`, [row.id])
    expect(inserted.rows.map((r) => r.action)).toEqual(['insert'])
    expect(inserted.rows[0].actor_id).toBe(userId)

    await decide(row.id, 'approved', 'Within budget.')
    const after = await db.query<{ action: string; changed_columns: string[] }>(
      `SELECT action, changed_columns FROM audit_log
        WHERE table_name='approval' AND row_id=$1 ORDER BY occurred_at`, [row.id])
    expect(after.rows.map((r) => r.action)).toEqual(['insert', 'update'])
    expect(after.rows[1].changed_columns).toEqual(
      expect.arrayContaining(['status', 'decided_by', 'decided_at', 'version']))
  })

  it('carries the audit columns, version and deleted_at on approval', async () => {
    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_schema='public' AND table_name='approval'`)
    expect(rows.map((r) => r.column_name)).toEqual(expect.arrayContaining([
      'created_at', 'created_by', 'updated_at', 'updated_by', 'deleted_at', 'version',
    ]))
  })
})
