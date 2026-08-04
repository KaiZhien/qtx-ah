// __tests__/integration/warrantyService.test.ts
//
// Run and green as of the 2026-08-04 merge (`npm run test:integration`). The
// harness (__tests__/integration/setup.ts) picks up
// 20260803120000_platform_finance_warranty.sql automatically — the filename
// matches PLATFORM_MIGRATION_RE.
//
// Idiom mirrors __tests__/integration/financeService.test.ts: mock
// @/lib/supabase/server, connect real pg via TEST_DATABASE_URL, runTag so rows
// are unique per run, afterAll cleanup of everything this file creates. The DB
// is shared and NOT rolled back between files, so every assertion is scoped to
// rows this file made — never a global count.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import {
  getDeviceWarranty, listDeviceWarrantyHistory, getExpiringWarranties,
  getWarrantyExpiryCounts, createWarranty, updateWarranty, renewWarranty, removeWarranty,
  WarrantyNotFoundError, DuplicateWarrantyError,
} from '@/modules/finance/services/warrantyService'
import { InvalidWarrantyPeriodError } from '@/modules/finance/domain/warrantyStatus'
import { DeviceNotFoundError } from '@/modules/manufacturing/services/deviceWriteService'
import { OptimisticLockError } from '@/lib/db/tx'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client
let userId: string
const runTag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const createdDeviceIds: string[] = []
const createdWarrantyIds: string[] = []

// finance role: view_records + manage_finance, Finance module.
const fin = (): Actor => ({
  id: userId, roleKey: 'finance',
  permissions: new Set(['view_records', 'create_records', 'edit_records', 'view_finance', 'manage_finance']),
  moduleAccess: new Set(['finance']), active: true,
})
// Viewer never holds view_finance — but warranty READS are gated on
// view_records-in-finance precisely so this actor CAN see cover dates.
const viewer = (): Actor => ({
  id: userId, roleKey: 'viewer',
  permissions: new Set(['view_records']), moduleAccess: new Set(['finance']), active: true,
})
// Manager with Finance module access but no manage_finance (spec §3.2 footnote ①).
const mgrView = (): Actor => ({
  id: userId, roleKey: 'manager',
  permissions: new Set(['view_records', 'view_finance']),
  moduleAccess: new Set(['finance']), active: true,
})
// Every finance permission, never granted the Finance module.
const noModuleAccess = (): Actor => ({
  id: userId, roleKey: 'operator',
  permissions: new Set(['view_records', 'view_finance', 'manage_finance']),
  moduleAccess: new Set(['manufacturing']), active: true,
})

/**
 * Device status resolved FROM status_option, never a hardcoded seed code —
 * CLAUDE.md: prod codes drifted from seed.sql ('In Stock' not 'Stock'), and this
 * test must not encode either spelling.
 */
async function makeDevice(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO device (device_sn, variant_id, status, created_by, updated_by)
     VALUES ($1,
             (SELECT id FROM device_variant ORDER BY code LIMIT 1),
             (SELECT code FROM status_option WHERE is_initial ORDER BY code LIMIT 1),
             $2, $2)
     RETURNING id`, [`WTY-${runTag}-${createdDeviceIds.length}`, userId])
  createdDeviceIds.push(rows[0].id)
  return rows[0].id
}

/** Days from today, as a 'YYYY-MM-DD' string computed by POSTGRES — same clock the service uses. */
async function dayOffset(days: number): Promise<string> {
  const { rows } = await db.query<{ d: string }>(
    `SELECT (current_date + ($1::int * INTERVAL '1 day'))::date::text AS d`, [days])
  return rows[0].d
}

async function makeWarranty(
  deviceId: string, startOffset: number, endOffset: number, terms?: string,
): Promise<{ warrantyId: string; version: number }> {
  const res = await createWarranty(fin(), {
    deviceId,
    startDate: await dayOffset(startOffset),
    endDate: await dayOffset(endOffset),
    terms,
  })
  createdWarrantyIds.push(res.warrantyId)
  const { rows } = await db.query<{ version: number }>(
    `SELECT version FROM warranty WHERE id = $1`, [res.warrantyId])
  return { warrantyId: res.warrantyId, version: rows[0].version }
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  userId = (await db.query(`SELECT id FROM app_user WHERE email='reetmitra8@gmail.com'`)).rows[0].id
})

afterAll(async () => {
  if (createdWarrantyIds.length) {
    await db.query(`DELETE FROM audit_log WHERE table_name='warranty' AND row_id = ANY($1)`,
      [createdWarrantyIds])
    await db.query(`DELETE FROM warranty WHERE id = ANY($1)`, [createdWarrantyIds])
  }
  if (createdDeviceIds.length) {
    // Renewals create rows this file never saw an id for; sweep by device.
    await db.query(`DELETE FROM warranty WHERE device_id = ANY($1)`, [createdDeviceIds])
    await db.query(`DELETE FROM audit_log WHERE table_name='device' AND row_id = ANY($1)`,
      [createdDeviceIds])
    await db.query(`DELETE FROM device WHERE id = ANY($1)`, [createdDeviceIds])
  }
  await db.end()
  await getPool().end()
})

describe('createWarranty', () => {
  it('refuses an actor without manage_finance (view_finance alone is not enough)', async () => {
    const d = await makeDevice()
    await expect(createWarranty(mgrView(), {
      deviceId: d, startDate: await dayOffset(0), endDate: await dayOffset(365),
    })).rejects.toThrow(PermissionError)
  })

  it('refuses an actor without Finance module access', async () => {
    const d = await makeDevice()
    await expect(createWarranty(noModuleAccess(), {
      deviceId: d, startDate: await dayOffset(0), endDate: await dayOffset(365),
    })).rejects.toThrow(PermissionError)
  })

  it('writes no row when authorization fails', async () => {
    const d = await makeDevice()
    await expect(createWarranty(mgrView(), {
      deviceId: d, startDate: await dayOffset(0), endDate: await dayOffset(365),
    })).rejects.toThrow(PermissionError)
    const { rows } = await db.query(`SELECT id FROM warranty WHERE device_id = $1`, [d])
    expect(rows).toHaveLength(0)
  })

  it('creates a warranty with created_by, version 1 and no status column to set', async () => {
    const d = await makeDevice()
    const { warrantyId } = await makeWarranty(d, -10, 700, 'Two years, parts and labour')
    const { rows } = await db.query<Record<string, unknown>>(
      `SELECT device_id, terms, created_by, version, deleted_at FROM warranty WHERE id = $1`,
      [warrantyId])
    expect(rows[0]).toMatchObject({
      device_id: d, terms: 'Two years, parts and labour', created_by: userId,
      version: 1, deleted_at: null,
    })
  })

  it('has no status column at all — the invariant this table exists to keep', async () => {
    // If this fails, someone added a stored status. Read the migration header.
    const { rows } = await db.query<{ column_name: string }>(
      `SELECT column_name FROM information_schema.columns
        WHERE table_name = 'warranty' AND column_name = 'status'`)
    expect(rows).toHaveLength(0)
  })

  it('refuses a second live warranty for the same device', async () => {
    const d = await makeDevice()
    await makeWarranty(d, 0, 365)
    await expect(createWarranty(fin(), {
      deviceId: d, startDate: await dayOffset(0), endDate: await dayOffset(365),
    })).rejects.toThrow(DuplicateWarrantyError)
  })

  it('refuses an unknown device', async () => {
    await expect(createWarranty(fin(), {
      deviceId: '00000000-0000-0000-0000-000000000000',
      startDate: await dayOffset(0), endDate: await dayOffset(365),
    })).rejects.toThrow(DeviceNotFoundError)
  })

  it('refuses an end date before the start date, in the domain and at the CHECK', async () => {
    const d = await makeDevice()
    await expect(createWarranty(fin(), {
      deviceId: d, startDate: await dayOffset(100), endDate: await dayOffset(10),
    })).rejects.toThrow(InvalidWarrantyPeriodError)

    // And the database refuses it independently, so a future code path that
    // skips the domain still cannot write an inverted period.
    await expect(db.query(
      `INSERT INTO warranty (device_id, start_date, end_date, created_by, updated_by)
       VALUES ($1, current_date + 100, current_date + 10, $2, $2)`, [d, userId]))
      .rejects.toThrow(/warranty_period_ordered/)
  })

  it('accepts a single-day warranty (start = end)', async () => {
    const d = await makeDevice()
    const today = await dayOffset(0)
    const res = await createWarranty(fin(), { deviceId: d, startDate: today, endDate: today })
    createdWarrantyIds.push(res.warrantyId)
    expect((await getDeviceWarranty(fin(), d))?.status).toBe('expiring_soon')
  })

  it('writes an audit_log row attributed to the actor', async () => {
    const d = await makeDevice()
    const { warrantyId } = await makeWarranty(d, 0, 365)
    const { rows } = await db.query<{ action: string; actor_id: string }>(
      `SELECT action, actor_id FROM audit_log
        WHERE table_name='warranty' AND row_id=$1 ORDER BY occurred_at`, [warrantyId])
    expect(rows[0]).toMatchObject({ action: 'insert', actor_id: userId })
  })
})

describe('getDeviceWarranty', () => {
  it('returns null for a device with no warranty — never an inferred 2-year window', async () => {
    // The legacy DLMS derived ship_date + 2 years for every device. That must not
    // come back: absent cover reads as absent.
    const d = await makeDevice()
    expect(await getDeviceWarranty(fin(), d)).toBeNull()
  })

  it('returns null for a malformed id rather than throwing', async () => {
    expect(await getDeviceWarranty(fin(), 'not-a-uuid')).toBeNull()
  })

  it('is readable by a Viewer with Finance module access (view_records, not view_finance)', async () => {
    const d = await makeDevice()
    await makeWarranty(d, -10, 400)
    const w = await getDeviceWarranty(viewer(), d)
    expect(w?.status).toBe('active')
  })

  it('refuses an actor without Finance module access', async () => {
    const d = await makeDevice()
    await expect(getDeviceWarranty(noModuleAccess(), d)).rejects.toThrow(PermissionError)
  })

  it('returns dates as YYYY-MM-DD strings, not Date objects', async () => {
    // A Date here is the local-midnight bug waiting to happen (logistics 6b36485).
    const d = await makeDevice()
    await makeWarranty(d, -10, 400)
    const w = await getDeviceWarranty(fin(), d)
    expect(typeof w!.startDate).toBe('string')
    expect(w!.startDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(w!.endDate).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('derives active / expiring_soon / expired from the dates', async () => {
    const far = await makeDevice(); await makeWarranty(far, -10, 400)
    const soon = await makeDevice(); await makeWarranty(soon, -10, 20)
    const gone = await makeDevice(); await makeWarranty(gone, -400, -1)

    expect((await getDeviceWarranty(fin(), far))!.status).toBe('active')
    expect((await getDeviceWarranty(fin(), soon))!.status).toBe('expiring_soon')
    expect((await getDeviceWarranty(fin(), gone))!.status).toBe('expired')
  })

  it('reports a future-dated warranty as active but NOT in force', async () => {
    const d = await makeDevice()
    await makeWarranty(d, 30, 800)
    const w = await getDeviceWarranty(fin(), d)
    expect(w).toMatchObject({ status: 'active', inForce: false })
  })

  it('counts the last day of cover as still covered', async () => {
    const d = await makeDevice()
    await makeWarranty(d, -100, 0)
    const w = await getDeviceWarranty(fin(), d)
    expect(w).toMatchObject({ status: 'expiring_soon', daysRemaining: 0, inForce: true })
  })
})

describe('updateWarranty', () => {
  it('corrects dates and terms under optimistic concurrency', async () => {
    const d = await makeDevice()
    const { warrantyId, version } = await makeWarranty(d, 0, 365, 'old')
    const res = await updateWarranty(fin(), {
      warrantyId, version, terms: 'new', endDate: await dayOffset(400),
    })
    expect(res.version).toBe(version + 1)
    const w = await getDeviceWarranty(fin(), d)
    expect(w!.terms).toBe('new')
  })

  it('rejects a stale version', async () => {
    const d = await makeDevice()
    const { warrantyId, version } = await makeWarranty(d, 0, 365)
    await updateWarranty(fin(), { warrantyId, version, terms: 'x' })
    await expect(updateWarranty(fin(), { warrantyId, version, terms: 'y' }))
      .rejects.toThrow(OptimisticLockError)
  })

  it('validates the RESULTING period, not just the supplied field', async () => {
    // Moving only end_date can still invert the range against the stored start.
    const d = await makeDevice()
    const { warrantyId, version } = await makeWarranty(d, 100, 200)
    await expect(updateWarranty(fin(), { warrantyId, version, endDate: await dayOffset(50) }))
      .rejects.toThrow(InvalidWarrantyPeriodError)
  })

  it('refuses an actor without manage_finance', async () => {
    const d = await makeDevice()
    const { warrantyId, version } = await makeWarranty(d, 0, 365)
    await expect(updateWarranty(mgrView(), { warrantyId, version, terms: 'x' }))
      .rejects.toThrow(PermissionError)
  })

  it('refuses an unknown warranty', async () => {
    await expect(updateWarranty(fin(), {
      warrantyId: '00000000-0000-0000-0000-000000000000', version: 1, terms: 'x',
    })).rejects.toThrow(WarrantyNotFoundError)
  })
})

describe('renewWarranty', () => {
  it('supersedes the old row and creates its successor in one transaction', async () => {
    const d = await makeDevice()
    const first = await makeWarranty(d, -400, -1, 'original terms')
    const res = await renewWarranty(fin(), {
      warrantyId: first.warrantyId, version: first.version,
      startDate: await dayOffset(0), endDate: await dayOffset(730), terms: 'renewed terms',
    })
    createdWarrantyIds.push(res.warrantyId)

    // Exactly one LIVE row, and it is the new one.
    const live = await getDeviceWarranty(fin(), d)
    expect(live!.id).toBe(res.warrantyId)
    expect(live!.terms).toBe('renewed terms')
    expect(live!.status).toBe('active')

    // The old row survives, soft-deleted — the whole reason renewal is not an edit.
    const { rows } = await db.query<{ deleted_at: Date | null; terms: string }>(
      `SELECT deleted_at, terms FROM warranty WHERE id = $1`, [first.warrantyId])
    expect(rows[0].deleted_at).not.toBeNull()
    expect(rows[0].terms).toBe('original terms')
  })

  it('keeps the partial unique index satisfiable across repeated renewals', async () => {
    // A plain UNIQUE(device_id) would make the SECOND renewal impossible. This is
    // the test that would catch someone "simplifying" the index.
    const d = await makeDevice()
    let cur = await makeWarranty(d, -800, -400)
    for (let i = 0; i < 3; i++) {
      const next = await renewWarranty(fin(), {
        warrantyId: cur.warrantyId, version: cur.version,
        startDate: await dayOffset(-300 + i), endDate: await dayOffset(400 + i),
      })
      createdWarrantyIds.push(next.warrantyId)
      const { rows } = await db.query<{ version: number }>(
        `SELECT version FROM warranty WHERE id = $1`, [next.warrantyId])
      cur = { warrantyId: next.warrantyId, version: rows[0].version }
    }
    const { rows: liveRows } = await db.query(
      `SELECT id FROM warranty WHERE device_id = $1 AND deleted_at IS NULL`, [d])
    expect(liveRows).toHaveLength(1)
    const { rows: allRows } = await db.query(
      `SELECT id FROM warranty WHERE device_id = $1`, [d])
    expect(allRows).toHaveLength(4)
  })

  it('rejects a stale version and leaves the original live', async () => {
    const d = await makeDevice()
    const first = await makeWarranty(d, 0, 365)
    await expect(renewWarranty(fin(), {
      warrantyId: first.warrantyId, version: first.version + 5,
      startDate: await dayOffset(0), endDate: await dayOffset(730),
    })).rejects.toThrow(OptimisticLockError)

    const live = await getDeviceWarranty(fin(), d)
    expect(live!.id).toBe(first.warrantyId)
  })

  it('rolls back the supersede when the successor is invalid', async () => {
    // The two statements are one transaction: a failure must not leave the device
    // with zero warranties.
    const d = await makeDevice()
    const first = await makeWarranty(d, 0, 365)
    await expect(renewWarranty(fin(), {
      warrantyId: first.warrantyId, version: first.version,
      startDate: await dayOffset(700), endDate: await dayOffset(10),
    })).rejects.toThrow(InvalidWarrantyPeriodError)

    const live = await getDeviceWarranty(fin(), d)
    expect(live!.id).toBe(first.warrantyId)
  })

  it('refuses an actor without manage_finance', async () => {
    const d = await makeDevice()
    const first = await makeWarranty(d, 0, 365)
    await expect(renewWarranty(mgrView(), {
      warrantyId: first.warrantyId, version: first.version,
      startDate: await dayOffset(0), endDate: await dayOffset(730),
    })).rejects.toThrow(PermissionError)
  })

  it('refuses to renew cover on a soft-deleted device, and supersedes nothing', async () => {
    // createWarranty has always enforced this; renew did not, so the door
    // createWarranty closed stood open through Renew — fresh commercial cover on
    // a retired device.
    const d = await makeDevice()
    const first = await makeWarranty(d, -400, -1)
    await db.query(`UPDATE device SET deleted_at = now() WHERE id = $1`, [d])

    await expect(renewWarranty(fin(), {
      warrantyId: first.warrantyId, version: first.version,
      startDate: await dayOffset(0), endDate: await dayOffset(730),
    })).rejects.toThrow(DeviceNotFoundError)

    // The whole thing is one transaction: the original must still be live.
    const { rows } = await db.query<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM warranty WHERE id = $1`, [first.warrantyId])
    expect(rows[0].deleted_at).toBeNull()
  })
})

describe('listDeviceWarrantyHistory', () => {
  it('returns the live row plus every superseded predecessor, newest first', async () => {
    const d = await makeDevice()
    const first = await makeWarranty(d, -800, -400, 'gen 1')
    const second = await renewWarranty(fin(), {
      warrantyId: first.warrantyId, version: first.version,
      startDate: await dayOffset(-399), endDate: await dayOffset(365), terms: 'gen 2',
    })
    createdWarrantyIds.push(second.warrantyId)

    const history = await listDeviceWarrantyHistory(fin(), d)
    expect(history).toHaveLength(2)
    expect(history[0].id).toBe(second.warrantyId)
    expect(history[0].supersededAt).toBeNull()
    expect(history[1].id).toBe(first.warrantyId)
    expect(history[1].supersededAt).not.toBeNull()
  })

  it('returns an empty array for a device with no warranty', async () => {
    expect(await listDeviceWarrantyHistory(fin(), await makeDevice())).toEqual([])
  })
})

describe('removeWarranty', () => {
  it('soft-deletes, leaving the device with no cover at all', async () => {
    const d = await makeDevice()
    const { warrantyId, version } = await makeWarranty(d, 0, 365)
    await removeWarranty(fin(), { warrantyId, version })

    expect(await getDeviceWarranty(fin(), d)).toBeNull()
    const { rows } = await db.query<{ deleted_at: Date | null }>(
      `SELECT deleted_at FROM warranty WHERE id = $1`, [warrantyId])
    expect(rows[0].deleted_at).not.toBeNull()
  })

  it('frees the device to take a new warranty (the partial index lets it)', async () => {
    const d = await makeDevice()
    const { warrantyId, version } = await makeWarranty(d, 0, 365)
    await removeWarranty(fin(), { warrantyId, version })
    const again = await makeWarranty(d, 0, 730)
    expect((await getDeviceWarranty(fin(), d))!.id).toBe(again.warrantyId)
  })

  it('refuses an actor without manage_finance', async () => {
    const d = await makeDevice()
    const { warrantyId, version } = await makeWarranty(d, 0, 365)
    await expect(removeWarranty(mgrView(), { warrantyId, version }))
      .rejects.toThrow(PermissionError)
  })

  it('rejects a stale version', async () => {
    const d = await makeDevice()
    const { warrantyId, version } = await makeWarranty(d, 0, 365)
    await expect(removeWarranty(fin(), { warrantyId, version: version + 3 }))
      .rejects.toThrow(OptimisticLockError)
  })
})

describe('getExpiringWarranties', () => {
  it('refuses an actor without Finance module access', async () => {
    await expect(getExpiringWarranties(noModuleAccess())).rejects.toThrow(PermissionError)
  })

  it('finds a warranty inside the window and not one outside it', async () => {
    const inside = await makeDevice(); await makeWarranty(inside, -10, 20)
    const outside = await makeDevice(); await makeWarranty(outside, -10, 200)

    const ids = (await getExpiringWarranties(fin(), { withinDays: 30, limit: 200 }))
      .map((w) => w.deviceId)
    expect(ids).toContain(inside)
    expect(ids).not.toContain(outside)
  })

  it('excludes warranties that already expired — this list is a call to action', async () => {
    const gone = await makeDevice(); await makeWarranty(gone, -400, -1)
    const ids = (await getExpiringWarranties(fin(), { withinDays: 90, limit: 200 }))
      .map((w) => w.deviceId)
    expect(ids).not.toContain(gone)
  })

  it('includes a warranty expiring TODAY', async () => {
    const today = await makeDevice(); await makeWarranty(today, -100, 0)
    const hit = (await getExpiringWarranties(fin(), { withinDays: 30, limit: 200 }))
      .find((w) => w.deviceId === today)
    expect(hit?.daysRemaining).toBe(0)
  })

  it('is ordered soonest-first among the rows this test created', async () => {
    const later = await makeDevice(); await makeWarranty(later, -10, 25)
    const sooner = await makeDevice(); await makeWarranty(sooner, -10, 5)
    const mine = (await getExpiringWarranties(fin(), { withinDays: 30, limit: 200 }))
      .filter((w) => w.deviceId === later || w.deviceId === sooner)
      .map((w) => w.deviceId)
    expect(mine).toEqual([sooner, later])
  })

  it('widening the window is monotonic — 90d contains everything 30d does', async () => {
    const a = await makeDevice(); await makeWarranty(a, -10, 15)
    const b = await makeDevice(); await makeWarranty(b, -10, 75)
    const in30 = (await getExpiringWarranties(fin(), { withinDays: 30, limit: 200 })).map((w) => w.deviceId)
    const in90 = (await getExpiringWarranties(fin(), { withinDays: 90, limit: 200 })).map((w) => w.deviceId)
    expect(in30).toContain(a)
    expect(in30).not.toContain(b)
    expect(in90).toEqual(expect.arrayContaining([a, b]))
  })

  it('excludes a superseded warranty even when its dates fall in the window', async () => {
    const d = await makeDevice()
    const first = await makeWarranty(d, -10, 15)
    const second = await renewWarranty(fin(), {
      warrantyId: first.warrantyId, version: first.version,
      startDate: await dayOffset(16), endDate: await dayOffset(800),
    })
    createdWarrantyIds.push(second.warrantyId)

    const ids = (await getExpiringWarranties(fin(), { withinDays: 30, limit: 200 }))
      .map((w) => w.warrantyId)
    expect(ids).not.toContain(first.warrantyId)
  })

  it('defaults to the same window the expiring_soon badge uses', async () => {
    // The default and EXPIRING_SOON_DAYS used to disagree (30 vs 60), so a
    // warranty 45 days out was badged "Expiring soon" and yet missing from the
    // default list. Anchored to one constant now.
    const d = await makeDevice(); await makeWarranty(d, -10, 45)
    const ids = (await getExpiringWarranties(fin(), { limit: 200 })).map((w) => w.deviceId)
    expect(ids).toContain(d)
    expect((await getDeviceWarranty(fin(), d))!.status).toBe('expiring_soon')
  })

  it('excludes a warranty whose device was soft-deleted', async () => {
    // Nothing clears a warranty when its device is retired, and the radar links
    // straight to the device page — which 404s for a soft-deleted device.
    const d = await makeDevice(); await makeWarranty(d, -10, 10)
    expect((await getExpiringWarranties(fin(), { withinDays: 30, limit: 200 }))
      .map((w) => w.deviceId)).toContain(d)

    await db.query(`UPDATE device SET deleted_at = now() WHERE id = $1`, [d])
    expect((await getExpiringWarranties(fin(), { withinDays: 30, limit: 200 }))
      .map((w) => w.deviceId)).not.toContain(d)
  })

  it('carries no buyer identity — a scope decision, not a permission check', async () => {
    const d = await makeDevice(); await makeWarranty(d, -10, 10)
    const hit = (await getExpiringWarranties(fin(), { withinDays: 30, limit: 200 }))
      .find((w) => w.deviceId === d)!
    expect(Object.keys(hit).sort()).toEqual([
      'daysRemaining', 'deviceId', 'deviceSn', 'endDate', 'startDate', 'status', 'warrantyId',
    ])
  })
})

describe('getWarrantyExpiryCounts', () => {
  it('refuses an actor without Finance module access', async () => {
    await expect(getWarrantyExpiryCounts(noModuleAccess())).rejects.toThrow(PermissionError)
  })

  it('reports cumulative windows: adding a 45-day row moves 60 and 90 but not 30', async () => {
    // Scoped by DELTA, not by absolute count — the database is shared and other
    // files' rows are in it.
    const before = await getWarrantyExpiryCounts(fin())
    const d = await makeDevice(); await makeWarranty(d, -10, 45)
    const after = await getWarrantyExpiryCounts(fin())

    expect(after.within30 - before.within30).toBe(0)
    expect(after.within60 - before.within60).toBe(1)
    expect(after.within90 - before.within90).toBe(1)
    expect(after.notExpired - before.notExpired).toBe(1)
    expect(after.expired - before.expired).toBe(0)
  })

  it('counts an expired warranty as expired and not as active', async () => {
    const before = await getWarrantyExpiryCounts(fin())
    const d = await makeDevice(); await makeWarranty(d, -400, -1)
    const after = await getWarrantyExpiryCounts(fin())

    expect(after.expired - before.expired).toBe(1)
    expect(after.notExpired - before.notExpired).toBe(0)
    expect(after.within90 - before.within90).toBe(0)
  })

  it('stops counting a warranty whose device was soft-deleted', async () => {
    const d = await makeDevice(); await makeWarranty(d, -10, 20)
    const withDevice = await getWarrantyExpiryCounts(fin())
    await db.query(`UPDATE device SET deleted_at = now() WHERE id = $1`, [d])
    const without = await getWarrantyExpiryCounts(fin())
    expect(withDevice.within30 - without.within30).toBe(1)
    expect(withDevice.notExpired - without.notExpired).toBe(1)
  })

  it('stops counting a warranty once it is removed', async () => {
    const d = await makeDevice()
    const { warrantyId, version } = await makeWarranty(d, -10, 20)
    const withRow = await getWarrantyExpiryCounts(fin())
    await removeWarranty(fin(), { warrantyId, version })
    const without = await getWarrantyExpiryCounts(fin())
    expect(withRow.within30 - without.within30).toBe(1)
  })
})

describe('warranty table hardening', () => {
  it('has RLS enabled and NOT forced, with no policies (deny-via-REST)', async () => {
    const { rows } = await db.query<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>(
      `SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'warranty'`)
    expect(rows[0]).toEqual({ relrowsecurity: true, relforcerowsecurity: false })

    const { rows: policies } = await db.query(
      `SELECT policyname FROM pg_policies WHERE tablename = 'warranty'`)
    expect(policies).toHaveLength(0)
  })

  it('has the audit trigger attached', async () => {
    const { rows } = await db.query(
      `SELECT tgname FROM pg_trigger WHERE tgrelid = 'warranty'::regclass AND tgname = 'trg_audit_warranty'`)
    expect(rows).toHaveLength(1)
  })

  it('enforces one LIVE warranty per device at the index, not just in the service', async () => {
    const d = await makeDevice()
    await makeWarranty(d, 0, 365)
    await expect(db.query(
      `INSERT INTO warranty (device_id, start_date, end_date, created_by, updated_by)
       VALUES ($1, current_date, current_date + 365, $2, $2)`, [d, userId]))
      .rejects.toThrow(/warranty_device_live_unique/)
  })
})
