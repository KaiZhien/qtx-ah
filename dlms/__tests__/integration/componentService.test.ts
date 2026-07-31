import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import {
  getDeviceComponents, installComponent, replaceComponentInstallation,
} from '@/modules/manufacturing/services/componentService'
import { InvalidReplacementError } from '@/modules/manufacturing/domain/componentInstallation'
import { InvalidAttributionError } from '@/modules/maintenance/services/attributionService'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client
let userId: string, deviceId: string, pcbaTypeId: string, unitA: string, unitB: string
// A SECOND device with its own repair + modification, so "same device" can be
// told apart from "any live record" — the whole point of the attribution rule.
let otherDeviceId: string, unitC: string, unitD: string
let repairHere: string, repairElsewhere: string
let modHere: string, modElsewhere: string

const op = (): Actor => ({
  id: userId, roleKey: 'operator',
  permissions: new Set(['view_records', 'edit_records']),
  moduleAccess: new Set(['manufacturing']), active: true,
})
const viewer = (): Actor => ({
  id: userId, roleKey: 'viewer',
  permissions: new Set(['view_records']), moduleAccess: new Set(['manufacturing']), active: true,
})

// Unique per test run so this file is safely re-runnable against a database that
// retains rows from a prior run (component_installation is append-only and
// component_unit_sn is unique on (component_type_id, serial_no) — a fixed serial
// would collide on a second run against a persisted container).
const runTag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  userId = (await db.query(`SELECT id FROM app_user WHERE email='reetmitra8@gmail.com'`)).rows[0].id
  deviceId = (await db.query(`
    INSERT INTO device (variant_id, status, created_by, updated_by)
    VALUES ((SELECT id FROM device_variant WHERE code='pro'),'in_stock',$1,$1) RETURNING id`,
    [userId])).rows[0].id
  pcbaTypeId = (await db.query(`SELECT id FROM component_type WHERE code='pcba_a'`)).rows[0].id
  unitA = (await db.query(`INSERT INTO component_unit (component_type_id, serial_no, created_by, updated_by)
    VALUES ($1,$2,$3,$3) RETURNING id`, [pcbaTypeId, `PCBA-A-001-${runTag}`, userId])).rows[0].id
  unitB = (await db.query(`INSERT INTO component_unit (component_type_id, serial_no, created_by, updated_by)
    VALUES ($1,$2,$3,$3) RETURNING id`, [pcbaTypeId, `PCBA-A-002-${runTag}`, userId])).rows[0].id
  unitC = (await db.query(`INSERT INTO component_unit (component_type_id, serial_no, created_by, updated_by)
    VALUES ($1,$2,$3,$3) RETURNING id`, [pcbaTypeId, `PCBA-A-003-${runTag}`, userId])).rows[0].id
  unitD = (await db.query(`INSERT INTO component_unit (component_type_id, serial_no, created_by, updated_by)
    VALUES ($1,$2,$3,$3) RETURNING id`, [pcbaTypeId, `PCBA-A-004-${runTag}`, userId])).rows[0].id

  otherDeviceId = (await db.query(`
    INSERT INTO device (variant_id, status, created_by, updated_by)
    VALUES ((SELECT id FROM device_variant WHERE code='pro'),'in_stock',$1,$1) RETURNING id`,
    [userId])).rows[0].id
  const modTypeId = (await db.query(
    `SELECT id FROM modification_type ORDER BY sort LIMIT 1`)).rows[0].id
  const mkRepair = async (dev: string) => (await db.query(
    `INSERT INTO repair (device_id, created_by) VALUES ($1,$2) RETURNING id`, [dev, userId])).rows[0].id
  const mkMod = async (dev: string) => (await db.query(
    `INSERT INTO modification (device_id, modification_type_id, created_by)
     VALUES ($1,$2,$3) RETURNING id`, [dev, modTypeId, userId])).rows[0].id
  repairHere = await mkRepair(deviceId)
  repairElsewhere = await mkRepair(otherDeviceId)
  modHere = await mkMod(deviceId)
  modElsewhere = await mkMod(otherDeviceId)
})
afterAll(async () => { await db.end(); await getPool().end() })

describe('installComponent + getDeviceComponents', () => {
  it('refuses a viewer', async () => {
    await expect(installComponent(viewer(), { deviceId, componentTypeId: pcbaTypeId, unitId: unitA }))
      .rejects.toThrow(PermissionError)
  })
  it('installs a serialized unit and shows it as current', async () => {
    await installComponent(op(), { deviceId, componentTypeId: pcbaTypeId, unitId: unitA })
    const { current } = await getDeviceComponents(op(), deviceId)
    const pcba = current.find((c) => c.componentTypeCode === 'pcba_a')
    expect(pcba?.unit?.serialNo).toBe(`PCBA-A-001-${runTag}`)
    // installing sets the unit disposition to 'installed'
    const { rows } = await db.query(`SELECT disposition FROM component_unit WHERE id=$1`, [unitA])
    expect(rows[0].disposition).toBe('installed')
  })
})

describe('replaceComponentInstallation (the §14 primitive)', () => {
  it('closes the old install, opens the new, flips both units, bumps device.version — atomically', async () => {
    const before = (await db.query(`SELECT version FROM device WHERE id=$1`, [deviceId])).rows[0].version
    const open = (await db.query(
      `SELECT id FROM component_installation WHERE device_id=$1 AND component_type_id=$2
        AND removed_at IS NULL`, [deviceId, pcbaTypeId])).rows[0].id

    const res = await replaceComponentInstallation(op(), {
      removedInstallationId: open, reason: 'PCBA-A no power output', replacementUnitId: unitB,
    })

    // old closed, new open
    const closed = await db.query(`SELECT removed_at, removed_by, removal_reason
      FROM component_installation WHERE id=$1`, [res.closedId])
    expect(closed.rows[0].removed_at).not.toBeNull()
    expect(closed.rows[0].removal_reason).toBe('PCBA-A no power output')
    const now = await db.query(`SELECT component_unit_id, removed_at
      FROM component_installation WHERE id=$1`, [res.newId])
    expect(now.rows[0].component_unit_id).toBe(unitB)
    expect(now.rows[0].removed_at).toBeNull()

    // unit dispositions flipped: old removed, new installed
    const uA = await db.query(`SELECT disposition FROM component_unit WHERE id=$1`, [unitA])
    const uB = await db.query(`SELECT disposition FROM component_unit WHERE id=$1`, [unitB])
    expect(uA.rows[0].disposition).toBe('removed')
    expect(uB.rows[0].disposition).toBe('installed')

    // device.version bumped
    const after = (await db.query(`SELECT version FROM device WHERE id=$1`, [deviceId])).rows[0].version
    expect(after).toBe(before + 1)

    // exactly one open installation for this slot (scoped to this test's device+type)
    const openCount = await db.query(`SELECT count(*)::int n FROM component_installation
      WHERE device_id=$1 AND component_type_id=$2 AND removed_at IS NULL`, [deviceId, pcbaTypeId])
    expect(openCount.rows[0].n).toBe(1)
  })

  it('rolls back everything if the replacement unit does not exist', async () => {
    const open = (await db.query(
      `SELECT id FROM component_installation WHERE device_id=$1 AND component_type_id=$2
        AND removed_at IS NULL`, [deviceId, pcbaTypeId])).rows[0].id
    const beforeVer = (await db.query(`SELECT version FROM device WHERE id=$1`, [deviceId])).rows[0].version

    await expect(replaceComponentInstallation(op(), {
      removedInstallationId: open, reason: 'x', replacementUnitId: crypto.randomUUID(),
    })).rejects.toThrow()

    // the open installation is STILL open (nothing was closed), device.version unchanged
    const stillOpen = await db.query(`SELECT removed_at FROM component_installation WHERE id=$1`, [open])
    expect(stillOpen.rows[0].removed_at).toBeNull()
    const afterVer = (await db.query(`SELECT version FROM device WHERE id=$1`, [deviceId])).rows[0].version
    expect(afterVer).toBe(beforeVer)
  })

  it('rejects a serialized replacement reusing the removed unit', async () => {
    const open = (await db.query(
      `SELECT id, component_unit_id FROM component_installation WHERE device_id=$1
        AND component_type_id=$2 AND removed_at IS NULL`, [deviceId, pcbaTypeId])).rows[0]
    await expect(replaceComponentInstallation(op(), {
      removedInstallationId: open.id, reason: 'x', replacementUnitId: open.component_unit_id,
    })).rejects.toThrow(InvalidReplacementError)
  })

  it('the full history remains after a replacement (append-only)', async () => {
    const { history } = await getDeviceComponents(op(), deviceId)
    const pcbaHistory = history.filter((h) => h.componentTypeCode === 'pcba_a')
    expect(pcbaHistory.length).toBeGreaterThanOrEqual(2)   // original + replacement
    expect(pcbaHistory.some((h) => h.unit?.serialNo === `PCBA-A-001-${runTag}`)).toBe(true)
  })
})

// ── Attribution (spec §5.4) ────────────────────────────────────────────────
// A repairId/modificationId on a replacement is a traceability CLAIM: "this
// swap happened because of that record". A claim naming another device's
// repair is a lie, and the FK alone cannot catch it — both rows are perfectly
// real. Enforced inside the primitive's transaction, under the lock that
// already established which device the installation belongs to, so no caller
// can route around it.
describe('replacement attribution', () => {
  const openInstallation = async () => (await db.query<{ id: string }>(
    `SELECT id FROM component_installation
      WHERE device_id=$1 AND component_type_id=$2 AND removed_at IS NULL`,
    [deviceId, pcbaTypeId])).rows[0].id

  it('stamps the repair on BOTH the closed row and the row it opens', async () => {
    const open = await openInstallation()
    const res = await replaceComponentInstallation(op(), {
      removedInstallationId: open, reason: 'PCBA-A failed burn-in',
      replacementUnitId: unitC, repairId: repairHere,
    })
    const { rows } = await db.query<{ repair_id: string | null }>(
      `SELECT repair_id FROM component_installation WHERE id = ANY($1)`,
      [[res.closedId, res.newId]])
    expect(rows).toHaveLength(2)
    expect(rows.every((r) => r.repair_id === repairHere)).toBe(true)
  })

  it("refuses a repair belonging to ANOTHER device, and rolls the whole swap back", async () => {
    const open = await openInstallation()
    const beforeVer = (await db.query(`SELECT version FROM device WHERE id=$1`, [deviceId]))
      .rows[0].version

    await expect(replaceComponentInstallation(op(), {
      removedInstallationId: open, reason: 'x', replacementUnitId: unitD,
      repairId: repairElsewhere,
    })).rejects.toMatchObject({
      name: 'InvalidAttributionError', kind: 'repair', code: 'device_mismatch',
    })

    // nothing closed, nothing opened, no version bump
    const still = await db.query(`SELECT removed_at FROM component_installation WHERE id=$1`, [open])
    expect(still.rows[0].removed_at).toBeNull()
    const afterVer = (await db.query(`SELECT version FROM device WHERE id=$1`, [deviceId]))
      .rows[0].version
    expect(afterVer).toBe(beforeVer)
    const orphan = await db.query(
      `SELECT count(*)::int n FROM component_installation WHERE repair_id=$1`, [repairElsewhere])
    expect(orphan.rows[0].n).toBe(0)
  })

  it('refuses a repairId that does not exist at all', async () => {
    const open = await openInstallation()
    await expect(replaceComponentInstallation(op(), {
      removedInstallationId: open, reason: 'x', replacementUnitId: unitD,
      repairId: '00000000-0000-0000-0000-000000000000',
    })).rejects.toMatchObject({ name: 'InvalidAttributionError', code: 'not_found' })
  })

  it('refuses a soft-deleted repair (existence means LIVE, as everywhere else)', async () => {
    const dead = (await db.query(
      `INSERT INTO repair (device_id, created_by, deleted_at) VALUES ($1,$2,now()) RETURNING id`,
      [deviceId, userId])).rows[0].id
    const open = await openInstallation()
    await expect(replaceComponentInstallation(op(), {
      removedInstallationId: open, reason: 'x', replacementUnitId: unitD, repairId: dead,
    })).rejects.toThrow(InvalidAttributionError)
  })

  it('refuses a modification belonging to another device, and accepts one for this device', async () => {
    const open = await openInstallation()
    await expect(replaceComponentInstallation(op(), {
      removedInstallationId: open, reason: 'x', replacementUnitId: unitD,
      modificationId: modElsewhere,
    })).rejects.toMatchObject({
      name: 'InvalidAttributionError', kind: 'modification', code: 'device_mismatch',
    })

    const res = await replaceComponentInstallation(op(), {
      removedInstallationId: open, reason: 'ECO retrofit', replacementUnitId: unitD,
      modificationId: modHere,
    })
    const { rows } = await db.query<{ modification_id: string | null }>(
      `SELECT modification_id FROM component_installation WHERE id=$1`, [res.newId])
    expect(rows[0].modification_id).toBe(modHere)
  })

  it('leaves an unattributed replacement alone (both ids optional)', async () => {
    const open = await openInstallation()
    const res = await replaceComponentInstallation(op(), {
      removedInstallationId: open, reason: 'no linked record', replacementUnitId: unitC,
    })
    const { rows } = await db.query<{ repair_id: string | null; modification_id: string | null }>(
      `SELECT repair_id, modification_id FROM component_installation WHERE id=$1`, [res.newId])
    expect(rows[0]).toEqual({ repair_id: null, modification_id: null })
  })
})
