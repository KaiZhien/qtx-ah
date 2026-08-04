// __tests__/integration/approvalService.test.ts
//
// Two halves, both against the shared platform test database.
//
//   1. SCHEMA assertions for 20260802000000_platform_approvals.sql (spec §6.3):
//      the polymorphic `approval` record and the `app_setting` runtime-knob
//      store the Finance approval threshold lives in. Raw SQL, in the idiom of
//      componentSchema.test.ts / outboxService.test.ts.
//   2. BEHAVIOUR of modules/shared/approvals/services/approvalService.ts — the
//      request/decide/queue surface, its outbox event, and the atomicity of the
//      two writes.
//
// The two halves deliberately reach the table differently: the schema half
// INSERTs raw rows (so it can probe constraints the service would never let a
// caller reach), the behaviour half only ever goes through the service (so a
// rule the service forgets cannot be masked by a test that writes the row
// itself). Both tag their rows and clean up in afterAll.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import { withTransaction } from '@/lib/db/tx'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'
import { ApprovalDecisionError } from '@/modules/shared/approvals/domain/approvalDecision'
import {
  requestApproval, requestApprovalInTx, decideApproval, listApprovals,
  countPendingApprovals, getApprovalFor, getApprovalForInTx,
  ApprovalNotFoundError, ApprovalAlreadyPendingError, RejectionNeedsNoteError,
  InvalidSnapshotError, ApprovalTargetError,
} from '@/modules/shared/approvals/services/approvalService'
import { drainOutbox, MAX_ATTEMPTS } from '@/modules/shared/outbox/services/outboxService'

// actor.ts (reached through the outbox drain) imports the Supabase server client for the
// HUMAN login path. Nothing under test here goes near it, and importing next/headers in a
// bare node environment has no request to bind to — so stub it, as outboxService.test.ts does.
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

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

// ── Fixtures for the behaviour half ─────────────────────────────────────────
//
// Real app_user rows, because requested_by / created_by / decided_by all carry a
// foreign key. Upserted on the unique email so a second run against a reused
// container is not an insert conflict.
let requesterId: string
let approverId: string
let buyerId: string
const createdInvoiceIds: string[] = []
const createdEcoIds: string[] = []
/**
 * Outbox rows written BY HAND rather than by a request, so they hang off no
 * approval and the approval-keyed cleanup below cannot find them.
 */
const createdOutboxIds: string[] = []

const makeUser = async (email: string, name: string, roleKey: string, department: string) =>
  (await db.query<{ id: string }>(
    `INSERT INTO app_user (email, full_name, role_id, department, module_access, active)
     SELECT $1, $2, r.id, $3, ARRAY['engineering','finance','maintenance','tasks']::text[], true
       FROM role r WHERE r.key = $4
     ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
     RETURNING id`, [email, name, department, roleKey])).rows[0].id

/** A real invoice to hang an approval on — the service checks its target exists. */
async function makeInvoice(totalSgd = '12000.00'): Promise<{ id: string; invoiceNo: string }> {
  const invoiceNo = `INV-APV-${Date.now()}-${Math.floor(Math.random() * 1e6)}`
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO sales_invoice (invoice_no, buyer_id, total_sgd, created_by, updated_by)
     VALUES ($1, $2, $3, $4, $4) RETURNING id`, [invoiceNo, buyerId, totalSgd, requesterId])
  createdInvoiceIds.push(rows[0].id)
  return { id: rows[0].id, invoiceNo }
}

async function makeEco(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO eco (title, created_by, updated_by) VALUES ($1, $2, $2) RETURNING id`,
    [`Approvals engine probe ${Date.now()}`, requesterId])
  createdEcoIds.push(rows[0].id)
  return rows[0].id
}

/** Finance clerk: may manage finance records, may NOT decide approvals. */
const requester = (over: Partial<Actor> = {}): Actor => ({
  id: requesterId, roleKey: 'finance',
  permissions: new Set(['view_records', 'create_records', 'edit_records',
    'view_finance', 'manage_finance']),
  moduleAccess: new Set(['finance']), active: true, ...over,
})
/** Manager: holds approve_requests in Finance. */
const approver = (over: Partial<Actor> = {}): Actor => ({
  id: approverId, roleKey: 'manager',
  permissions: new Set(['view_records', 'create_records', 'edit_records',
    'view_finance', 'manage_finance', 'approve_requests']),
  moduleAccess: new Set(['finance']), active: true, ...over,
})

/** Records every approval the SERVICE creates, so afterAll can find them. */
const track = <T extends { approvalId: string }>(r: T): T => {
  createdApprovalIds.push(r.approvalId)
  return r
}

const approvalRow = async (id: string) => (await db.query<{
  status: string; module: string; kind: string; snapshot: Record<string, unknown>
  requested_by: string; decided_by: string | null; decided_at: Date | null
  decision_note: string | null; version: number; entity_type: string; entity_id: string
}>(`SELECT * FROM approval WHERE id = $1`, [id])).rows[0]

const outboxFor = async (approvalId: string) => (await db.query<{
  id: string; aggregate_type: string; event_type: string; payload: Record<string, unknown>
  created_by: string; processed_at: Date | null; attempts: number; last_error: string | null
}>(`SELECT * FROM outbox WHERE aggregate_id = $1`, [approvalId])).rows

const tasksLinkedTo = async (entityId: string) => (await db.query<{
  id: string; title: string; description: string; department: string | null
  priority: string; status: string; entity_type: string; module: string
}>(
  `SELECT t.id, t.title, t.description, t.department, t.priority, t.status,
          l.entity_type, l.module
     FROM task t JOIN task_link l ON l.task_id = t.id
    WHERE l.entity_id = $1`, [entityId])).rows

beforeAll(async () => {
  // getPool() (the service's connection, and the outbox drain's) reads DATABASE_URL.
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  userId = (await db.query(`SELECT id FROM app_user WHERE email = 'reetmitra8@gmail.com'`)).rows[0].id

  requesterId = await makeUser('approvals-requester@test.local', 'Rita Requester', 'finance', 'Finance')
  approverId = await makeUser('approvals-approver@test.local', 'Adam Approver', 'manager', 'Finance')
  buyerId = (await db.query<{ id: string }>(
    `INSERT INTO buyer (name, created_by, updated_by) VALUES ($1, $2, $2) RETURNING id`,
    ['Approvals Engine Test Buyer', requesterId])).rows[0].id
})

afterAll(async () => {
  // Rows FIRST, then their trail: fn_audit is attached to DELETE too, so clearing
  // audit_log before the row leaves the delete's own audit row behind — which then
  // shows up as a phantom 'delete' action in the next run against a reused container.
  await db.query(`DELETE FROM app_setting WHERE key LIKE $1`, [`${PROBE_PREFIX}%`])

  const entityIds = [...createdInvoiceIds, ...createdEcoIds]
  if (entityIds.length) {
    const { rows: taskIds } = await db.query<{ task_id: string }>(
      `SELECT DISTINCT task_id FROM task_link WHERE entity_id = ANY($1)`, [entityIds])
    const ids = taskIds.map((r) => r.task_id)
    if (ids.length) {
      await db.query(`DELETE FROM task_link WHERE task_id = ANY($1)`, [ids])
      await db.query(`DELETE FROM task WHERE id = ANY($1)`, [ids])
      await db.query(`DELETE FROM audit_log WHERE table_name IN ('task','task_link')
                        AND row_id = ANY($1)`, [ids])
    }
  }
  if (createdApprovalIds.length) {
    const { rows: outboxIds } = await db.query<{ id: string }>(
      `SELECT id FROM outbox WHERE aggregate_id = ANY($1)`, [createdApprovalIds])
    await db.query(`DELETE FROM outbox WHERE aggregate_id = ANY($1)`, [createdApprovalIds])
    await db.query(`DELETE FROM audit_log WHERE table_name='outbox' AND row_id = ANY($1)`,
      [outboxIds.map((r) => r.id)])
    await db.query(`DELETE FROM approval WHERE id = ANY($1)`, [createdApprovalIds])
    await db.query(`DELETE FROM audit_log WHERE table_name='approval' AND row_id = ANY($1)`,
      [createdApprovalIds])
  }
  if (createdOutboxIds.length) {
    await db.query(`DELETE FROM outbox WHERE id = ANY($1)`, [createdOutboxIds])
    await db.query(`DELETE FROM audit_log WHERE table_name='outbox' AND row_id = ANY($1)`,
      [createdOutboxIds])
  }
  if (createdInvoiceIds.length) {
    await db.query(`DELETE FROM sales_invoice WHERE id = ANY($1)`, [createdInvoiceIds])
    await db.query(`DELETE FROM audit_log WHERE table_name='sales_invoice' AND row_id = ANY($1)`,
      [createdInvoiceIds])
  }
  if (createdEcoIds.length) {
    await db.query(`DELETE FROM eco WHERE id = ANY($1)`, [createdEcoIds])
    await db.query(`DELETE FROM audit_log WHERE table_name='eco' AND row_id = ANY($1)`,
      [createdEcoIds])
  }
  if (buyerId) {
    await db.query(`DELETE FROM buyer WHERE id = $1`, [buyerId])
    await db.query(`DELETE FROM audit_log WHERE table_name='buyer' AND row_id = $1`, [buyerId])
  }
  // app_setting is text-keyed, so its audit rows carry row_id NULL — find them by key.
  await db.query(
    `DELETE FROM audit_log WHERE table_name='app_setting'
       AND coalesce(new_values->>'key', old_values->>'key') LIKE $1`, [`${PROBE_PREFIX}%`])
  await db.end()
  await getPool().end()
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

// ═══════════════════════════════════════════════════════════════════════════
// THE SERVICE. Everything below goes through approvalService — never a raw
// INSERT — so a rule the service forgets cannot be hidden by a test that
// writes the row itself.
// ═══════════════════════════════════════════════════════════════════════════

const invoiceSnapshot = (invoiceNo: string, total = '12000.00') =>
  ({ invoiceNo, totalSgd: total, buyerId })

/** The standard Finance request: the permission is the REQUESTER's own, passed in. */
const requestInvoiceApproval = async (
  actor: Actor, invoice: { id: string; invoiceNo: string }, total?: string,
) => track(await requestApproval(actor, {
  entityType: 'sales_invoice',
  entityId: invoice.id,
  kind: 'invoice',
  permission: 'manage_finance',
  label: invoice.invoiceNo,
  snapshot: invoiceSnapshot(invoice.invoiceNo, total),
}))

describe('requestApproval', () => {
  it('records the caller’s snapshot as a pending request, deriving the module from the kind',
    async () => {
      const invoice = await makeInvoice()
      const { approvalId } = await requestInvoiceApproval(requester(), invoice)

      const row = await approvalRow(approvalId)
      expect(row).toMatchObject({
        status: 'pending', module: 'finance', kind: 'invoice',
        entity_type: 'sales_invoice', entity_id: invoice.id,
        requested_by: requesterId, decided_by: null, decided_at: null,
        decision_note: null, version: 1,
      })
      // The snapshot is stored VERBATIM: it is what the approver will be shown, and
      // what the consumer re-checks against current state before it acts.
      expect(row.snapshot).toEqual(invoiceSnapshot(invoice.invoiceNo))
    })

  /**
   * The engine is shared, so the requester's gate is the REQUESTER'S OWN module
   * permission rather than anything the approvals engine hardcodes. Finance passes
   * manage_finance; a clerk who cannot manage finance records cannot ask for one to
   * be approved either.
   */
  it('refuses a requester who lacks the permission the caller named', async () => {
    const invoice = await makeInvoice()
    const clerk = requester({ permissions: new Set(['view_records', 'view_finance']) })
    await expect(requestInvoiceApproval(clerk, invoice)).rejects.toThrow(PermissionError)
    expect(await outboxFor(invoice.id)).toEqual([])
  })

  it('refuses a requester who cannot enter the module the kind belongs to', async () => {
    const invoice = await makeInvoice()
    const outsider = requester({ moduleAccess: new Set(['manufacturing']) })
    await expect(requestInvoiceApproval(outsider, invoice)).rejects.toThrow(PermissionError)
  })

  /**
   * `module` is stored on the row and NOTHING in the schema ties it to `kind` (that
   * CHECK was refused on purpose — it would make every new kind a migration). So the
   * service is the only thing standing between a caller and a row whose module says
   * one thing and whose kind says another, which would silently misfile the request
   * in the module-scoped queue.
   */
  it('refuses a module that disagrees with the kind rather than storing the pair', async () => {
    const invoice = await makeInvoice()
    await expect(requestApproval(requester(), {
      entityType: 'sales_invoice', entityId: invoice.id, kind: 'invoice',
      module: 'engineering', permission: 'manage_finance',
      snapshot: invoiceSnapshot(invoice.invoiceNo),
    })).rejects.toThrow(/finance/i)
  })

  it('accepts a module the caller supplies when it agrees with the derived one', async () => {
    const invoice = await makeInvoice()
    const { approvalId } = track(await requestApproval(requester(), {
      entityType: 'sales_invoice', entityId: invoice.id, kind: 'invoice',
      module: 'finance', permission: 'manage_finance',
      snapshot: invoiceSnapshot(invoice.invoiceNo),
    }))
    expect((await approvalRow(approvalId)).module).toBe('finance')
  })

  /**
   * The snapshot CHECK fences out `{}` because an empty snapshot compares equal to
   * everything, making the consumer's drift re-check pass vacuously. The service owes
   * the friendly refusal — a user must never see a raw 23514.
   */
  it('refuses a snapshot that authorises nothing, with a message and not a raw 23514',
    async () => {
      const invoice = await makeInvoice()
      const bad = { entityType: 'sales_invoice', entityId: invoice.id, kind: 'invoice' as const,
        permission: 'manage_finance' as const }
      await expect(requestApproval(requester(), { ...bad, snapshot: {} }))
        .rejects.toThrow(InvalidSnapshotError)
      // ...including a snapshot that is only-undefined, which SURVIVES a keys-length
      // check and becomes `{}` the moment it is serialised for jsonb.
      await expect(requestApproval(requester(), { ...bad, snapshot: { note: undefined } }))
        .rejects.toThrow(InvalidSnapshotError)
      await expect(requestApproval(requester(), { ...bad, snapshot: [1, 2] as never }))
        .rejects.toThrow()
    })

  /**
   * entity_type carries no foreign key (the whole point of a polymorphic engine), so
   * the migration hands the service the job of validating the target on the way in.
   * Without this an approval can name a row that does not exist, and nothing ever says so.
   */
  it('refuses an entity_type that does not belong to the kind', async () => {
    const invoice = await makeInvoice()
    await expect(requestApproval(requester(), {
      entityType: 'device', entityId: invoice.id, kind: 'invoice',
      permission: 'manage_finance', snapshot: invoiceSnapshot(invoice.invoiceNo),
    })).rejects.toThrow(ApprovalTargetError)
  })

  it('refuses a target row that does not exist', async () => {
    const ghost = (await db.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0].id
    await expect(requestApproval(requester(), {
      entityType: 'sales_invoice', entityId: ghost, kind: 'invoice',
      permission: 'manage_finance', snapshot: { totalSgd: '1.00' },
    })).rejects.toThrow(ApprovalTargetError)
  })

  it('refuses a soft-deleted target', async () => {
    const invoice = await makeInvoice()
    await db.query(`UPDATE sales_invoice SET deleted_at = now() WHERE id = $1`, [invoice.id])
    await expect(requestInvoiceApproval(requester(), invoice)).rejects.toThrow(ApprovalTargetError)
    await db.query(`UPDATE sales_invoice SET deleted_at = NULL WHERE id = $1`, [invoice.id])
  })

  /** The double-click guard, seen from the service: a friendly refusal, not a raw 23505. */
  it('refuses a second pending request for the same record and kind', async () => {
    const invoice = await makeInvoice()
    await requestInvoiceApproval(requester(), invoice)
    await expect(requestInvoiceApproval(requester(), invoice))
      .rejects.toThrow(ApprovalAlreadyPendingError)
  })

  it('lets exactly one of two CONCURRENT requests win', async () => {
    const invoice = await makeInvoice()
    const results = await Promise.allSettled([
      requestInvoiceApproval(requester(), invoice),
      requestInvoiceApproval(requester(), invoice),
    ])
    const won = results.filter((r) => r.status === 'fulfilled')
    const lost = results.filter((r) => r.status === 'rejected')
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)
    expect((lost[0] as PromiseRejectedResult).reason).toBeInstanceOf(ApprovalAlreadyPendingError)

    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM approval WHERE entity_id = $1 AND status = 'pending'`,
      [invoice.id])
    expect(rows[0].n).toBe(1)
  })

  /** A rejected request is RE-requested as a new row — that is why the index is partial. */
  it('permits a fresh request once the first was decided', async () => {
    const invoice = await makeInvoice()
    const first = await requestInvoiceApproval(requester(), invoice)
    await decideApproval(approver(), {
      approvalId: first.approvalId, decision: 'rejected', note: 'Total exceeds the quote.' })

    const second = await requestInvoiceApproval(requester(), invoice, '9000.00')
    expect(second.approvalId).not.toBe(first.approvalId)
    expect((await approvalRow(second.approvalId)).status).toBe('pending')
  })

  /**
   * This project has shipped the inverse regression twice, so pin it the way
   * deviceWriteService.test.ts does: point a FRESH module graph's pool at an
   * unreachable address, so a guard that ran inside withTransaction would surface as
   * a connection error instead of the refusal under test.
   */
  it('authorizes and validates BEFORE it ever acquires a connection', async () => {
    const previous = process.env.DATABASE_URL
    vi.resetModules()
    process.env.DATABASE_URL = 'postgresql://nobody:nobody@127.0.0.1:1/unreachable'
    try {
      const svc = await import('@/modules/shared/approvals/services/approvalService')
      const authz = await import('@/modules/shared/authz/authorize')

      await expect(svc.requestApproval(
        requester({ permissions: new Set(['view_records']) }),
        { entityType: 'sales_invoice', entityId: crypto.randomUUID(), kind: 'invoice',
          permission: 'manage_finance', snapshot: { totalSgd: '1.00' } },
      )).rejects.toThrow(authz.PermissionError)

      await expect(svc.requestApproval(requester(), {
        entityType: 'sales_invoice', entityId: 'not-a-uuid', kind: 'invoice',
        permission: 'manage_finance', snapshot: { totalSgd: '1.00' },
      })).rejects.toThrow(/uuid/i)

      await expect(svc.decideApproval(
        requester(), { approvalId: crypto.randomUUID(), decision: 'approved' },
      )).rejects.toThrow(authz.PermissionError)

      // A rejection with no note is refused before the connection too: the note rule is
      // knowable from the input alone, so burning a connection to learn it is waste.
      await expect(svc.decideApproval(
        approver(), { approvalId: crypto.randomUUID(), decision: 'rejected' },
      )).rejects.toThrow(svc.RejectionNeedsNoteError)
    } finally {
      process.env.DATABASE_URL = previous
      vi.resetModules()
    }
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('requestApproval — the request and its outbox event are ONE transaction', () => {
  it('writes both, so the approver’s task cannot be lost after the request commits',
    async () => {
      const invoice = await makeInvoice()
      const { approvalId } = await requestInvoiceApproval(requester(), invoice)

      const events = await outboxFor(approvalId)
      expect(events).toHaveLength(1)
      expect(events[0]).toMatchObject({
        aggregate_type: 'approval', event_type: 'approval_requested',
        processed_at: null, attempts: 0,
        // The CAUSE is the human who asked, exactly as the device producer records it.
        created_by: requesterId,
      })
      expect(events[0].payload).toMatchObject({
        kind: 'invoice', module: 'finance',
        entityType: 'sales_invoice', entityId: invoice.id, label: invoice.invoiceNo,
      })
    })

  /**
   * THE atomicity proof, in the outbox work's own idiom: a trigger that blocks ONE of
   * the two writes. Blocking the EVENT is the direction that matters — if the two were
   * written on different connections, the approval would survive and a request would
   * exist that no approver is ever told about.
   */
  it('rolls the approval back when the outbox event cannot be written', async () => {
    const invoice = await makeInvoice()
    await db.query(`
      CREATE OR REPLACE FUNCTION test_block_approval_event() RETURNS trigger
      LANGUAGE plpgsql AS $fn$ BEGIN
        RAISE EXCEPTION 'simulated crash between the approval insert and its outbox event';
      END $fn$`)
    await db.query(`
      CREATE TRIGGER trg_test_block_approval_event BEFORE INSERT ON outbox
        FOR EACH ROW WHEN (NEW.aggregate_type = 'approval')
        EXECUTE FUNCTION test_block_approval_event()`)
    try {
      await expect(requestInvoiceApproval(requester(), invoice))
        .rejects.toThrow(/simulated crash/)
    } finally {
      await db.query(`DROP TRIGGER IF EXISTS trg_test_block_approval_event ON outbox`)
      await db.query(`DROP FUNCTION IF EXISTS test_block_approval_event()`)
    }

    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM approval WHERE entity_id = $1`, [invoice.id])
    expect(rows[0].n).toBe(0)
    // ...and the record is not wedged: the retry, now unobstructed, succeeds.
    const retried = await requestInvoiceApproval(requester(), invoice)
    expect(await outboxFor(retried.approvalId)).toHaveLength(1)
  })

  /**
   * The other direction, and the one a "both rows exist afterwards" test can never
   * catch: if the event were emitted on its OWN connection it would COMMIT
   * independently and survive the caller's rollback. requestApprovalInTx is what Task
   * 4's Finance wiring will call from inside its own transaction, so this is also that
   * entry point's contract.
   */
  it('leaves neither row behind when the CALLER’s transaction rolls back', async () => {
    const invoice = await makeInvoice()
    let approvalId = ''
    await expect(withTransaction(requesterId, async (tx) => {
      const r = await requestApprovalInTx(tx, requester(), {
        entityType: 'sales_invoice', entityId: invoice.id, kind: 'invoice',
        permission: 'manage_finance', label: invoice.invoiceNo,
        snapshot: invoiceSnapshot(invoice.invoiceNo),
      })
      approvalId = r.approvalId
      // Both rows exist INSIDE the transaction...
      expect((await tx.query(`SELECT 1 FROM approval WHERE id=$1`, [approvalId])).rowCount).toBe(1)
      expect((await tx.query(`SELECT 1 FROM outbox WHERE aggregate_id=$1`, [approvalId])).rowCount)
        .toBe(1)
      throw new Error('caller aborts after requesting')
    })).rejects.toThrow(/caller aborts/)

    expect(approvalId).not.toBe('')
    expect(await approvalRow(approvalId)).toBeUndefined()
    expect(await outboxFor(approvalId)).toEqual([])
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('decideApproval', () => {
  const pending = async () => {
    const invoice = await makeInvoice()
    const { approvalId } = await requestInvoiceApproval(requester(), invoice)
    return { invoice, approvalId }
  }

  it('approves without a note, stamping the decider and the moment', async () => {
    const { approvalId } = await pending()
    const res = await decideApproval(approver(), { approvalId, decision: 'approved' })
    expect(res).toMatchObject({ status: 'approved', version: 2 })

    const row = await approvalRow(approvalId)
    expect(row).toMatchObject({
      status: 'approved', decided_by: approverId, decision_note: null, version: 2 })
    expect(row.decided_at).toBeInstanceOf(Date)
  })

  it('rejects with a note', async () => {
    const { approvalId } = await pending()
    await decideApproval(approver(), {
      approvalId, decision: 'rejected', note: 'Total is 3k above the quote — re-issue at 9,000.' })
    expect(await approvalRow(approvalId)).toMatchObject({
      status: 'rejected', decided_by: approverId,
      decision_note: 'Total is 3k above the quote — re-issue at 9,000.',
    })
  })

  /**
   * approval_rejection_needs_note is a CHECK as well as a service rule. The CHECK is
   * what makes the invariant unforgettable by a new call site; the SERVICE is what owes
   * the human a sentence they can act on instead of a Postgres 23514.
   */
  it('refuses a rejection with no note — a friendly error, never a raw constraint violation',
    async () => {
      const { approvalId } = await pending()
      const attempt = decideApproval(approver(), { approvalId, decision: 'rejected' })
      await expect(attempt).rejects.toThrow(RejectionNeedsNoteError)
      await expect(attempt).rejects.not.toThrow(/23514|check constraint|violates/i)
      // …and nothing was written: the request is still decidable.
      expect(await approvalRow(approvalId)).toMatchObject({ status: 'pending', version: 1 })
    })

  it('refuses a whitespace-only note, which the CHECK would have accepted', async () => {
    const { approvalId } = await pending()
    await expect(decideApproval(approver(), { approvalId, decision: 'rejected', note: '   \n ' }))
      .rejects.toThrow(RejectionNeedsNoteError)
    expect(await approvalRow(approvalId)).toMatchObject({ status: 'pending' })
  })

  /** THE rule of the engine: an approval is a SECOND pair of eyes. */
  it('refuses the requester’s own decision even when they hold approve_requests', async () => {
    const { approvalId } = await pending()
    const selfApprover = requester({
      permissions: new Set(['view_records', 'manage_finance', 'approve_requests']),
    })
    const attempt = decideApproval(selfApprover, { approvalId, decision: 'approved' })
    await expect(attempt).rejects.toThrow(ApprovalDecisionError)
    await expect(attempt).rejects.toThrow(/your own request/i)
    expect(await approvalRow(approvalId)).toMatchObject({ status: 'pending' })
  })

  it('refuses an actor with no approve_requests at all', async () => {
    const { approvalId } = await pending()
    await expect(decideApproval(approver({ id: userId, permissions: new Set(['view_records']) }),
      { approvalId, decision: 'approved' })).rejects.toThrow(PermissionError)
  })

  /**
   * Module scoping is a DATABASE fact (the row's own `module`), so unlike the
   * permission itself it can only be checked once the row is loaded — inside the
   * transaction, where a throw rolls the whole decision back. A manager who can enter
   * Engineering but not Finance must not decide an invoice.
   */
  it('refuses an approver who cannot enter the request’s module', async () => {
    const { approvalId } = await pending()
    const wrongModule = approver({ moduleAccess: new Set(['engineering']) })
    const attempt = decideApproval(wrongModule, { approvalId, decision: 'approved' })
    await expect(attempt).rejects.toThrow(ApprovalDecisionError)
    await expect(attempt).rejects.toThrow(/permission/i)
    expect(await approvalRow(approvalId)).toMatchObject({ status: 'pending' })
  })

  it('refuses a second decision, in both directions', async () => {
    const approved = await pending()
    await decideApproval(approver(), { approvalId: approved.approvalId, decision: 'approved' })
    await expect(decideApproval(approver(), {
      approvalId: approved.approvalId, decision: 'rejected', note: 'changed my mind' }))
      .rejects.toThrow(/already been decided/i)

    const rejected = await pending()
    await decideApproval(approver(), {
      approvalId: rejected.approvalId, decision: 'rejected', note: 'Wrong buyer.' })
    await expect(decideApproval(approver(), {
      approvalId: rejected.approvalId, decision: 'approved' }))
      .rejects.toThrow(/already been decided/i)
  })

  /** Two managers, one click each: the loser is told the truth, not a lock error. */
  it('tells the loser of two concurrent decisions that it was already decided', async () => {
    const { approvalId } = await pending()
    const second = approver({ id: userId, roleKey: 'super_admin' })
    const results = await Promise.allSettled([
      decideApproval(approver(), { approvalId, decision: 'approved' }),
      decideApproval(second, { approvalId, decision: 'rejected', note: 'Not this quarter.' }),
    ])
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
    const loser = results.find((r) => r.status === 'rejected') as PromiseRejectedResult
    expect(loser.reason).toBeInstanceOf(ApprovalDecisionError)
    expect((loser.reason as Error).message).toMatch(/already been decided/i)
  })

  it('raises ApprovalNotFoundError for an id that is not there', async () => {
    const ghost = (await db.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0].id
    await expect(decideApproval(approver(), { approvalId: ghost, decision: 'approved' }))
      .rejects.toThrow(ApprovalNotFoundError)
  })

  it('leaves an audit trail naming the decider', async () => {
    const { approvalId } = await pending()
    await decideApproval(approver(), { approvalId, decision: 'approved', note: 'Within budget.' })
    const { rows } = await db.query<{ action: string; actor_id: string; changed_columns: string[] }>(
      `SELECT action, actor_id, changed_columns FROM audit_log
        WHERE table_name='approval' AND row_id=$1 ORDER BY occurred_at`, [approvalId])
    expect(rows.map((r) => r.action)).toEqual(['insert', 'update'])
    expect(rows[0].actor_id).toBe(requesterId)
    expect(rows[1].actor_id).toBe(approverId)
    expect(rows[1].changed_columns).toEqual(
      expect.arrayContaining(['status', 'decided_by', 'decided_at', 'version']))
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('getApprovalFor', () => {
  it('returns null when the record has never been submitted', async () => {
    const invoice = await makeInvoice()
    expect(await getApprovalFor(requester(), 'sales_invoice', invoice.id, 'invoice')).toBeNull()
  })

  it('returns the live pending request, snapshot and requester included', async () => {
    const invoice = await makeInvoice()
    const { approvalId } = await requestInvoiceApproval(requester(), invoice)
    const found = await getApprovalFor(requester(), 'sales_invoice', invoice.id, 'invoice')
    expect(found).toMatchObject({
      id: approvalId, status: 'pending', kind: 'invoice', module: 'finance',
      entityType: 'sales_invoice', entityId: invoice.id,
      requestedBy: requesterId, requestedByName: 'Rita Requester',
      decidedBy: null, decidedAt: null, decisionNote: null,
    })
    expect(found!.snapshot).toEqual(invoiceSnapshot(invoice.invoiceNo))
  })

  it('returns the LATEST decided request once nothing is pending', async () => {
    const invoice = await makeInvoice()
    const first = await requestInvoiceApproval(requester(), invoice)
    await decideApproval(approver(), {
      approvalId: first.approvalId, decision: 'rejected', note: 'Re-issue at the quoted total.' })
    const second = await requestInvoiceApproval(requester(), invoice, '9000.00')
    await decideApproval(approver(), { approvalId: second.approvalId, decision: 'approved' })

    const found = await getApprovalFor(requester(), 'sales_invoice', invoice.id, 'invoice')
    expect(found).toMatchObject({
      id: second.approvalId, status: 'approved', decidedBy: approverId,
      decidedByName: 'Adam Approver',
    })
  })

  /** A pending request outranks an older decided one — it is what governs now. */
  it('prefers the pending request over an older decided one', async () => {
    const invoice = await makeInvoice()
    const first = await requestInvoiceApproval(requester(), invoice)
    await decideApproval(approver(), {
      approvalId: first.approvalId, decision: 'rejected', note: 'Numbers changed.' })
    const second = await requestInvoiceApproval(requester(), invoice, '9000.00')

    expect(await getApprovalFor(requester(), 'sales_invoice', invoice.id, 'invoice'))
      .toMatchObject({ id: second.approvalId, status: 'pending' })
  })

  /**
   * Scoped to the kind on both counts: the row it finds, and the module its
   * `view_records` gate names — which follows the KIND, since that is what says
   * whose records these are.
   */
  it('scopes the read to the kind', async () => {
    const invoice = await makeInvoice()
    await requestInvoiceApproval(requester(), invoice)
    const bothModules = requester({ moduleAccess: new Set(['finance', 'maintenance']) })
    expect(await getApprovalFor(bothModules, 'sales_invoice', invoice.id, 'repair_signoff'))
      .toBeNull()
    // ...and a reader who cannot enter the kind's module is refused outright.
    await expect(getApprovalFor(requester(), 'sales_invoice', invoice.id, 'repair_signoff'))
      .rejects.toThrow(PermissionError)
  })

  it('refuses a reader who cannot see the module’s records', async () => {
    const invoice = await makeInvoice()
    await expect(getApprovalFor(
      requester({ permissions: new Set([]) }), 'sales_invoice', invoice.id, 'invoice'))
      .rejects.toThrow(PermissionError)
  })

  /**
   * Task 4 re-checks the approval at the moment it issues the invoice, inside the same
   * transaction that locks the invoice row — otherwise the check and the act happen on
   * two different connections with a window between them.
   */
  it('reads inside the caller’s own transaction', async () => {
    const invoice = await makeInvoice()
    await withTransaction(requesterId, async (tx) => {
      const r = await requestApprovalInTx(tx, requester(), {
        entityType: 'sales_invoice', entityId: invoice.id, kind: 'invoice',
        permission: 'manage_finance', snapshot: invoiceSnapshot(invoice.invoiceNo),
      })
      createdApprovalIds.push(r.approvalId)
      // Uncommitted, so nothing on another connection can see it — this must.
      const found = await getApprovalForInTx(tx, requester(), 'sales_invoice', invoice.id, 'invoice')
      expect(found).toMatchObject({ id: r.approvalId, status: 'pending' })
    })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('listApprovals — the queue', () => {
  it('shows nothing at all to an actor without approve_requests', async () => {
    const invoice = await makeInvoice()
    await requestInvoiceApproval(requester(), invoice)
    expect(await listApprovals(requester())).toEqual({ items: [], nextCursor: null })
  })

  it('shows the pending request to an approver, newest first', async () => {
    const invoice = await makeInvoice()
    const { approvalId } = await requestInvoiceApproval(requester(), invoice)
    const queue = (await listApprovals(approver())).items
    const mine = queue.find((a) => a.id === approvalId)
    expect(mine).toMatchObject({
      status: 'pending', kind: 'invoice', module: 'finance',
      entityType: 'sales_invoice', entityId: invoice.id, requestedByName: 'Rita Requester',
    })
    const times = queue.map((a) => a.requestedAt.getTime())
    expect(times).toEqual([...times].sort((a, b) => b - a))
  })

  /**
   * The queue is scoped by module access as well as by the permission — which is the
   * reason `module` is a stored column rather than a CASE over `kind` at every call
   * site. A manager who can enter Engineering but not Finance sees ECO requests only.
   */
  it('hides requests from modules the approver cannot enter', async () => {
    const invoice = await makeInvoice()
    const { approvalId } = await requestInvoiceApproval(requester(), invoice)
    const engineeringOnly = approver({ moduleAccess: new Set(['engineering']) })
    expect((await listApprovals(engineeringOnly)).items.map((a) => a.id)).not.toContain(approvalId)
  })

  it('shows every module to a super admin, whose module gate is bypassed', async () => {
    const invoice = await makeInvoice()
    const { approvalId } = await requestInvoiceApproval(requester(), invoice)
    const sa = approver({ id: userId, roleKey: 'super_admin', moduleAccess: new Set(['admin']) })
    expect((await listApprovals(sa)).items.map((a) => a.id)).toContain(approvalId)
  })

  it('is the PENDING queue by default, and can be asked for decided rows explicitly',
    async () => {
      const invoice = await makeInvoice()
      const { approvalId } = await requestInvoiceApproval(requester(), invoice)
      await decideApproval(approver(), { approvalId, decision: 'approved' })

      expect((await listApprovals(approver())).items.map((a) => a.id)).not.toContain(approvalId)
      const decided = await listApprovals(approver(), { status: ['approved', 'rejected'] })
      expect(decided.items.map((a) => a.id)).toContain(approvalId)
    })

  it('shows nothing to a deactivated approver', async () => {
    const invoice = await makeInvoice()
    await requestInvoiceApproval(requester(), invoice)
    expect(await listApprovals(approver({ active: false })))
      .toEqual({ items: [], nextCursor: null })
  })

  /**
   * Keyset paging, not OFFSET: the queue's whole purpose is that rows arrive while
   * it is on screen, and an OFFSET page 2 would skip exactly the requests that
   * landed since page 1 was rendered.
   */
  it('pages through the queue without repeating or dropping a row', async () => {
    const wanted: string[] = []
    for (let i = 0; i < 3; i++) {
      const invoice = await makeInvoice()
      const { approvalId } = await requestInvoiceApproval(requester(), invoice)
      wanted.push(approvalId)
    }

    const seen: string[] = []
    let cursor: string | null | undefined
    // Bounded so a paging bug fails the test rather than hanging the suite.
    for (let page = 0; page < 50; page++) {
      const result = await listApprovals(approver(), { limit: 1, cursor: cursor ?? undefined })
      expect(result.items.length).toBeLessThanOrEqual(1)
      seen.push(...result.items.map((a) => a.id))
      cursor = result.nextCursor
      if (!cursor) break
    }

    expect(new Set(seen).size).toBe(seen.length)          // nothing repeated
    for (const id of wanted) expect(seen).toContain(id)   // nothing dropped
  })

  /**
   * The dashboard tile's count. It MUST agree with the queue it links to, so it
   * is scoped identically — a tile reading "3" that opens a page showing four
   * rows is a bug report, not a feature.
   */
  it('counts what the queue would show, with the same two scopes', async () => {
    const before = await countPendingApprovals(approver())
    const invoice = await makeInvoice()
    track(await requestInvoiceApproval(requester(), invoice))
    expect(await countPendingApprovals(approver())).toBe(before + 1)

    // Scope 1: no approve_requests → zero, not a throw. A tile on a shared
    // dashboard has to render for everyone.
    expect(await countPendingApprovals(requester())).toBe(0)
    expect(await countPendingApprovals(approver({ active: false }))).toBe(0)

    // Scope 2: module access. A Finance request is invisible to an
    // Engineering-only approver, count included.
    const engineeringOnly = approver({ moduleAccess: new Set(['engineering']) })
    const engCount = await countPendingApprovals(engineeringOnly)
    expect(engCount).toBe(await countPendingApprovals(engineeringOnly, { module: 'engineering' }))
    expect(await countPendingApprovals(engineeringOnly, { module: 'finance' })).toBe(0)
  })

  it('counts decided rows out, and can exclude the actor’s own requests', async () => {
    const invoice = await makeInvoice()
    const { approvalId } = track(await requestInvoiceApproval(requester(), invoice))
    const withMine = await countPendingApprovals(approver(), { kind: 'invoice' })

    // The requester is not the approver here, so excluding own requests changes
    // nothing for THEM — but it must exclude the row for the requester's own view.
    expect(await countPendingApprovals(approver(), {
      kind: 'invoice', excludeOwnRequests: true })).toBe(withMine)

    await decideApproval(approver(), { approvalId, decision: 'approved' })
    expect(await countPendingApprovals(approver(), { kind: 'invoice' })).toBe(withMine - 1)
  })

  it('ignores an unparseable cursor rather than failing the page', async () => {
    // The cursor reaches the service from a URL query string, so "not a cursor"
    // is ordinary input; it must yield the first page, never a raw driver error.
    //
    // The last two are the case that used to 500. The timestamp half was
    // validated and the id half only had to be non-empty, so a well-formed date
    // with a junk id sailed through and reached the query as a `uuid` comparison:
    // Postgres 22P02, an exception out of a function whose own header promises
    // page one. Both a plainly-not-a-uuid id and a nearly-right one are pinned.
    const invoice = await makeInvoice()
    const { approvalId } = await requestInvoiceApproval(requester(), invoice)
    const b64 = (s: string) => Buffer.from(s).toString('base64url')
    for (const cursor of [
      'nonsense', '', 'Zm9v',
      b64('not-a-date|x'),
      b64('2026-01-01T00:00:00.000Z|x'),
      b64('2026-01-01T00:00:00.000Z|'),
      b64('2026-01-01T00:00:00.000Z|zzzzzzzz-zzzz-zzzz-zzzz-zzzzzzzzzzzz'),
      b64('2026-01-01T00:00:00.000Z|00000000-0000-0000-0000-00000000000'),
    ]) {
      const result = await listApprovals(approver(), { cursor })
      expect(result.items.map((a) => a.id)).toContain(approvalId)
    }
  })

  /**
   * THE KEYSET TIE, which was correct by construction and pinned by nothing.
   *
   * Every other test in this file creates its approvals in separate transactions,
   * so no two ever shared a `created_at` — and `requestApprovalInTx` stamps
   * transaction-time `now()`, which is identical for every row committed by one
   * transaction. So two approvals requested together IS the tie case, and it is
   * reachable through a public API (any consumer that requests inside its own
   * write). Without the `id` tiebreaker in both the ORDER BY and the cursor
   * comparison, paging across the boundary would repeat one row or drop the other.
   */
  it('pages across two approvals that share a created_at to the microsecond', async () => {
    const first = await makeInvoice()
    const second = await makeInvoice()
    const ids = await withTransaction(requesterId, async (tx) => {
      const a = await requestApprovalInTx(tx, requester(), {
        entityType: 'sales_invoice', entityId: first.id, kind: 'invoice',
        permission: 'manage_finance', snapshot: invoiceSnapshot(first.invoiceNo),
      })
      const b = await requestApprovalInTx(tx, requester(), {
        entityType: 'sales_invoice', entityId: second.id, kind: 'invoice',
        permission: 'manage_finance', snapshot: invoiceSnapshot(second.invoiceNo),
      })
      return [a.approvalId, b.approvalId]
    })
    createdApprovalIds.push(...ids)

    // The premise: one transaction, one timestamp.
    const { rows: stamps } = await db.query<{ created_at: Date }>(
      `SELECT created_at FROM approval WHERE id = ANY($1)`, [ids])
    expect(stamps[0].created_at.getTime()).toBe(stamps[1].created_at.getTime())

    // Page one row at a time across the boundary: both appear, exactly once each.
    const seen: string[] = []
    let cursor: string | null | undefined
    for (let page = 0; page < 50; page++) {
      const result = await listApprovals(approver(), { limit: 1, cursor: cursor ?? undefined })
      seen.push(...result.items.map((a) => a.id))
      cursor = result.nextCursor
      if (!cursor) break
    }
    expect(new Set(seen).size).toBe(seen.length)
    for (const id of ids) expect(seen.filter((s) => s === id)).toHaveLength(1)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('the approval handoff task', () => {
  it('reaches the approver’s department queue when the drain runs, linked to both records',
    async () => {
      const invoice = await makeInvoice()
      const { approvalId } = await requestInvoiceApproval(requester(), invoice)

      const result = await drainOutbox()
      expect(result.failures).toEqual([])
      expect((await outboxFor(approvalId))[0].processed_at).not.toBeNull()

      const tasks = await tasksLinkedTo(invoice.id)
      expect(tasks).toHaveLength(1)
      expect(tasks[0]).toMatchObject({
        department: 'Finance', module: 'finance', entity_type: 'sales_invoice', status: 'open',
      })
      expect(tasks[0].title).toContain(invoice.invoiceNo)
      // The requester is resolved from the event's created_by at drain time, never carried.
      expect(tasks[0].description).toContain('Rita Requester')

      // ...and the task also hangs off the approval itself, so the queue page can find it.
      const { rows: links } = await db.query<{ entity_type: string; entity_id: string }>(
        `SELECT entity_type, entity_id FROM task_link WHERE task_id = $1 ORDER BY entity_type`,
        [tasks[0].id])
      expect(links).toEqual(expect.arrayContaining([
        { entity_type: 'approval', entity_id: approvalId },
        { entity_type: 'sales_invoice', entity_id: invoice.id },
      ]))
    })

  /**
   * A kind with no registered template PARKS its event rather than inventing a generic
   * task nobody can act on — the behaviour the handoff registry already has, and the
   * right one: a task that says nothing useful is worse than a backlog entry a runbook
   * can see.
   *
   * THE KIND HAS TO BE SYNTHESISED, and that is the point rather than a workaround.
   * This test used to use `eco`, on the grounds that it was "deliberately unregistered
   * (Engineering still uses its own direct gate)". AP2 registered all three kinds, so
   * the test was asserting a refusal that no longer happens — it had stopped covering
   * parking and started failing. Every kind in `approval.kind`'s CHECK set is now
   * registered, so there is no kind `requestApproval` will accept that also parks, and
   * the event is written by hand instead. That is faithful to what parking defends
   * against anyway: not a caller passing a bad kind (the CHECK stops that), but a kind
   * added to the schema whose template nobody remembered to write.
   */
  it('parks an event whose kind has no registered template instead of inventing a task',
    async () => {
      const ecoId = await makeEco()
      const { rows: [row0] } = await db.query<{ id: string }>(
        `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload, created_by)
         VALUES ('approval', gen_random_uuid(), 'approval_requested', $1::jsonb, $2)
         RETURNING id`,
        [JSON.stringify({
          kind: 'not_a_registered_kind', module: 'engineering',
          entityType: 'eco', entityId: ecoId, label: 'ECO-PROBE',
        }), requesterId])
      createdOutboxIds.push(row0.id)

      const result = await drainOutbox()
      const failure = result.failures.find((f) => f.outboxId === row0.id)
      expect(failure).toBeDefined()
      expect(failure!.error).toMatch(/no handoff template registered/i)
      expect(await tasksLinkedTo(ecoId)).toEqual([])

      const { rows: [row] } = await db.query<{
        attempts: number; processed_at: Date | null; last_error: string | null
      }>(`SELECT attempts, processed_at, last_error FROM outbox WHERE id=$1`, [row0.id])
      expect(row).toMatchObject({ attempts: 1, processed_at: null })
      expect(row.last_error).toMatch(/not_a_registered_kind/)

      // …and once it hits the cap it stops consuming drains altogether.
      await db.query(`UPDATE outbox SET attempts = $2 WHERE id = $1`, [row0.id, MAX_ATTEMPTS])
      const second = await drainOutbox()
      expect(second.failures.map((f) => f.outboxId)).not.toContain(row0.id)
      expect((second.parked ?? 0)).toBeGreaterThan(0)
    })

  /**
   * The other direction, which the registry's own header calls out: `eco` IS
   * registered now, so its event must reach a real task rather than park. Pinning
   * both directions is what stops the pair above from silently becoming vacuous
   * again the next time the registry changes.
   */
  it('drains a REGISTERED kind into a real task rather than parking it', async () => {
    const ecoId = await makeEco()
    const engineer = requester({ moduleAccess: new Set(['engineering']) })
    const { approvalId } = track(await requestApproval(engineer, {
      entityType: 'eco', entityId: ecoId, kind: 'eco', permission: 'edit_records',
      snapshot: { ecoNo: 'ECO-PROBE-REGISTERED', title: 'Approvals engine probe' },
    }))
    expect((await approvalRow(approvalId)).module).toBe('engineering')

    await drainOutbox()
    expect((await outboxFor(approvalId))[0].processed_at).not.toBeNull()
    const tasks = await tasksLinkedTo(ecoId)
    expect(tasks).toHaveLength(1)
    expect(tasks[0].title).toContain('ECO-PROBE-REGISTERED')
  })
})
