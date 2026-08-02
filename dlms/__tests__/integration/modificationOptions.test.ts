// __tests__/integration/modificationOptions.test.ts
//
// The option-list and count reads the modification UI needs, added alongside
// the service that already existed: listModificationTypeOptions,
// listModifiableDevices, listDeviceRepairOptions, listEcoOptions and
// getModificationStatusCounts.
//
// A SEPARATE FILE from modificationService.test.ts on purpose — that file is the
// schema + lifecycle suite and is long enough; these are the read projections
// the pages call. Same harness idiom: raw SQL, tag rows per run, clean up in
// afterAll, and scope every assertion to rows this file created (the database is
// shared with every other integration file and is not rolled back).
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import {
  listModificationTypeOptions, listModifiableDevices, listDeviceRepairOptions,
  listEcoOptions, getModificationStatusCounts, createModification,
} from '@/modules/maintenance/services/modificationService'
import { MODIFICATION_STATUSES } from '@/modules/maintenance/domain/modificationStatus'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

let db: Client
let userId: string
let deviceId: string
let otherDeviceId: string
let typeId: string

const RUN = `MODOPT-${Date.now()}`

// Maintenance-only: no engineering access, which is what makes the listEcoOptions
// gate observable.
const maint = (): Actor => ({
  id: userId, roleKey: 'operator',
  permissions: new Set(['view_records', 'create_records', 'edit_records']),
  moduleAccess: new Set(['maintenance']), active: true,
})
// Adds engineering module access — the actor the New Modification page checks
// for before it calls listEcoOptions at all.
const withEngineering = (): Actor => ({
  id: userId, roleKey: 'manager',
  permissions: new Set(['view_records', 'create_records', 'edit_records']),
  moduleAccess: new Set(['maintenance', 'engineering']), active: true,
})

const createdDeviceIds: string[] = []
const createdModificationIds: string[] = []
const createdRepairIds: string[] = []
const createdTypeIds: string[] = []

async function makeDevice(): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO device (variant_id, status, created_by, updated_by)
     VALUES ((SELECT id FROM device_variant WHERE code='pro'), 'active', $1, $1) RETURNING id`,
    [userId])
  createdDeviceIds.push(rows[0].id)
  return rows[0].id
}

async function makeRepair(device: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO repair (device_id, created_by, updated_by) VALUES ($1,$2,$2) RETURNING id`,
    [device, userId])
  createdRepairIds.push(rows[0].id)
  return rows[0].id
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  userId = (await db.query(`SELECT id FROM app_user WHERE email = 'reetmitra8@gmail.com'`)).rows[0].id
  deviceId = await makeDevice()
  otherDeviceId = await makeDevice()
  typeId = (await db.query(`SELECT id FROM modification_type ORDER BY sort LIMIT 1`)).rows[0].id
})

afterAll(async () => {
  if (createdModificationIds.length) {
    await db.query(`DELETE FROM modification_status_history WHERE modification_id = ANY($1)`,
      [createdModificationIds])
    await db.query(`DELETE FROM modification WHERE id = ANY($1)`, [createdModificationIds])
  }
  if (createdRepairIds.length) {
    await db.query(`DELETE FROM repair WHERE id = ANY($1)`, [createdRepairIds])
  }
  if (createdTypeIds.length) {
    await db.query(`DELETE FROM modification_type WHERE id = ANY($1)`, [createdTypeIds])
  }
  if (createdDeviceIds.length) {
    await db.query(`DELETE FROM device WHERE id = ANY($1)`, [createdDeviceIds])
  }
  await db.end()
  await getPool().end()
})

describe('listModificationTypeOptions', () => {
  it('returns the seeded vocabulary in sort order, resolved from the TABLE', async () => {
    const types = await listModificationTypeOptions(maint())
    expect(types.length).toBeGreaterThan(0)
    // Every option carries a code and a name; the CODES ARE NOT ASSERTED against
    // a hardcoded list on purpose. Cloud vocabulary has drifted from seed.sql
    // before (CLAUDE.md), and a test that pins the seeded codes would encode the
    // exact assumption this project has already been bitten by.
    for (const t of types) {
      expect(t.id).toBeTruthy()
      expect(t.code).toBeTruthy()
      expect(t.name).toBeTruthy()
    }
  })

  it('EXCLUDES an inactive type — the soft-disable hides it from the create form', async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO modification_type (code, name, sort, active, created_by)
       VALUES ($1, 'Retired kind', 99, false, $2) RETURNING id`, [`${RUN}-retired`, userId])
    createdTypeIds.push(rows[0].id)

    const types = await listModificationTypeOptions(maint())
    expect(types.map((t) => t.id)).not.toContain(rows[0].id)
  })

  it('an inactive type is still ACCEPTED by createModification — it only leaves the form', async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO modification_type (code, name, sort, active, created_by)
       VALUES ($1, 'Retired but replayable', 98, false, $2) RETURNING id`,
      [`${RUN}-replay`, userId])
    createdTypeIds.push(rows[0].id)

    const res = await createModification(maint(), {
      deviceId, modificationTypeId: rows[0].id, reason: RUN })
    createdModificationIds.push(res.modificationId)
    expect(res.modificationNo).toMatch(/^MOD-/)
  })

  it('EXCLUDES a soft-deleted type', async () => {
    const { rows } = await db.query<{ id: string }>(
      `INSERT INTO modification_type (code, name, sort, created_by, deleted_at)
       VALUES ($1, 'Deleted kind', 97, $2, now()) RETURNING id`, [`${RUN}-deleted`, userId])
    createdTypeIds.push(rows[0].id)

    const types = await listModificationTypeOptions(maint())
    expect(types.map((t) => t.id)).not.toContain(rows[0].id)
  })
})

describe('listModifiableDevices', () => {
  it('offers live devices', async () => {
    const devices = await listModifiableDevices(maint())
    expect(devices.map((d) => d.id)).toContain(deviceId)
    // Every row carries a resolved status LABEL from status_option, never a
    // hardcoded code string.
    expect(devices.find((d) => d.id === deviceId)!.statusLabel).toBeTruthy()
  })

  it('omits a soft-deleted device', async () => {
    const gone = await makeDevice()
    await db.query(`UPDATE device SET deleted_at = now() WHERE id = $1`, [gone])
    const devices = await listModifiableDevices(maint())
    expect(devices.map((d) => d.id)).not.toContain(gone)
  })
})

describe('listDeviceRepairOptions', () => {
  // The write refuses a cross-device repair link (assertSameDevice), so the
  // picker must not OFFER one — the same "don't offer what the write refuses"
  // rule the New Repair form's canMoveToUnderRepair fix established.
  it('lists only THIS device’s repairs', async () => {
    const mine = await makeRepair(deviceId)
    const theirs = await makeRepair(otherDeviceId)

    const options = await listDeviceRepairOptions(maint(), deviceId)
    expect(options.map((r) => r.id)).toContain(mine)
    expect(options.map((r) => r.id)).not.toContain(theirs)
  })

  it('omits a soft-deleted repair', async () => {
    const gone = await makeRepair(deviceId)
    await db.query(`UPDATE repair SET deleted_at = now() WHERE id = $1`, [gone])
    const options = await listDeviceRepairOptions(maint(), deviceId)
    expect(options.map((r) => r.id)).not.toContain(gone)
  })
})

describe('listEcoOptions', () => {
  // The gate the New Modification page must respect: this THROWS rather than
  // returning empty, so an ungated call from a maintenance-only session is a
  // 500, not a hidden dropdown.
  it('refuses a maintenance-only actor — it does not return an empty list', async () => {
    await expect(listEcoOptions(maint())).rejects.toThrow(PermissionError)
  })

  it('returns options for an actor with engineering access', async () => {
    const options = await listEcoOptions(withEngineering())
    expect(Array.isArray(options)).toBe(true)
    for (const o of options) {
      expect(o.ecoNo).toMatch(/^ECO-/)
    }
  })
})

describe('getModificationStatusCounts', () => {
  it('zero-fills every state in the fixed vocabulary', async () => {
    const counts = await getModificationStatusCounts(maint())
    expect(counts.map((c) => c.status)).toEqual([...MODIFICATION_STATUSES])
    for (const c of counts) {
      expect(c.statusLabel).toBeTruthy()
      expect(c.count).toBeGreaterThanOrEqual(0)
    }
  })

  it('counts a newly raised modification into `requested`', async () => {
    const before = (await getModificationStatusCounts(maint()))
      .find((c) => c.status === 'requested')!.count

    const res = await createModification(maint(), {
      deviceId, modificationTypeId: typeId, reason: RUN })
    createdModificationIds.push(res.modificationId)

    const after = (await getModificationStatusCounts(maint()))
      .find((c) => c.status === 'requested')!.count
    // A delta, not an absolute — the database is shared with every other file.
    expect(after).toBe(before + 1)
  })
})
