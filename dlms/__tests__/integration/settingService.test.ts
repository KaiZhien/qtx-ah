// __tests__/integration/settingService.test.ts
//
// The Super Admin settings console's read and write path against a real database.
//
// The thing this file exists to prove is narrow and important: a knob is typed on
// the way IN, so a threshold can never become the string "abc" and be discovered
// at issue time — AND the fail-closed behaviour at the reader is UNCHANGED by the
// console's existence. Those two are tested together on purpose, because the
// tempting way to make a settings screen pleasant is to give it a default, and a
// default is exactly what the reader's design rejects.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import { withTransaction, OptimisticLockError } from '@/lib/db/tx'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'
import {
  listSettings, updateSetting, getNumericSettingInTx,
  SettingNotEditableError, SettingUnavailableError, FINANCE_APPROVAL_THRESHOLD_SGD,
} from '@/modules/shared/settings/services/settingService'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client
let adminId: string

/** Every probe key this file writes starts with this, so teardown is one predicate. */
const PROBE_PREFIX = 'zz_setting_probe_'
const probeKeys: string[] = []

/** The real, seeded threshold — restored in afterAll so other files see it unchanged. */
let seededThreshold: string | null = null

const admin = (over: Partial<Actor> = {}): Actor => ({
  id: adminId, roleKey: 'super_admin',
  permissions: new Set(['manage_settings', 'view_records']),
  moduleAccess: new Set(['admin']), active: true, ...over,
})
const nobody = (): Actor => ({
  id: adminId, roleKey: 'viewer',
  permissions: new Set(['view_records']), moduleAccess: new Set(['admin']), active: true,
})

async function makeProbe(key: string, value: string) {
  const full = `${PROBE_PREFIX}${key}`
  probeKeys.push(full)
  await db.query(
    `INSERT INTO app_setting (key, value, created_by, updated_by)
     VALUES ($1, $2::jsonb, $3, $3)
     ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`, [full, value, adminId])
  return full
}

const settingRow = async (key: string) => (await db.query<{
  value: unknown; value_type: string; version: number; updated_by: string | null
}>(`SELECT value, jsonb_typeof(value) AS value_type, version, updated_by
      FROM app_setting WHERE key = $1`, [key])).rows[0]

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  adminId = (await db.query(
    `SELECT id FROM app_user WHERE email = 'reetmitra8@gmail.com'`)).rows[0].id
  const seeded = await db.query<{ value: string }>(
    `SELECT value::text AS value FROM app_setting WHERE key = $1`,
    [FINANCE_APPROVAL_THRESHOLD_SGD])
  seededThreshold = seeded.rows[0]?.value ?? null
})

afterAll(async () => {
  // The threshold is SHARED state: financeService.test.ts and approvalService.test.ts
  // both depend on its seeded value, so anything this file did to it is undone.
  if (seededThreshold !== null) {
    await db.query(
      `UPDATE app_setting SET value = $2::jsonb, version = version + 1 WHERE key = $1`,
      [FINANCE_APPROVAL_THRESHOLD_SGD, seededThreshold])
  }
  await db.query(`DELETE FROM app_setting WHERE key LIKE $1`, [`${PROBE_PREFIX}%`])
  // app_setting is text-keyed, so its audit rows carry row_id NULL — found by key.
  await db.query(
    `DELETE FROM audit_log WHERE table_name='app_setting'
       AND coalesce(new_values->>'key', old_values->>'key') LIKE $1`, [`${PROBE_PREFIX}%`])
  await db.end()
  await getPool().end()
})

// ═══════════════════════════════════════════════════════════════════════════
describe('listSettings', () => {
  it('refuses an actor without manage_settings', async () => {
    await expect(listSettings(nobody())).rejects.toThrow(PermissionError)
  })

  it('returns the seeded finance threshold, typed and labelled from the registry', async () => {
    const rows = await listSettings(admin())
    const threshold = rows.find((r) => r.key === FINANCE_APPROVAL_THRESHOLD_SGD)
    expect(threshold).toBeTruthy()
    expect(threshold!.valueType).toBe('number')
    expect(threshold!.entry).toBeTruthy()
    expect(threshold!.entry!.type).toBe('number')
  })

  it('INCLUDES an unregistered key, marked as not editable', async () => {
    // Hiding it would make the table look emptier than the database is, and the
    // row an operator most needs to see is the one nobody declared.
    const key = await makeProbe('unknown_knob', '"whatever"')
    const rows = await listSettings(admin())
    const found = rows.find((r) => r.key === key)
    expect(found).toBeTruthy()
    expect(found!.entry).toBeNull()
    expect(found!.valueType).toBe('string')
  })

  it('is ordered by key, so the console does not reshuffle between loads', async () => {
    const keys = (await listSettings(admin())).map((r) => r.key)
    expect(keys).toEqual([...keys].sort())
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('updateSetting', () => {
  it('refuses an actor without manage_settings, and writes nothing', async () => {
    const before = await settingRow(FINANCE_APPROVAL_THRESHOLD_SGD)
    await expect(updateSetting(nobody(), {
      key: FINANCE_APPROVAL_THRESHOLD_SGD, value: '9999', version: before.version }))
      .rejects.toThrow(PermissionError)
    expect((await settingRow(FINANCE_APPROVAL_THRESHOLD_SGD)).value).toEqual(before.value)
  })

  it('stores a number as a bare JSON number, not as a string', async () => {
    // The seed comment is explicit: the threshold is the number 5000, not "5000"
    // and not {"amount": 5000}. A string here passes the column and then fails the
    // reader's jsonb_typeof check — a knob that looks set and behaves as unset.
    const before = await settingRow(FINANCE_APPROVAL_THRESHOLD_SGD)
    await updateSetting(admin(), {
      key: FINANCE_APPROVAL_THRESHOLD_SGD, value: '7500', version: before.version })

    const after = await settingRow(FINANCE_APPROVAL_THRESHOLD_SGD)
    expect(after.value_type).toBe('number')
    expect(after.value).toBe(7500)
    expect(after.version).toBe(before.version + 1)
    expect(after.updated_by).toBe(adminId)
  })

  it('the READER sees the new value immediately — no cache, no deploy', async () => {
    const before = await settingRow(FINANCE_APPROVAL_THRESHOLD_SGD)
    await updateSetting(admin(), {
      key: FINANCE_APPROVAL_THRESHOLD_SGD, value: '12345.67', version: before.version })

    const read = await withTransaction(adminId, (tx) =>
      getNumericSettingInTx(tx, FINANCE_APPROVAL_THRESHOLD_SGD))
    expect(read).toBe('12345.67')
  })

  /**
   * THE POINT OF TYPING THE REGISTRY. Before the console this was the failure
   * waiting to happen: a hand-written UPDATE puts a string in the column, and it
   * surfaces days later as "no invoice can be issued".
   */
  it('REFUSES a non-numeric threshold at WRITE time, leaving the value untouched', async () => {
    const before = await settingRow(FINANCE_APPROVAL_THRESHOLD_SGD)
    for (const bad of ['abc', '', '1e5', '1,000', 'true']) {
      await expect(updateSetting(admin(), {
        key: FINANCE_APPROVAL_THRESHOLD_SGD, value: bad, version: before.version }))
        .rejects.toThrow(SettingNotEditableError)
    }
    const after = await settingRow(FINANCE_APPROVAL_THRESHOLD_SGD)
    expect(after.value).toEqual(before.value)
    expect(after.version).toBe(before.version)
  })

  it('refuses to edit an UNREGISTERED key even though the row exists', async () => {
    const key = await makeProbe('untyped', '42')
    const row = await settingRow(key)
    const err = await updateSetting(admin(), {
      key, value: '43', version: row.version }).catch((e) => e)
    expect(err).toBeInstanceOf(SettingNotEditableError)
    expect(err.message.toLowerCase()).toContain('not a setting this console knows')
    expect((await settingRow(key)).value).toBe(42)
  })

  it('refuses to CREATE a key, so a typo cannot become a second knob', async () => {
    // The real danger: `finance_approval_threshold_sg` sitting beside the real
    // key, the console showing a plausible value, and the reader failing closed
    // on a row nobody is looking at.
    const err = await updateSetting(admin(), {
      key: 'finance_approval_threshold_sg', value: '5000', version: 1 }).catch((e) => e)
    expect(err).toBeInstanceOf(SettingNotEditableError)
    const { rows } = await db.query(
      `SELECT 1 FROM app_setting WHERE key = 'finance_approval_threshold_sg'`)
    expect(rows).toHaveLength(0)
  })

  it('refuses a key the column CHECK would reject, before touching the database', async () => {
    await expect(updateSetting(admin(), {
      key: 'Finance Threshold', value: '5000', version: 1 })).rejects.toThrow()
  })

  it('arbitrates two admins editing at once via the optimistic lock', async () => {
    const before = await settingRow(FINANCE_APPROVAL_THRESHOLD_SGD)
    await updateSetting(admin(), {
      key: FINANCE_APPROVAL_THRESHOLD_SGD, value: '6000', version: before.version })
    // The second admin still holds the version they loaded.
    await expect(updateSetting(admin(), {
      key: FINANCE_APPROVAL_THRESHOLD_SGD, value: '8000', version: before.version }))
      .rejects.toThrow(OptimisticLockError)
    expect((await settingRow(FINANCE_APPROVAL_THRESHOLD_SGD)).value).toBe(6000)
  })

  it('records WHO changed it and WHEN in the audit trail', async () => {
    // "Who raised the approval threshold, and when?" is exactly the question an
    // auditor asks, and the answer has to be in audit_log rather than in memory.
    const before = await settingRow(FINANCE_APPROVAL_THRESHOLD_SGD)
    await updateSetting(admin(), {
      key: FINANCE_APPROVAL_THRESHOLD_SGD, value: '4321', version: before.version })

    const { rows } = await db.query<{ action: string; actor_id: string; new_values: unknown }>(
      `SELECT action, actor_id, new_values FROM audit_log
        WHERE table_name = 'app_setting'
          AND coalesce(new_values->>'key', old_values->>'key') = $1
        -- audit_log's time column is occurred_at (20260718000001_platform_audit.sql:54).
        -- changed_at is repair_status_history's; there is no such column here.
        ORDER BY occurred_at DESC LIMIT 1`, [FINANCE_APPROVAL_THRESHOLD_SGD])
    expect(rows[0].action.toLowerCase()).toBe('update')
    expect(rows[0].actor_id).toBe(adminId)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
describe('the fail-closed contract survives the console', () => {
  it('a MISSING knob still refuses loudly, naming the setting', async () => {
    const err = await withTransaction(adminId, (tx) =>
      getNumericSettingInTx(tx, `${PROBE_PREFIX}never_set`)).catch((e) => e)
    expect(err).toBeInstanceOf(SettingUnavailableError)
    expect(err.message).toContain(`${PROBE_PREFIX}never_set`)
    expect(err.message).toContain('never been set')
  })

  it('a knob holding the WRONG TYPE still refuses, naming what it found', async () => {
    const key = await makeProbe('wrong_type', '"5000"')
    const err = await withTransaction(adminId, (tx) =>
      getNumericSettingInTx(tx, key)).catch((e) => e)
    expect(err).toBeInstanceOf(SettingUnavailableError)
    expect(err.message).toContain('holds a string')
  })

  it('the console offers NO way to unset a knob, so the refusal stays reachable only by SQL',
    async () => {
      // There is no delete/clear entry point: `updateSetting` is the whole write
      // surface and it always writes a validated value. Pinned as a fact, because
      // adding a "Clear" button is the natural next feature request and it would
      // turn a loud misconfiguration into a silent one.
      const service = await import('@/modules/shared/settings/services/settingService')
      const writeNames = Object.keys(service).filter((n) => /delete|clear|unset|remove|create/i.test(n))
      expect(writeNames).toEqual([])
    })
})
