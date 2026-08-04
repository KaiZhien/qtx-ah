import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import { drainOutbox } from '@/modules/shared/outbox/services/outboxService'
import { sweepTaskReminders } from '@/modules/shared/notifications/services/reminderService'
import { expireOverrides } from '@/modules/shared/outbox/jobs/expireOverrides'
import { reminderDedupeKey } from '@/modules/shared/notifications/domain/reminders'

// actor.ts imports the Supabase server client for the HUMAN login path (loadActor).
// Nothing under test here goes near it, and importing next/headers in a bare node
// environment has no request to bind to — so stub it, as the sibling suites do.
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

/**
 * Notifications end to end against real Postgres (spec §6.3), plus the two scheduled jobs.
 *
 * The properties that actually matter and cannot be unit-tested:
 *
 *   EXACTLY ONCE. The fan-out joins the drain's claim transaction, so a re-drain must
 *   produce no second notification — the same guarantee the task already had, and the one
 *   that breaks silently if anyone moves the insert onto its own connection.
 *
 *   REMINDER IDEMPOTENCY. Running the sweep twice on one day must notify nobody twice, and
 *   that has to be true because of a unique index rather than because the job remembered.
 *
 *   THE MODULE GATE. notify_roles selects by ROLE; a person who cannot enter the module has
 *   no business being told about its records.
 *
 * Every test scopes its assertions to rows it created (fresh uuids, a dedicated set of
 * users) so the file is re-runnable and cannot see another file's rows.
 */

const SYSTEM_ACTOR_ID = '22222222-2222-2222-2222-222222222222'

let db: Client

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  // The unconfigured-email path is the platform's real state and the default for these
  // tests: emailed_at must stay NULL rather than recording mail that never left.
  delete process.env.RESEND_API_KEY
})
afterAll(async () => { await db.end(); await getPool().end() })

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Everyone this file creates, so its cleanup and its assertions share one scope. */
const EMAIL_PREFIX = 'notif-test-'

let causerId: string             // the human who triggers events; never notified about them
let logisticsManagerId: string   // manager, holds logistics → SHOULD hear about handoffs
let otherManagerId: string       // manager, NO logistics → must NOT hear
let financeApproverId: string    // holds approve_requests in finance
let assigneeId: string           // owns the tasks the reminder sweep finds

/**
 * UPSERT, not INSERT, and that is not fussiness.
 *
 * A plain insert makes this file pass exactly once per container: the second `vitest run`
 * against an already-populated database collides on app_user's unique email and takes every
 * test in the file with it. That failure mode is already known in this suite, and adding
 * another instance of it is what the house rule "make tests re-runnable" is about. Re-asserting
 * the role and modules also heals a fixture a previous run left in a different shape.
 */
const makeUser = async (
  email: string, name: string, roleKey: string, modules: string[],
): Promise<string> => (await db.query<{ id: string }>(
  `INSERT INTO app_user (email, full_name, role_id, department, module_access, active)
   SELECT $1, $2, r.id, 'Logistics', $3::text[], true FROM role r WHERE r.key = $4
   ON CONFLICT (email) DO UPDATE SET
     full_name = EXCLUDED.full_name, role_id = EXCLUDED.role_id,
     module_access = EXCLUDED.module_access, active = true, deleted_at = NULL
   RETURNING id`, [email, name, modules, roleKey])).rows[0].id

beforeAll(async () => {
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()

  causerId = await makeUser(
    `${EMAIL_PREFIX}causer@test.local`, 'Cara Causer', 'operator',
    ['manufacturing', 'logistics', 'tasks'])
  logisticsManagerId = await makeUser(
    `${EMAIL_PREFIX}logistics@test.local`, 'Lena Logistics', 'manager',
    ['logistics', 'tasks'])
  otherManagerId = await makeUser(
    `${EMAIL_PREFIX}other@test.local`, 'Owen Other', 'manager',
    ['engineering', 'tasks'])
  financeApproverId = await makeUser(
    `${EMAIL_PREFIX}finance@test.local`, 'Fay Finance', 'manager',
    ['finance', 'tasks'])
  assigneeId = await makeUser(
    `${EMAIL_PREFIX}assignee@test.local`, 'Alex Assignee', 'operator',
    ['tasks', 'logistics'])
})

/** Notifications belonging to this file's users only. */
const notificationsFor = async (userId: string) => (await db.query<{
  id: string; category: string; title: string; body: string; module: string
  entity_type: string; entity_id: string; url: string
  dedupe_key: string | null; read_at: string | null; emailed_at: string | null
  created_by: string
}>(
  `SELECT id, category, title, body, module, entity_type, entity_id, url,
          dedupe_key, read_at, emailed_at, created_by
     FROM notification WHERE user_id = $1 ORDER BY created_at`, [userId])).rows

const clearNotifications = async () => {
  await db.query(
    `DELETE FROM notification WHERE user_id IN
       (SELECT id FROM app_user WHERE email LIKE $1)`, [`${EMAIL_PREFIX}%`])
}

// ── Schema ──────────────────────────────────────────────────────────────────

describe('notification schema', () => {
  it.each(['notification', 'notification_pref'])('creates %s', async (table) => {
    const { rows } = await db.query(
      `SELECT 1 FROM information_schema.tables
        WHERE table_schema='public' AND table_name=$1`, [table])
    expect(rows).toHaveLength(1)
  })

  it.each(['notification', 'notification_pref'])(
    'enables RLS on %s with no anon/authenticated policy', async (table) => {
      const { rows } = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
        `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = $1`, [table])
      expect(rows[0].relrowsecurity).toBe(true)
      // NOT FORCE, per 20260720000000_platform_rls.sql — the owner/service-role write path
      // is where authorize() actually runs.
      expect(rows[0].relforcerowsecurity).toBe(false)

      const { rows: policies } = await db.query(
        `SELECT policyname FROM pg_policies WHERE tablename = $1`, [table])
      expect(policies).toEqual([])
    })

  it.each(['notification', 'notification_pref'])('attaches the audit trigger to %s', async (t) => {
    const { rows } = await db.query(
      `SELECT 1 FROM pg_trigger WHERE tgrelid = $1::regclass AND NOT tgisinternal`, [t])
    expect(rows.length).toBeGreaterThan(0)
  })

  /**
   * The dedupe index is the reminder sweep's idempotency. PARTIAL, so rows without a key
   * are never collapsed; PER USER, because the same event legitimately produces one row for
   * each of five approvers.
   */
  it('makes dedupe_key unique per user, partially', async () => {
    const { rows } = await db.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes
        WHERE tablename='notification' AND indexname='notification_dedupe_idx'`)
    expect(rows).toHaveLength(1)
    expect(rows[0].indexdef).toMatch(/UNIQUE/)
    expect(rows[0].indexdef).toMatch(/\(user_id, dedupe_key\)/)
    expect(rows[0].indexdef).toMatch(/WHERE \(dedupe_key IS NOT NULL\)/)
  })

  it('allows many rows with a NULL dedupe_key for one user', async () => {
    // Two devices entering Logistics on the same day are two notifications, not one.
    await clearNotifications()
    for (let i = 0; i < 2; i++) {
      await db.query(
        `INSERT INTO notification (user_id, category, title, created_by)
         VALUES ($1, 'status_handoff', 'x', $1)`, [logisticsManagerId])
    }
    expect(await notificationsFor(logisticsManagerId)).toHaveLength(2)
    await clearNotifications()
  })

  it('refuses a duplicate dedupe_key for the SAME user', async () => {
    await clearNotifications()
    const insert = () => db.query(
      `INSERT INTO notification (user_id, category, title, dedupe_key, created_by)
       VALUES ($1, 'task_reminder', 'x', 'dupe-key-1', $1)`, [logisticsManagerId])
    await insert()
    await expect(insert()).rejects.toMatchObject({ code: '23505' })
    await clearNotifications()
  })

  it('allows the SAME dedupe_key for a DIFFERENT user', async () => {
    await clearNotifications()
    for (const uid of [logisticsManagerId, otherManagerId]) {
      await db.query(
        `INSERT INTO notification (user_id, category, title, dedupe_key, created_by)
         VALUES ($1, 'task_reminder', 'x', 'shared-key', $1)`, [uid])
    }
    expect(await notificationsFor(logisticsManagerId)).toHaveLength(1)
    expect(await notificationsFor(otherManagerId)).toHaveLength(1)
    await clearNotifications()
  })

  it('defaults a preference row to in-app only', async () => {
    const { rows } = await db.query<{ in_app: boolean; email: boolean; digest: boolean }>(
      `INSERT INTO notification_pref (user_id, category) VALUES ($1, 'status_handoff')
       RETURNING in_app, email, digest`, [otherManagerId])
    expect(rows[0]).toEqual({ in_app: true, email: false, digest: false })
    await db.query(`DELETE FROM notification_pref WHERE user_id = $1`, [otherManagerId])
  })
})

// ── The drain's notification fan-out ────────────────────────────────────────

describe('drain fan-out for device handoffs (notify_roles)', () => {
  const emitHandoff = async (notifyRoles: string[] | null) => {
    const deviceId = (await db.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0].id
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload, created_by)
       VALUES ('device', $1, 'device_status_changed', $2::jsonb, $3) RETURNING id`,
      [deviceId, JSON.stringify({
        taskTemplateKey: 'logistics_prepare_delivery',
        fromStatus: 'ready_for_delivery', toStatus: 'shipped',
        reason: 'buyer collected early', deviceSn: `SN-${deviceId.slice(0, 8)}`,
        pcbaASnLegacy: null, notifyRoles,
      }), causerId])
    return { outboxId: rows[0].id, deviceId }
  }

  beforeEach(async () => {
    await clearNotifications()
    await db.query(`DELETE FROM outbox WHERE created_by = $1`, [causerId])
    await db.query(
      `DELETE FROM notification_pref WHERE user_id IN
         (SELECT id FROM app_user WHERE email LIKE $1)`, [`${EMAIL_PREFIX}%`])
  })

  it('notifies a role-holder who can enter the receiving module', async () => {
    const { deviceId } = await emitHandoff(['manager'])
    const result = await drainOutbox()
    expect(result).toMatchObject({ processed: 1, failed: 0 })

    const got = await notificationsFor(logisticsManagerId)
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({
      category: 'status_handoff',
      module: 'logistics',
      entity_type: 'device',
      entity_id: deviceId,
      read_at: null,
      // The drain writes as the automation principal, not as the human who caused it.
      created_by: SYSTEM_ACTOR_ID,
    })
    expect(got[0].title).toContain('shipped')
    // changedByName is resolved from created_by at drain time, not carried in the payload.
    expect(got[0].body).toContain('Cara Causer')

    // THE LINK TARGET IS THE HANDOFF TASK, NOT THE DEVICE — and that is deliberate
    // (buildHandoffNotification's `taskId` doc). This audience was selected by
    // RECEIVING-module access (logistics); /manufacturing/devices/[id] calls
    // notFound() without view_records in MANUFACTURING, so a device link would
    // notify exactly the people who then 404 on the click. `entity_id` above is
    // still the device, because the notification is ABOUT a device. The original
    // assertion here was `url` toContain(deviceId) — the naive expectation the
    // product deliberately rejects, so it pinned the bug rather than the rule.
    const { rows: links } = await db.query<{ task_id: string }>(
      `SELECT task_id FROM task_link WHERE entity_type = 'device' AND entity_id = $1`, [deviceId])
    expect(links).toHaveLength(1)
    expect(got[0].url).toBe(`/tasks/${links[0].task_id}`)
  })

  it('does NOT notify a role-holder who cannot enter the receiving module', async () => {
    // Owen is a manager, so notify_roles names him — but he has no logistics access, and
    // telling someone a device moved when they cannot open it is a disclosure.
    await emitHandoff(['manager'])
    await drainOutbox()
    expect(await notificationsFor(otherManagerId)).toHaveLength(0)
  })

  it('does NOT notify the person who caused the event', async () => {
    // Cara is an operator; name that role and she would otherwise be told what she just did.
    await emitHandoff(['operator'])
    await drainOutbox()
    expect(await notificationsFor(causerId)).toHaveLength(0)
  })

  it('never notifies the automation principal, even when its role is named', async () => {
    // The principal holds the operator role AND every module, so it matches broadly — and
    // it has no login path, so its bell can never be opened.
    await emitHandoff(['operator'])
    await drainOutbox()
    const { rows } = await db.query(
      `SELECT 1 FROM notification WHERE user_id = $1`, [SYSTEM_ACTOR_ID])
    expect(rows).toEqual([])
  })

  it('creates the task but no notifications when notify_roles is null', async () => {
    const { deviceId } = await emitHandoff(null)
    const result = await drainOutbox()
    expect(result).toMatchObject({ processed: 1, failed: 0, notified: 0 })
    const { rows } = await db.query(
      `SELECT 1 FROM task_link WHERE entity_id = $1`, [deviceId])
    expect(rows).toHaveLength(1)
  })

  /**
   * THE exactly-once proof for notifications. The fan-out shares the claim transaction with
   * the task insert and the processed_at stamp, so a second drain must produce nothing —
   * exactly as it produces no second task.
   */
  it('does not re-notify on a second drain', async () => {
    await emitHandoff(['manager'])
    await drainOutbox()
    expect(await notificationsFor(logisticsManagerId)).toHaveLength(1)

    const second = await drainOutbox()
    expect(second).toMatchObject({ claimed: 0, processed: 0, notified: 0 })
    expect(await notificationsFor(logisticsManagerId)).toHaveLength(1)
  })

  /**
   * A rolled-back event must leave NO notification. The unknown template key throws inside
   * the claim transaction, after the point where a fan-out on its own connection would
   * already have committed.
   */
  it('writes no notification when the event fails', async () => {
    const deviceId = (await db.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0].id
    await db.query(
      `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload, created_by)
       VALUES ('device', $1, 'device_status_changed', $2::jsonb, $3)`,
      [deviceId, JSON.stringify({
        taskTemplateKey: 'no_such_template', fromStatus: 'a', toStatus: 'b',
        reason: null, deviceSn: 'SN-X', pcbaASnLegacy: null, notifyRoles: ['manager'],
      }), causerId])

    const result = await drainOutbox()
    expect(result).toMatchObject({ processed: 0, failed: 1 })
    expect(await notificationsFor(logisticsManagerId)).toHaveLength(0)
  })

  it('respects a user who has muted the category in-app', async () => {
    await db.query(
      `INSERT INTO notification_pref (user_id, category, in_app, email, digest)
       VALUES ($1, 'status_handoff', false, false, false)`, [logisticsManagerId])
    await emitHandoff(['manager'])
    await drainOutbox()
    expect(await notificationsFor(logisticsManagerId)).toHaveLength(0)
  })

  it('leaves emailed_at NULL when email is wanted but not configured', async () => {
    // The honesty property: opting in records the WANTING; emailed_at records the SENDING,
    // and with no RESEND_API_KEY nothing was sent.
    await db.query(
      `INSERT INTO notification_pref (user_id, category, in_app, email, digest)
       VALUES ($1, 'status_handoff', true, true, false)`, [logisticsManagerId])
    await emitHandoff(['manager'])
    const result = await drainOutbox()

    const got = await notificationsFor(logisticsManagerId)
    expect(got).toHaveLength(1)
    expect(got[0].emailed_at).toBeNull()
    expect(result.emailed).toBe(0)
  })
})

// ── approval_decided: notification, no task ─────────────────────────────────

describe('drain fan-out for an approval decision', () => {
  beforeEach(async () => {
    await clearNotifications()
    await db.query(`DELETE FROM outbox WHERE created_by = $1`, [financeApproverId])
  })

  /**
   * NOTHING PRODUCES THIS EVENT YET — emitting it belongs in approvalService.decideApproval,
   * which this slice did not own. The CONSUMER is built and proven here so that adding the
   * producer is one INSERT (RB-09, "Wiring the decision notification").
   */
  it('notifies the requester and creates NO task', async () => {
    const approvalId = (await db.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0].id
    const invoiceId = (await db.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0].id

    await db.query(
      `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload, created_by)
       VALUES ('approval', $1, 'approval_decided', $2::jsonb, $3)`,
      [approvalId, JSON.stringify({
        kind: 'invoice', module: 'finance', entityType: 'sales_invoice', entityId: invoiceId,
        label: 'INV-TEST-1', decision: 'rejected', note: 'Line 3 tax code is wrong',
        requestedBy: causerId,
      }), financeApproverId])

    const result = await drainOutbox()
    expect(result).toMatchObject({ processed: 1, failed: 0 })

    const got = await notificationsFor(causerId)
    expect(got).toHaveLength(1)
    expect(got[0].category).toBe('approval_decided')
    expect(got[0].title.toLowerCase()).toContain('rejected')
    // The rejection note is the whole point of a rejection.
    expect(got[0].body).toContain('Line 3 tax code is wrong')

    // No task: the decision is the end of the work, not the start of some.
    const { rows: tasks } = await db.query(
      `SELECT 1 FROM task_link WHERE entity_id = $1`, [approvalId])
    expect(tasks).toEqual([])
  })

  it('stamps the event processed when the requester no longer exists', async () => {
    const approvalId = (await db.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0].id
    const ghostId = (await db.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)).rows[0].id
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO outbox (aggregate_type, aggregate_id, event_type, payload, created_by)
       VALUES ('approval', $1, 'approval_decided', $2::jsonb, $3) RETURNING id`,
      [approvalId, JSON.stringify({
        kind: 'invoice', module: 'finance', entityType: 'sales_invoice',
        entityId: approvalId, label: null, decision: 'approved', note: null,
        requestedBy: ghostId,
      }), financeApproverId])

    // Nobody left to tell is not an error — the decision still stands.
    const result = await drainOutbox()
    expect(result).toMatchObject({ processed: 1, failed: 0 })
    const { rows: after } = await db.query<{ processed_at: string | null }>(
      `SELECT processed_at FROM outbox WHERE id = $1`, [rows[0].id])
    expect(after[0].processed_at).not.toBeNull()
  })
})

// ── The reminder sweep ──────────────────────────────────────────────────────

describe('sweepTaskReminders', () => {
  const TODAY = new Date('2026-08-03T09:00:00.000Z')
  let taskIds: string[] = []

  const makeTask = async (title: string, dueDate: string, status = 'open') => {
    const { rows } = await db.query<{ id: string }>(
      // completed_at is not optional decoration: task's `completed_has_timestamp`
      // CHECK makes `status = 'completed'` and `completed_at IS NOT NULL` the same
      // statement, so a fixture that sets one without the other is rejected by the
      // schema. Stamped from due_date so a "completed and overdue" task is exactly
      // that, rather than one completed at an unrelated instant.
      `INSERT INTO task (title, status, priority, due_date, assignee_id, department,
                         completed_at, created_by, updated_by)
       VALUES ($1, $2, 'normal', $3::timestamptz, $4, 'Logistics',
               CASE WHEN $2 = 'completed' THEN $3::timestamptz END, $5, $5) RETURNING id`,
      [title, status, dueDate, assigneeId, causerId])
    taskIds.push(rows[0].id)
    return rows[0].id
  }

  beforeEach(async () => {
    await clearNotifications()
    if (taskIds.length) {
      await db.query(`DELETE FROM task WHERE id = ANY($1)`, [taskIds])
      taskIds = []
    }
  })

  it('notifies about a task due tomorrow', async () => {
    const taskId = await makeTask('Pack the crate', '2026-08-04T23:59:59.999Z')
    const result = await sweepTaskReminders({ today: TODAY })
    expect(result).toMatchObject({ due: 1, created: 1 })

    const got = await notificationsFor(assigneeId)
    expect(got).toHaveLength(1)
    expect(got[0]).toMatchObject({
      category: 'task_reminder', module: 'tasks', entity_type: 'task', entity_id: taskId,
      dedupe_key: `${reminderDedupeKey('due_tomorrow', taskId, TODAY)}:${assigneeId}`,
    })
    expect(got[0].title).toContain('Pack the crate')
  })

  it('notifies about an overdue task', async () => {
    await makeTask('Ship it', '2026-08-01T23:59:59.999Z')
    await sweepTaskReminders({ today: TODAY })
    const got = await notificationsFor(assigneeId)
    expect(got).toHaveLength(1)
    expect(got[0].title.toLowerCase()).toContain('overdue')
  })

  /**
   * THE IDEMPOTENCY PROOF, and the reason the dedupe key exists at all. Running twice on
   * the same day must notify nobody twice — as a property of the DATA (a unique index), so
   * it holds under a crashed half-run and under two sweeps racing, neither of which a
   * "have I run today?" flag survives.
   */
  it('creates NOTHING on a second run the same day', async () => {
    await makeTask('Pack the crate', '2026-08-04T23:59:59.999Z')

    const first = await sweepTaskReminders({ today: TODAY })
    expect(first).toMatchObject({ due: 1, created: 1 })

    const second = await sweepTaskReminders({ today: TODAY })
    // Still DUE — the task is still due tomorrow — but nothing was CREATED.
    expect(second).toMatchObject({ due: 1, created: 0 })
    expect(await notificationsFor(assigneeId)).toHaveLength(1)
  })

  it('is idempotent across many runs, not just two', async () => {
    await makeTask('Pack the crate', '2026-08-04T23:59:59.999Z')
    for (let i = 0; i < 5; i++) await sweepTaskReminders({ today: TODAY })
    expect(await notificationsFor(assigneeId)).toHaveLength(1)
  })

  it('re-notifies about an overdue task on the NEXT day', async () => {
    // A task overdue for a week should nag daily; the day component of the key is what
    // makes that true without the sweep remembering anything.
    await makeTask('Ship it', '2026-08-01T23:59:59.999Z')
    await sweepTaskReminders({ today: TODAY })
    await sweepTaskReminders({ today: new Date('2026-08-04T09:00:00.000Z') })
    expect(await notificationsFor(assigneeId)).toHaveLength(2)
  })

  it.each([
    ['due today', '2026-08-03T23:59:59.999Z', 'open'],
    ['due next week', '2026-08-09T23:59:59.999Z', 'open'],
    ['completed and overdue', '2026-08-01T00:00:00.000Z', 'completed'],
    ['cancelled and overdue', '2026-08-01T00:00:00.000Z', 'cancelled'],
  ])('says nothing about a task %s', async (_label, due, status) => {
    await makeTask('Quiet task', due, status)
    const result = await sweepTaskReminders({ today: TODAY })
    expect(result.created).toBe(0)
    expect(await notificationsFor(assigneeId)).toHaveLength(0)
  })

  it('respects a user who muted task reminders', async () => {
    await db.query(
      `INSERT INTO notification_pref (user_id, category, in_app, email, digest)
       VALUES ($1, 'task_reminder', false, false, false)
       ON CONFLICT (user_id, category) DO UPDATE SET in_app = false, email = false`,
      [assigneeId])
    await makeTask('Pack the crate', '2026-08-04T23:59:59.999Z')

    const result = await sweepTaskReminders({ today: TODAY })
    expect(result).toMatchObject({ due: 1, created: 0 })
    expect(await notificationsFor(assigneeId)).toHaveLength(0)

    await db.query(
      `DELETE FROM notification_pref WHERE user_id = $1 AND category = 'task_reminder'`,
      [assigneeId])
  })
})

// ── The override-expiry job ─────────────────────────────────────────────────

describe('expireOverrides', () => {
  const permissionId = async () => (await db.query<{ id: string }>(
    `SELECT id FROM permission WHERE key = 'export_data'`)).rows[0].id

  it('soft-deletes an override whose expiry has passed', async () => {
    const pid = await permissionId()
    await db.query(
      `INSERT INTO user_permission_override (user_id, permission_id, granted, reason,
                                             expires_at, created_by, updated_by)
       VALUES ($1, $2, true, 'test', now() - interval '1 hour', $1, $1)
       ON CONFLICT (user_id, permission_id) DO UPDATE SET
         expires_at = now() - interval '1 hour', deleted_at = NULL, granted = true`,
      [otherManagerId, pid])

    const result = await expireOverrides()
    expect(result.expired).toBeGreaterThanOrEqual(1)

    const { rows } = await db.query<{ deleted_at: string | null }>(
      `SELECT deleted_at FROM user_permission_override
        WHERE user_id = $1 AND permission_id = $2`, [otherManagerId, pid])
    // SOFT delete: the row survives so a re-grant can resurrect it via the documented upsert.
    expect(rows[0].deleted_at).not.toBeNull()
  })

  it('leaves an override that has NOT expired alone', async () => {
    const pid = await permissionId()
    await db.query(
      `INSERT INTO user_permission_override (user_id, permission_id, granted, reason,
                                             expires_at, created_by, updated_by)
       VALUES ($1, $2, true, 'test', now() + interval '1 day', $1, $1)
       ON CONFLICT (user_id, permission_id) DO UPDATE SET
         expires_at = now() + interval '1 day', deleted_at = NULL, granted = true`,
      [financeApproverId, pid])

    await expireOverrides()
    const { rows } = await db.query<{ deleted_at: string | null }>(
      `SELECT deleted_at FROM user_permission_override
        WHERE user_id = $1 AND permission_id = $2`, [financeApproverId, pid])
    expect(rows[0].deleted_at).toBeNull()

    await db.query(
      `DELETE FROM user_permission_override WHERE user_id = $1 AND permission_id = $2`,
      [financeApproverId, pid])
  })

  it('is idempotent — a second run expires nothing new', async () => {
    await expireOverrides()
    const second = await expireOverrides()
    expect(second.expired).toBe(0)
  })

  it('never touches the automation principal, whose revocations cannot carry an expiry', async () => {
    // trg_forbid_system_actor_grant refuses a non-NULL expires_at on its overrides, so none
    // can ever match this job's predicate. Asserted rather than assumed.
    const { rows } = await db.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM user_permission_override
        WHERE user_id = $1 AND (expires_at IS NOT NULL OR deleted_at IS NOT NULL)`,
      [SYSTEM_ACTOR_ID])
    expect(rows[0].n).toBe(0)
  })
})
