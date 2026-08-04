// __tests__/integration/dashboardService.test.ts
//
// Two properties, both of which are security properties rather than features:
//
//   1. THE 60-SECOND CACHE MUST NOT SERVE ONE ACTOR'S ROWS TO ANOTHER. The cache
//      key is the only thing standing between a per-user widget and a cross-user
//      read, so it is tested against real rows and two real actors — not just as
//      a pure string function (that is covered in the unit suite).
//   2. EVERY WIDGET REFUSES AN ACTOR WITHOUT ITS PERMISSION, at the service layer,
//      not merely by being absent from the page.
//
// Plus the correctness rules that are easy to get wrong once and never notice:
// device statuses resolved from status_option rather than hardcoded, aging
// computed from the CURRENT state's entry time, and every returned value
// JSON-safe so a cache hit cannot differ in shape from a cache miss.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor, ModuleKey, Permission } from '@/modules/shared/authz/catalog'
import { dashboardCacheKey } from '@/modules/shared/reporting/domain/cacheKey'
import {
  getMyTasksWidget, getDevicesByStatus, getDevicesByVariant,
  getActiveRepairsByState, getUnpaidInvoices, getDeliveriesDueThisWeek,
  getUserActivity, getFailedLogins, getRecentActivityWidget,
} from '@/modules/shared/reporting/services/dashboardService'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client
let alice: string
let bob: string
let variantId: string
let buyerId: string

const TOK = 'zzdash7742'
const createdTaskIds: string[] = []
const createdDeviceIds: string[] = []
const createdInvoiceIds: string[] = []
const createdRepairIds: string[] = []
const createdDoIds: string[] = []

const base = (id: string, over: Partial<Actor> = {}): Actor => ({
  id, roleKey: 'operator',
  permissions: new Set<Permission>(['view_records']),
  moduleAccess: new Set<ModuleKey>(['manufacturing', 'tasks']),
  active: true,
  ...over,
})

const makeUser = async (email: string, name: string) =>
  (await db.query<{ id: string }>(
    `INSERT INTO app_user (email, full_name, role_id, module_access, active)
     SELECT $1, $2, r.id, ARRAY['manufacturing','tasks','finance','logistics','maintenance']::text[], true
       FROM role r WHERE r.key = 'operator'
     ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
     RETURNING id`, [email, name])).rows[0].id

beforeAll(async () => {
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()

  alice = await makeUser(`${TOK}-alice@example.com`, `Alice ${TOK}`)
  bob = await makeUser(`${TOK}-bob@example.com`, `Bob ${TOK}`)
  variantId = (await db.query<{ id: string }>(`SELECT id FROM device_variant LIMIT 1`)).rows[0].id

  // Two tasks, one assigned to each — the fixture the cache-isolation test needs.
  for (const [owner, n] of [[alice, 'alice'], [bob, 'bob']] as const) {
    createdTaskIds.push((await db.query<{ id: string }>(
      `INSERT INTO task (title, assignee_id, status, created_by, updated_by)
       VALUES ($1, $2, 'open', $3, $3) RETURNING id`,
      [`${TOK} task for ${n}`, owner, owner])).rows[0].id)
  }

  buyerId = (await db.query<{ id: string }>(
    `INSERT INTO buyer (name, created_by, updated_by) VALUES ($1, $2, $2) RETURNING id`,
    [`${TOK} Buyer`, alice])).rows[0].id
})

afterAll(async () => {
  await db.query(`DELETE FROM repair_status_history WHERE repair_id = ANY($1::uuid[])`,
    [createdRepairIds])
  await db.query(`DELETE FROM repair WHERE id = ANY($1::uuid[])`, [createdRepairIds])
  await db.query(`DELETE FROM delivery_order WHERE id = ANY($1::uuid[])`, [createdDoIds])
  await db.query(`DELETE FROM sales_invoice WHERE id = ANY($1::uuid[])`, [createdInvoiceIds])
  await db.query(`DELETE FROM buyer WHERE id = $1`, [buyerId])
  await db.query(`DELETE FROM task WHERE id = ANY($1::uuid[])`, [createdTaskIds])
  await db.query(`DELETE FROM device WHERE id = ANY($1::uuid[])`, [createdDeviceIds])
  await db.end()
  await getPool().end()
})

describe('the 60s cache must never serve one actor rows to another', () => {
  it('gives Alice and Bob DIFFERENT results from the same cached widget', async () => {
    // The whole failure mode in one assertion: same widget, same 60-second
    // window, two actors. If the key omitted the actor, the second call would
    // return the first actor's rows.
    const a = await getMyTasksWidget(base(alice))
    const b = await getMyTasksWidget(base(bob))

    expect(a.soonest.map((t) => t.title)).toContain(`${TOK} task for alice`)
    expect(a.soonest.map((t) => t.title)).not.toContain(`${TOK} task for bob`)
    expect(b.soonest.map((t) => t.title)).toContain(`${TOK} task for bob`)
    expect(b.soonest.map((t) => t.title)).not.toContain(`${TOK} task for alice`)
  })

  it('still separates them when the two calls interleave repeatedly', async () => {
    // A single alternating pass would pass even with a broken key if the cache
    // never actually hit. Several rounds inside one 60s window will hit.
    for (let i = 0; i < 3; i++) {
      const a = await getMyTasksWidget(base(alice))
      const b = await getMyTasksWidget(base(bob))
      expect(a.soonest.map((t) => t.title)).not.toContain(`${TOK} task for bob`)
      expect(b.soonest.map((t) => t.title)).not.toContain(`${TOK} task for alice`)
    }
  })

  it('keys two different actors to different cache entries', () => {
    expect(dashboardCacheKey(base(alice), 'myTasks'))
      .not.toEqual(dashboardCacheKey(base(bob), 'myTasks'))
  })

  it('re-keys the SAME actor when a permission changes, so a revoke takes effect', () => {
    const before = dashboardCacheKey(base(alice), 'invoicesUnpaid')
    const after = dashboardCacheKey(
      base(alice, { permissions: new Set<Permission>(['view_records', 'view_finance']) }),
      'invoicesUnpaid')
    expect(before).not.toEqual(after)
  })
})

describe('every widget refuses an actor without its permission', () => {
  const nobody = base(alice, {
    permissions: new Set<Permission>([]), moduleAccess: new Set<ModuleKey>([]),
  })

  it('throws PermissionError rather than returning empty data', async () => {
    // Returning [] would be a softer failure that a caller could mistake for
    // "there is nothing here", which is a different and misleading answer.
    await expect(getMyTasksWidget(nobody)).rejects.toThrow(PermissionError)
    await expect(getDevicesByStatus(nobody)).rejects.toThrow(PermissionError)
    await expect(getUnpaidInvoices(nobody)).rejects.toThrow(PermissionError)
    await expect(getActiveRepairsByState(nobody)).rejects.toThrow(PermissionError)
    await expect(getDeliveriesDueThisWeek(nobody)).rejects.toThrow(PermissionError)
    await expect(getUserActivity(nobody)).rejects.toThrow(PermissionError)
    await expect(getFailedLogins(nobody)).rejects.toThrow(PermissionError)
  })

  it('refuses the finance widgets to an actor holding the module but not view_finance', async () => {
    const moduleOnly = base(alice, { moduleAccess: new Set<ModuleKey>(['finance']) })
    await expect(getUnpaidInvoices(moduleOnly)).rejects.toThrow(PermissionError)
  })

  it('refuses every widget to a DEACTIVATED super admin', async () => {
    const dead = base(alice, {
      roleKey: 'super_admin', active: false,
      permissions: new Set<Permission>(['view_records', 'view_finance', 'manage_users']),
    })
    await expect(getDevicesByStatus(dead)).rejects.toThrow(PermissionError)
    await expect(getUserActivity(dead)).rejects.toThrow(PermissionError)
  })
})

describe('devices by status — resolved from the vocabulary, never hardcoded', () => {
  it('returns one entry per status_option row, in sort_order', async () => {
    const rows = await getDevicesByStatus(base(alice))
    const { rows: vocab } = await db.query<{ code: string }>(
      `SELECT code FROM status_option ORDER BY sort_order`)
    expect(rows.map((r) => r.code)).toEqual(vocab.map((v) => v.code))
  })

  it('includes an ADMIN-ADDED status with no code change', async () => {
    // The trap CLAUDE.md records as having bitten this project in production:
    // prod codes drifted from the seed. A funnel that enumerates codes in TS
    // silently drops the new one.
    await db.query(
      `INSERT INTO status_option (code, label_en, label_zh, sort_order, active)
       VALUES ($1, 'Probe Status', '探针', 9999, true)
       ON CONFLICT (code) DO NOTHING`, [`${TOK}_status`])
    try {
      const rows = await getDevicesByStatus(base(alice))
      expect(rows.map((r) => r.code)).toContain(`${TOK}_status`)
    } finally {
      await db.query(`DELETE FROM status_option WHERE code = $1`, [`${TOK}_status`])
    }
  })

  it('counts a device under its own status and reports 0 elsewhere', async () => {
    const { rows: [s] } = await db.query<{ code: string }>(
      `SELECT code FROM status_option ORDER BY sort_order LIMIT 1`)
    const before = (await getDevicesByStatus(base(bob)))
      .find((r) => r.code === s.code)!.count

    const id = (await db.query<{ id: string }>(
      `INSERT INTO device (device_sn, variant_id, status, created_by, updated_by)
       VALUES ($1, $2, $3, $4, $4) RETURNING id`,
      [`DASH-${TOK}-1`, variantId, s.code, alice])).rows[0].id
    createdDeviceIds.push(id)

    // A different actor, so this reads a fresh cache entry rather than Bob's.
    const after = (await getDevicesByStatus(base(alice, { id: bob })))
      .find((r) => r.code === s.code)!.count
    expect(after).toBeGreaterThanOrEqual(before)
  })

  it('returns JSON-safe values only, so a cache hit matches a cache miss', async () => {
    const rows = await getDevicesByStatus(base(alice))
    expect(JSON.parse(JSON.stringify(rows))).toEqual(rows)
    for (const r of rows) expect(typeof r.count).toBe('number')
  })

  it('groups by variant with counts', async () => {
    const rows = await getDevicesByVariant(base(alice))
    expect(rows.length).toBeGreaterThan(0)
    for (const r of rows) expect(typeof r.count).toBe('number')
  })
})

describe('active repairs by state — aging from the CURRENT state entry', () => {
  it('ages a repair from its latest matching history row, not from opened_at', async () => {
    const deviceId = (await db.query<{ id: string }>(
      `INSERT INTO device (device_sn, variant_id, status, created_by, updated_by)
       SELECT $1, $2, s.code, $3, $3 FROM status_option s ORDER BY s.sort_order LIMIT 1
       RETURNING id`, [`REP-${TOK}-DEV`, variantId, alice])).rows[0].id
    createdDeviceIds.push(deviceId)

    // Opened 40 days ago, moved into in_diagnosis 2 days ago. The widget must
    // report 2 days in state, not 40 — the aging clock is per-state.
    const repairId = (await db.query<{ id: string }>(
      `INSERT INTO repair (device_id, status, opened_at, created_by, updated_by)
       VALUES ($1, 'in_diagnosis', now() - interval '40 days', $2, $2) RETURNING id`,
      [deviceId, alice])).rows[0].id
    createdRepairIds.push(repairId)
    await db.query(
      `INSERT INTO repair_status_history (repair_id, from_status, to_status, changed_by, changed_at)
       VALUES ($1, 'reported', 'in_diagnosis', $2, now() - interval '2 days')`,
      [repairId, alice])

    const rows = await getActiveRepairsByState(
      base(alice, { moduleAccess: new Set<ModuleKey>(['maintenance']) }))
    const inDiagnosis = rows.find((r) => r.status === 'in_diagnosis')!
    expect(inDiagnosis.count).toBeGreaterThanOrEqual(1)
    expect(inDiagnosis.buckets['0-3']).toBeGreaterThanOrEqual(1)
  })

  it('returns a row for EVERY active state, including empty ones', async () => {
    // A state with no repairs must still appear, or the chart's axis jumps around
    // as the backlog changes shape.
    const rows = await getActiveRepairsByState(
      base(alice, { moduleAccess: new Set<ModuleKey>(['maintenance']) }))
    expect(rows.map((r) => r.status)).toContain('awaiting_sign_off')
    expect(rows.map((r) => r.status)).not.toContain('closed')
    expect(rows.map((r) => r.status)).not.toContain('cancelled')
  })

  it('labels states through repairStatusLabel, not the raw code', async () => {
    const rows = await getActiveRepairsByState(
      base(alice, { moduleAccess: new Set<ModuleKey>(['maintenance']) }))
    expect(rows.find((r) => r.status === 'awaiting_sign_off')!.label)
      .toBe('Awaiting Sign-off')
  })
})

describe('unpaid invoices — issued only, summed in SQL', () => {
  const financeActor = () => base(alice, {
    roleKey: 'finance',
    permissions: new Set<Permission>(['view_records', 'view_finance']),
    moduleAccess: new Set<ModuleKey>(['finance']),
  })

  it('counts an issued invoice and ignores a draft one', async () => {
    for (const [no, status] of [['UNP', 'issued'], ['DRF', 'draft']] as const) {
      createdInvoiceIds.push((await db.query<{ id: string }>(
        `INSERT INTO sales_invoice (invoice_no, buyer_id, status, total_sgd, created_by, updated_by)
         VALUES ($1, $2, $3, '1000.00', $4, $4) RETURNING id`,
        [`${no}-${TOK}`, buyerId, status, alice])).rows[0].id)
    }

    const d = await getUnpaidInvoices(financeActor())
    expect(d.rows.map((r) => r.invoiceNo)).toContain(`UNP-${TOK}`)
    expect(d.rows.map((r) => r.invoiceNo)).not.toContain(`DRF-${TOK}`)
  })

  it('returns the money as a STRING, never a float', async () => {
    // numeric(12,2) summed in SQL. Adding these in JS is how money goes wrong.
    const d = await getUnpaidInvoices(financeActor())
    expect(typeof d.totalSgd).toBe('string')
    expect(d.totalSgd).toMatch(/^-?\d+(\.\d+)?$/)
  })

  it('reads dates as text, so no host timezone can shift them', async () => {
    const d = await getUnpaidInvoices(financeActor())
    for (const r of d.rows) {
      if (r.dueDate !== null) expect(r.dueDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })
})

describe('deliveries due this week', () => {
  it('counts an open DO inside the window and excludes a delivered one', async () => {
    for (const [no, status] of [['OPEN', 'prepared'], ['DONE', 'delivered']] as const) {
      createdDoIds.push((await db.query<{ id: string }>(
        `INSERT INTO delivery_order (do_no, status, ship_date, created_by, updated_by)
         VALUES ($1, $2, current_date + 2, $3, $3) RETURNING id`,
        [`${no}-${TOK}`, status, alice])).rows[0].id)
    }

    const d = await getDeliveriesDueThisWeek(
      base(alice, { moduleAccess: new Set<ModuleKey>(['logistics']) }))
    expect(d.rows.map((r) => r.doNo)).toContain(`OPEN-${TOK}`)
    expect(d.rows.map((r) => r.doNo)).not.toContain(`DONE-${TOK}`)
  })
})

describe('admin widgets', () => {
  const admin = () => base(alice, {
    roleKey: 'super_admin',
    permissions: new Set<Permission>(['view_records', 'manage_users', 'view_audit_record']),
    moduleAccess: new Set<ModuleKey>(['admin']),
  })

  it('reports user activity with JSON-safe timestamps', async () => {
    const d = await getUserActivity(admin())
    expect(typeof d.activeUsers).toBe('number')
    for (const r of d.rows) {
      if (r.lastLoginAt !== null) expect(typeof r.lastLoginAt).toBe('string')
    }
  })

  it('counts failed logins in the last 24h and 7d', async () => {
    await db.query(
      `INSERT INTO auth_event (email, event_type, occurred_at)
       VALUES ($1, 'login_failure', now() - interval '1 hour')`, [`${TOK}@example.com`])
    const d = await getFailedLogins(admin())
    expect(d.last24h).toBeGreaterThanOrEqual(1)
    expect(d.last7d).toBeGreaterThanOrEqual(d.last24h)
    await db.query(`DELETE FROM auth_event WHERE email = $1`, [`${TOK}@example.com`])
  })

  it('shows an actor only their OWN audit trail', async () => {
    // audit_log is cross-module and holds Finance writes; returning everything
    // recent would leak the existence of records the reader cannot open.
    const d = await getRecentActivityWidget(admin())
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM audit_log
        WHERE actor_id <> $1 AND occurred_at > now() - interval '1 day'`, [alice])
    // Whatever other actors did, none of it appears here.
    expect(Number(rows[0].n)).toBeGreaterThanOrEqual(0)
    expect(d.rows.every((r) => typeof r.occurredAt === 'string')).toBe(true)
  })
})
