// __tests__/integration/bomEffectivityService.test.ts
//
// BOM effectivity against a real Postgres (TEST_DATABASE_URL).
//
// This suite creates its OWN device_variant and component_type rows, tagged per
// run, and never touches the seeded ones — variant_bom_line is shared state and
// a test that rewrote the seeded Pro BOM would corrupt every later run of this
// non-rollback database. Every assertion is scoped to rows this run created.
//
// NOT run in this worktree — the integration DB port is shared with the other
// agents working in parallel; the controller runs the suite serially at merge.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import {
  addAffectedItem, removeAffectedItem, applyEcoEffectivity,
  listAffectedItems, getVariantBom,
  BomApplyError, AffectedItemLockedError, DuplicateAffectedItemError,
} from '@/modules/engineering/services/bomEffectivityService'
import { createEco, changeEcoStatus } from '@/modules/engineering/services/engineeringWriteService'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client
let userId: string
let variantId: string
let typeA: string
let typeB: string
const runTag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const ecoIds: string[] = []

const op = (): Actor => ({
  id: userId, roleKey: 'operator',
  permissions: new Set(['view_records', 'create_records', 'edit_records']),
  moduleAccess: new Set(['engineering']), active: true,
})
// approve_requests is needed to move an ECO submitted -> approved.
const mgr = (): Actor => ({
  id: userId, roleKey: 'manager',
  permissions: new Set(['view_records', 'create_records', 'edit_records', 'approve_requests']),
  moduleAccess: new Set(['engineering']), active: true,
})
const viewer = (): Actor => ({
  id: userId, roleKey: 'viewer',
  permissions: new Set(['view_records']), moduleAccess: new Set(['engineering']), active: true,
})

/** Creates an ECO and walks it all the way to `implemented`. */
async function implementedEco(
  title: string, eff: { effectivityDate?: string; effectivitySerial?: string },
): Promise<string> {
  const eco = await createEco(op(), { title, ...eff })
  ecoIds.push(eco.id)
  let v = (await db.query(`SELECT version FROM eco WHERE id=$1`, [eco.id])).rows[0].version as number
  v = (await changeEcoStatus(op(), { id: eco.id, version: v, toStatus: 'submitted' })).version
  v = (await changeEcoStatus(mgr(), { id: eco.id, version: v, toStatus: 'approved' })).version
  await changeEcoStatus(op(), { id: eco.id, version: v, toStatus: 'implemented' })
  return eco.id
}

/** Every BOM line this run created, oldest window first. */
async function myLines() {
  const { rows } = await db.query(
    `SELECT component_type_id, quantity,
            effective_from_date::text  AS from_date, effective_to_date::text AS to_date,
            effective_from_serial      AS from_serial, effective_to_serial   AS to_serial,
            created_by_eco_id, superseded_by_eco_id
       FROM variant_bom_line WHERE variant_id = $1 AND deleted_at IS NULL
      ORDER BY created_at`, [variantId])
  return rows
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  userId = (await db.query(`SELECT id FROM app_user WHERE email='reetmitra8@gmail.com'`)).rows[0].id

  variantId = (await db.query<{ id: string }>(
    `INSERT INTO device_variant (code, name, active) VALUES ($1,$2,true) RETURNING id`,
    [`bomtest-${runTag}`, `BOM Test ${runTag}`])).rows[0].id
  typeA = (await db.query<{ id: string }>(
    `INSERT INTO component_type (code, name, tracking_mode, created_by)
     VALUES ($1,$2,'serialized',$3) RETURNING id`,
    [`bt-a-${runTag}`, `BOM Type A ${runTag}`, userId])).rows[0].id
  typeB = (await db.query<{ id: string }>(
    `INSERT INTO component_type (code, name, tracking_mode, created_by)
     VALUES ($1,$2,'serialized',$3) RETURNING id`,
    [`bt-b-${runTag}`, `BOM Type B ${runTag}`, userId])).rows[0].id

  // The starting BOM: one line for type A, unbounded on both axes (the state
  // every pre-effectivity line is in).
  await db.query(
    `INSERT INTO variant_bom_line (variant_id, component_type_id, quantity, created_by, updated_by)
     VALUES ($1,$2,1,$3,$3)`, [variantId, typeA, userId])
})

afterAll(async () => {
  await db.query(`DELETE FROM variant_bom_line WHERE variant_id = $1`, [variantId])
  if (ecoIds.length) {
    await db.query(`DELETE FROM ec_affected_item WHERE eco_id = ANY($1)`, [ecoIds])
    await db.query(`DELETE FROM eco WHERE id = ANY($1)`, [ecoIds])
  }
  await db.query(`DELETE FROM component_type WHERE id = ANY($1)`, [[typeA, typeB]])
  await db.query(`DELETE FROM device_variant WHERE id = $1`, [variantId])
  await db.end()
  await getPool().end()
})

describe('authorization', () => {
  it('refuses adding an affected item without edit_records', async () => {
    await expect(addAffectedItem(viewer(), {
      ecoId: '00000000-0000-0000-0000-000000000000', variantId,
      componentTypeId: typeA, disposition: 'remove',
    })).rejects.toThrow(PermissionError)
  })
  it('refuses applying without edit_records', async () => {
    await expect(applyEcoEffectivity(viewer(), {
      ecoId: '00000000-0000-0000-0000-000000000000',
    })).rejects.toThrow(PermissionError)
  })
})

describe('affected items', () => {
  it('rejects a second item for the same (eco, variant, component type)', async () => {
    const eco = await createEco(op(), { title: `Dupes ${runTag}` })
    ecoIds.push(eco.id)
    await addAffectedItem(op(), {
      ecoId: eco.id, variantId, componentTypeId: typeA, disposition: 'change', quantity: 2,
    })
    await expect(addAffectedItem(op(), {
      ecoId: eco.id, variantId, componentTypeId: typeA, disposition: 'remove',
    })).rejects.toThrow(DuplicateAffectedItemError)
  })

  it('soft-deletes an unapplied item and frees the key again', async () => {
    const eco = await createEco(op(), { title: `Removable ${runTag}` })
    ecoIds.push(eco.id)
    const added = await addAffectedItem(op(), {
      ecoId: eco.id, variantId, componentTypeId: typeB, disposition: 'add', quantity: 1,
    })
    const v = (await db.query(`SELECT version FROM ec_affected_item WHERE id=$1`, [added.id]))
      .rows[0].version as number
    await removeAffectedItem(op(), { id: added.id, version: v })
    expect(await listAffectedItems(op(), eco.id)).toHaveLength(0)
    // the partial unique index excludes soft-deleted rows, so this succeeds
    await addAffectedItem(op(), {
      ecoId: eco.id, variantId, componentTypeId: typeB, disposition: 'add', quantity: 3,
    })
  })
})

describe('the apply step refuses before it half-applies', () => {
  it('refuses an ECO that is not implemented', async () => {
    const eco = await createEco(op(), { title: `Draft ${runTag}`, effectivityDate: '2026-06-01' })
    ecoIds.push(eco.id)
    await addAffectedItem(op(), {
      ecoId: eco.id, variantId, componentTypeId: typeA, disposition: 'change', quantity: 9,
    })
    await expect(applyEcoEffectivity(op(), { ecoId: eco.id })).rejects.toThrow(BomApplyError)
    // the BOM is untouched
    const lines = await myLines()
    expect(lines.every((l) => l.quantity !== 9)).toBe(true)
  })

  it('refuses an implemented ECO with NO effectivity point at all', async () => {
    const ecoId = await implementedEco(`No-point ${runTag}`, {})
    await addAffectedItem(op(), {
      ecoId, variantId, componentTypeId: typeA, disposition: 'change', quantity: 8,
    })
    await expect(applyEcoEffectivity(op(), { ecoId })).rejects.toThrow(BomApplyError)
  })

  it('refuses `add` for a type already on the BOM, leaving nothing written', async () => {
    const ecoId = await implementedEco(`Bad-add ${runTag}`, { effectivityDate: '2026-06-01' })
    await addAffectedItem(op(), {
      ecoId, variantId, componentTypeId: typeA, disposition: 'add', quantity: 5,
    })
    await expect(applyEcoEffectivity(op(), { ecoId })).rejects.toThrow(BomApplyError)
    const items = await listAffectedItems(op(), ecoId)
    expect(items.every((i) => i.appliedAt === null)).toBe(true)
  })

  it('refuses `remove` for a type that is not on the BOM', async () => {
    const ecoId = await implementedEco(`Bad-remove ${runTag}`, { effectivityDate: '2026-06-01' })
    await addAffectedItem(op(), {
      ecoId, variantId, componentTypeId: typeB, disposition: 'remove',
    })
    await expect(applyEcoEffectivity(op(), { ecoId })).rejects.toThrow(BomApplyError)
  })
})

describe('applying by DATE effectivity', () => {
  let ecoId: string

  it('closes the outgoing line and opens the incoming one at the same date', async () => {
    ecoId = await implementedEco(`Date-change ${runTag}`, { effectivityDate: '2026-06-01' })
    await addAffectedItem(op(), {
      ecoId, variantId, componentTypeId: typeA, disposition: 'change', quantity: 2,
      notes: `rev B ${runTag}`,
    })
    await addAffectedItem(op(), {
      ecoId, variantId, componentTypeId: typeB, disposition: 'add', quantity: 1,
    })

    const res = await applyEcoEffectivity(op(), { ecoId })
    expect(res).toMatchObject({
      itemsApplied: 2, linesOpened: 2, linesClosed: 1, alreadyApplied: false,
    })

    const lines = await myLines()
    const closed = lines.find((l) => l.superseded_by_eco_id === ecoId)
    expect(closed).toMatchObject({ to_date: '2026-06-01', quantity: 1 })
    const opened = lines.filter((l) => l.created_by_eco_id === ecoId)
    expect(opened).toHaveLength(2)
    expect(opened.every((l) => l.from_date === '2026-06-01' && l.to_date === null)).toBe(true)
  })

  it('resolves the BOM on either side of the changeover — half-open, no gap, no overlap', async () => {
    const before = await getVariantBom(op(), { variantId, date: '2026-05-31' })
    expect(before.lines).toHaveLength(1)
    expect(before.lines[0]).toMatchObject({ componentTypeId: typeA, quantity: 1 })
    expect(before.conflicts).toEqual([])

    const onTheDay = await getVariantBom(op(), { variantId, date: '2026-06-01' })
    expect(onTheDay.lines.map((l) => l.componentTypeId).sort())
      .toEqual([typeA, typeB].sort())
    expect(onTheDay.lines.find((l) => l.componentTypeId === typeA)?.quantity).toBe(2)
    expect(onTheDay.conflicts).toEqual([])
  })

  it('is IDEMPOTENT — a second apply writes nothing', async () => {
    const linesBefore = await myLines()
    const again = await applyEcoEffectivity(op(), { ecoId })
    expect(again).toMatchObject({
      itemsApplied: 0, linesOpened: 0, linesClosed: 0, alreadyApplied: true,
    })
    expect(await myLines()).toHaveLength(linesBefore.length)
  })

  it('freezes the affected-item list once applied', async () => {
    await expect(addAffectedItem(op(), {
      ecoId, variantId, componentTypeId: typeB, disposition: 'remove',
    })).rejects.toThrow(AffectedItemLockedError)
  })
})

describe('applying by SERIAL effectivity, and the precedence rule end to end', () => {
  it('a serial-effective change is invisible to earlier serials and live for later ones', async () => {
    const ecoId = await implementedEco(`Serial-change ${runTag}`, {
      effectivitySerial: `QTX-BT-00500`,
    })
    await addAffectedItem(op(), {
      ecoId, variantId, componentTypeId: typeA, disposition: 'change', quantity: 7,
    })
    const res = await applyEcoEffectivity(op(), { ecoId })
    expect(res).toMatchObject({ itemsApplied: 1, linesOpened: 1, linesClosed: 1 })

    // Asking with a serial BELOW the cut still sees the previous quantity, even
    // though the date axis alone would already have moved on.
    const early = await getVariantBom(op(), {
      variantId, date: '2030-01-01', serial: 'QTX-BT-00499',
    })
    expect(early.lines.find((l) => l.componentTypeId === typeA)?.quantity).toBe(2)

    const late = await getVariantBom(op(), {
      variantId, date: '2030-01-01', serial: 'QTX-BT-00500',
    })
    expect(late.lines.find((l) => l.componentTypeId === typeA)?.quantity).toBe(7)

    // A serial from a DIFFERENT prefix family is uncomparable, so the serial
    // axis abstains and the date axis answers — the line is current by date.
    const otherFamily = await getVariantBom(op(), {
      variantId, date: '2030-01-01', serial: 'ZZZ-99-00001',
    })
    expect(otherFamily.lines.find((l) => l.componentTypeId === typeA)?.quantity).toBe(7)
  })

  it('a `remove` drops the type from the BOM and opens no successor', async () => {
    const ecoId = await implementedEco(`Remove ${runTag}`, { effectivityDate: '2027-01-01' })
    await addAffectedItem(op(), {
      ecoId, variantId, componentTypeId: typeB, disposition: 'remove',
    })
    const res = await applyEcoEffectivity(op(), { ecoId })
    expect(res).toMatchObject({ itemsApplied: 1, linesOpened: 0, linesClosed: 1 })

    const after = await getVariantBom(op(), { variantId, date: '2027-01-01' })
    expect(after.lines.map((l) => l.componentTypeId)).not.toContain(typeB)
    // …and the history still shows it
    expect(after.history.some((l) => l.componentTypeId === typeB)).toBe(true)
  })
})
