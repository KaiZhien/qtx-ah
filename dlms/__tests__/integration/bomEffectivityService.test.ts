// __tests__/integration/bomEffectivityService.test.ts
//
// BOM effectivity against a real Postgres (TEST_DATABASE_URL).
//
// This suite creates its OWN device_variant and component_type rows, tagged per
// run, and never touches the seeded ones — variant_bom_line is shared state and
// a test that rewrote the seeded Pro BOM would corrupt every later run of this
// non-rollback database. Every assertion is scoped to rows this run created.
//
// Run and green as of the 2026-08-04 merge (`npm run test:integration`).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import {
  addAffectedItem, removeAffectedItem, applyEcoEffectivity,
  listAffectedItems, getVariantBom,
  BomApplyError, AffectedItemLockedError, DuplicateAffectedItemError,
  type VariantBomView,
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
/** Holds every permission this file uses, in the WRONG module. */
const outsider = (): Actor => ({
  id: userId, roleKey: 'operator',
  permissions: new Set(['view_records', 'create_records', 'edit_records']),
  moduleAccess: new Set(['manufacturing']), active: true,
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

/**
 * Drops component types together with everything that points AT them.
 *
 * `ec_affected_item.component_type_id` is a foreign key, and `addAffectedItem`
 * writes one for every disposition these tests exercise — so a nested afterAll
 * that deletes only `variant_bom_line` and then `component_type` dies on
 * `ec_affected_item_component_type_id_fkey`. The affected items are cleared by
 * `eco_id` in the FILE-level afterAll, which runs LAST: too late for a nested
 * block, and the throw took the rest of that block's cleanup with it. Scoping the
 * same delete by component type is what makes each block self-contained.
 */
async function dropComponentTypes(ids: string[]) {
  await db.query(`DELETE FROM ec_affected_item WHERE component_type_id = ANY($1)`, [ids])
  await db.query(`DELETE FROM variant_bom_line WHERE component_type_id = ANY($1)`, [ids])
  await db.query(`DELETE FROM component_type WHERE id = ANY($1)`, [ids])
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

/**
 * C1 — THE CASE THE `change` TEST ABOVE HID.
 *
 * A serial-only ECO writes its bound on the serial axis and NULL on the date
 * axis, and dateAxisVerdict answers 'in' for a line with no date bounds — for
 * every date, unconditionally. All three dispositions leave that shape, but only
 * `change` leaves TWO simultaneously-effective lines, so only `change` was
 * caught by findBomEffectivityConflicts and by the test above it. `remove` left
 * the dropped component listed on every date-only BOM forever, and `add` listed
 * the new one on dates years before the change — both with a single line, both
 * with no warning of any kind.
 *
 * The fix is NOT a synthesised date bound (see the domain header: that fabricates
 * a calendar claim the engineer never made, and units built after it really do
 * still carry the old part). It is to report the answer as UNDER-DETERMINED, so
 * every surface can say the date alone cannot decide. These tests assert BOTH:
 * the date-axis answer is unchanged (it is the floor and must still answer), and
 * it now arrives flagged.
 *
 * Its own variant and component types, so the assertions are independent of the
 * shared BOM the suite above mutates.
 */
describe('a serial-only ECO judged on the date axis — all three dispositions', () => {
  let v2: string
  let tAdd: string
  let tRemove: string
  let tChange: string
  const CUT = 'QTX-C1-00500'

  const typesIn = (view: VariantBomView) => view.lines.map((l) => l.componentTypeId)
  const flagged = (view: VariantBomView) => view.underdetermined.map((u) => u.componentTypeId)
  const overlapping = (view: VariantBomView) => view.conflicts.map((c) => c.componentTypeId)

  beforeAll(async () => {
    v2 = (await db.query<{ id: string }>(
      `INSERT INTO device_variant (code, name, active) VALUES ($1,$2,true) RETURNING id`,
      [`c1-${runTag}`, `C1 Variant ${runTag}`])).rows[0].id
    const mkType = async (suffix: string) => (await db.query<{ id: string }>(
      `INSERT INTO component_type (code, name, tracking_mode, created_by)
       VALUES ($1,$2,'serialized',$3) RETURNING id`,
      [`c1-${suffix}-${runTag}`, `C1 ${suffix} ${runTag}`, userId])).rows[0].id
    tAdd = await mkType('add')
    tRemove = await mkType('remove')
    tChange = await mkType('change')

    // The starting BOM: the two types an ECO can close are already on it,
    // unbounded on both axes; the `add` type deliberately is not.
    for (const t of [tRemove, tChange]) {
      await db.query(
        `INSERT INTO variant_bom_line (variant_id, component_type_id, quantity, created_by, updated_by)
         VALUES ($1,$2,1,$3,$3)`, [v2, t, userId])
    }
  })

  afterAll(async () => {
    await db.query(`DELETE FROM variant_bom_line WHERE variant_id = $1`, [v2])
    await dropComponentTypes([tAdd, tRemove, tChange])
    await db.query(`DELETE FROM device_variant WHERE id = $1`, [v2])
  })

  it('REMOVE: the dropped component is still listed by date — and now says so', async () => {
    const ecoId = await implementedEco(`C1-remove ${runTag}`, { effectivitySerial: CUT })
    await addAffectedItem(op(), {
      ecoId, variantId: v2, componentTypeId: tRemove, disposition: 'remove',
    })
    await applyEcoEffectivity(op(), { ecoId })

    const byDate = await getVariantBom(op(), { variantId: v2, date: '2030-01-01' })
    // The date-axis answer is unchanged: still listed, four years later.
    expect(typesIn(byDate)).toContain(tRemove)
    // ONE line, so nothing overlaps — this is precisely why it was invisible.
    expect(overlapping(byDate)).not.toContain(tRemove)
    // The fix: the answer arrives flagged as a guess.
    expect(flagged(byDate)).toContain(tRemove)

    // A comparable serial settles it exactly, in both directions, with no caveat.
    const at = await getVariantBom(op(), { variantId: v2, date: '2030-01-01', serial: CUT })
    expect(typesIn(at)).not.toContain(tRemove)
    expect(flagged(at)).not.toContain(tRemove)

    const before = await getVariantBom(op(), {
      variantId: v2, date: '2030-01-01', serial: 'QTX-C1-00499',
    })
    expect(typesIn(before)).toContain(tRemove)
    expect(flagged(before)).not.toContain(tRemove)
  })

  it('ADD: the new component is listed on dates BEFORE the change — and now says so', async () => {
    const ecoId = await implementedEco(`C1-add ${runTag}`, { effectivitySerial: CUT })
    await addAffectedItem(op(), {
      ecoId, variantId: v2, componentTypeId: tAdd, disposition: 'add', quantity: 1,
    })
    await applyEcoEffectivity(op(), { ecoId })

    // Six years before the change order existed.
    const longBefore = await getVariantBom(op(), { variantId: v2, date: '2020-01-01' })
    expect(typesIn(longBefore)).toContain(tAdd)
    expect(overlapping(longBefore)).not.toContain(tAdd)
    expect(flagged(longBefore)).toContain(tAdd)

    const belowCut = await getVariantBom(op(), {
      variantId: v2, date: '2020-01-01', serial: 'QTX-C1-00499',
    })
    expect(typesIn(belowCut)).not.toContain(tAdd)
    expect(flagged(belowCut)).not.toContain(tAdd)
  })

  it('CHANGE: the one shape the overlap detector saw — both now agree', async () => {
    const ecoId = await implementedEco(`C1-change ${runTag}`, { effectivitySerial: CUT })
    await addAffectedItem(op(), {
      ecoId, variantId: v2, componentTypeId: tChange, disposition: 'change', quantity: 7,
    })
    await applyEcoEffectivity(op(), { ecoId })

    const byDate = await getVariantBom(op(), { variantId: v2, date: '2030-01-01' })
    expect(overlapping(byDate)).toContain(tChange)   // what already worked
    expect(flagged(byDate)).toContain(tChange)       // and what now matches it

    const at = await getVariantBom(op(), { variantId: v2, date: '2030-01-01', serial: CUT })
    expect(at.lines.find((l) => l.componentTypeId === tChange)?.quantity).toBe(7)
    expect(overlapping(at)).not.toContain(tChange)
    expect(flagged(at)).not.toContain(tChange)
  })

  it('an UNCOMPARABLE query serial settles nothing, so all three stay flagged', async () => {
    // Another prefix family: serialAxisVerdict abstains and the date axis
    // answers, which is the same guess as supplying no serial at all. The old
    // banner read "…even at this serial, the data needs fixing", which was
    // wrong twice: nothing is corrupt, and it never fired for two of three.
    const other = await getVariantBom(op(), {
      variantId: v2, date: '2030-01-01', serial: 'ZZZ-99-00001',
    })
    expect(flagged(other)).toEqual(expect.arrayContaining([tAdd, tRemove, tChange]))
  })
})

/**
 * I4 — ECOs are approved in APPROVAL order, never in effectivity order, so
 * applying one whose point sits BELOW the line it would close is ordinary. The
 * close-UPDATE never checked, and the two axes failed differently:
 *
 *   DATE   — bom_line_date_window rejects it, but as a raw 23514 that the action
 *            layer can only render as "Something went wrong". Safe, and a dead end.
 *   SERIAL — no CHECK, and there cannot be one (free text, no total order at the
 *            column level). [QTX-OO-00500, QTX-OO-00300) was simply WRITTEN: the
 *            line unreachable at every serial, and the history table rendering
 *            "From QTX-OO-00500 / To QTX-OO-00300" with nothing flagged.
 */
describe('applying change orders OUT OF EFFECTIVITY ORDER', () => {
  let v3: string
  let tSerial: string
  let tDate: string

  beforeAll(async () => {
    v3 = (await db.query<{ id: string }>(
      `INSERT INTO device_variant (code, name, active) VALUES ($1,$2,true) RETURNING id`,
      [`oo-${runTag}`, `Out-of-order ${runTag}`])).rows[0].id
    const mkType = async (suffix: string) => (await db.query<{ id: string }>(
      `INSERT INTO component_type (code, name, tracking_mode, created_by)
       VALUES ($1,$2,'serialized',$3) RETURNING id`,
      [`oo-${suffix}-${runTag}`, `OO ${suffix} ${runTag}`, userId])).rows[0].id
    tSerial = await mkType('serial')
    tDate = await mkType('date')
    for (const t of [tSerial, tDate]) {
      await db.query(
        `INSERT INTO variant_bom_line (variant_id, component_type_id, quantity, created_by, updated_by)
         VALUES ($1,$2,1,$3,$3)`, [v3, t, userId])
    }
  })

  afterAll(async () => {
    await db.query(`DELETE FROM variant_bom_line WHERE variant_id = $1`, [v3])
    await dropComponentTypes([tSerial, tDate])
    await db.query(`DELETE FROM device_variant WHERE id = $1`, [v3])
  })

  it('refuses to close a line at a SERIAL below its own start — nothing else can', async () => {
    // First, the in-order apply that opens a line starting at 00500.
    const first = await implementedEco(`OO-serial-1 ${runTag}`, {
      effectivitySerial: 'QTX-OO-00500',
    })
    await addAffectedItem(op(), {
      ecoId: first, variantId: v3, componentTypeId: tSerial, disposition: 'change', quantity: 2,
    })
    await applyEcoEffectivity(op(), { ecoId: first })

    // Then one approved later but effective EARLIER. Closing at 00300 would
    // write [00500, 00300) — accepted by every constraint on the table.
    const second = await implementedEco(`OO-serial-2 ${runTag}`, {
      effectivitySerial: 'QTX-OO-00300',
    })
    await addAffectedItem(op(), {
      ecoId: second, variantId: v3, componentTypeId: tSerial, disposition: 'change', quantity: 3,
    })
    const err = await applyEcoEffectivity(op(), { ecoId: second }).catch((e) => e)
    expect(err).toBeInstanceOf(BomApplyError)
    expect((err as BomApplyError).code).toBe('effectivity_before_line_start')
    // The message names BOTH serials, because "apply the other one first" is
    // only actionable if the operator can see which one.
    expect((err as BomApplyError).message).toContain('QTX-OO-00300')
    expect((err as BomApplyError).message).toContain('QTX-OO-00500')

    // …and nothing was written: no inverted window, no consumed applied_at.
    const { rows } = await db.query(
      `SELECT effective_from_serial AS f, effective_to_serial AS t FROM variant_bom_line
        WHERE variant_id=$1 AND component_type_id=$2 AND effective_from_serial IS NOT NULL`,
      [v3, tSerial])
    expect(rows).toEqual([{ f: 'QTX-OO-00500', t: null }])
    expect((await listAffectedItems(op(), second)).every((i) => i.appliedAt === null)).toBe(true)
  })

  it('refuses the same on the DATE axis with a message, not a raw 23514', async () => {
    const first = await implementedEco(`OO-date-1 ${runTag}`, { effectivityDate: '2027-01-01' })
    await addAffectedItem(op(), {
      ecoId: first, variantId: v3, componentTypeId: tDate, disposition: 'change', quantity: 2,
    })
    await applyEcoEffectivity(op(), { ecoId: first })

    const second = await implementedEco(`OO-date-2 ${runTag}`, { effectivityDate: '2026-01-01' })
    await addAffectedItem(op(), {
      ecoId: second, variantId: v3, componentTypeId: tDate, disposition: 'change', quantity: 3,
    })
    const err = await applyEcoEffectivity(op(), { ecoId: second }).catch((e) => e)
    expect(err).toBeInstanceOf(BomApplyError)
    expect((err as BomApplyError).code).toBe('effectivity_before_line_start')
    expect((err as BomApplyError).message).toContain('2026-01-01')
    // The database's own message must never have been what the operator saw.
    expect((err as BomApplyError).message).not.toContain('bom_line_date_window')
  })

  it('still allows an ECO effective exactly AT the line start — [P,P) is empty, not inverted', async () => {
    // Two change orders effective on the same day is ordinary; the first line
    // covers zero days and the second owns the day. Refusing this would break a
    // legitimate workflow to catch an illegitimate one.
    const t = (await db.query<{ id: string }>(
      `INSERT INTO component_type (code, name, tracking_mode, created_by)
       VALUES ($1,$2,'serialized',$3) RETURNING id`,
      [`oo-same-${runTag}`, `OO same ${runTag}`, userId])).rows[0].id
    await db.query(
      `INSERT INTO variant_bom_line (variant_id, component_type_id, quantity, created_by, updated_by)
       VALUES ($1,$2,1,$3,$3)`, [v3, t, userId])

    const a = await implementedEco(`OO-same-1 ${runTag}`, { effectivityDate: '2028-01-01' })
    await addAffectedItem(op(), {
      ecoId: a, variantId: v3, componentTypeId: t, disposition: 'change', quantity: 2,
    })
    await applyEcoEffectivity(op(), { ecoId: a })

    const b = await implementedEco(`OO-same-2 ${runTag}`, { effectivityDate: '2028-01-01' })
    await addAffectedItem(op(), {
      ecoId: b, variantId: v3, componentTypeId: t, disposition: 'change', quantity: 3,
    })
    await expect(applyEcoEffectivity(op(), { ecoId: b })).resolves.toMatchObject({
      itemsApplied: 1, linesOpened: 1, linesClosed: 1,
    })
    const on = await getVariantBom(op(), { variantId: v3, date: '2028-01-01' })
    expect(on.lines.find((l) => l.componentTypeId === t)?.quantity).toBe(3)

    await dropComponentTypes([t])
  })
})

/**
 * I3 — `SELECT … FOR UPDATE` TAKES NO LOCK WHEN IT RETURNS ZERO ROWS.
 *
 * The `no_effectivity_point` guard made the STATED cause of a raw 23505
 * unreachable, and the header claimed the code path was unreachable outright.
 * It was not: two engineers applying two different implemented ECOs, each with
 * an `add` for the same (variant, component type) not yet on the BOM, lock only
 * their own `eco` row, both see no open line, and both INSERT. The loser got a
 * bare 23505 rendered as "Something went wrong" — no corruption, no explanation.
 *
 * The apply now takes a transaction-scoped ADVISORY lock keyed on the values
 * rather than the rows, so it exists before the row does. The loser therefore
 * waits, sees the line the winner opened, and gets `already_on_bom` — a refusal
 * naming what to do. That is what this asserts: not merely that nothing broke,
 * but that the second engineer is TOLD something true.
 */
describe('two concurrent applies racing to open the SAME BOM line', () => {
  let v4: string
  let t4: string

  beforeAll(async () => {
    v4 = (await db.query<{ id: string }>(
      `INSERT INTO device_variant (code, name, active) VALUES ($1,$2,true) RETURNING id`,
      [`race-${runTag}`, `Race ${runTag}`])).rows[0].id
    t4 = (await db.query<{ id: string }>(
      `INSERT INTO component_type (code, name, tracking_mode, created_by)
       VALUES ($1,$2,'serialized',$3) RETURNING id`,
      [`race-t-${runTag}`, `Race type ${runTag}`, userId])).rows[0].id
  })

  afterAll(async () => {
    await db.query(`DELETE FROM variant_bom_line WHERE variant_id = $1`, [v4])
    await dropComponentTypes([t4])
    await db.query(`DELETE FROM device_variant WHERE id = $1`, [v4])
  })

  it('serializes them: one opens the line, the other is told it is already there', async () => {
    const mk = async (n: number) => {
      const ecoId = await implementedEco(`Race-${n} ${runTag}`, {
        effectivityDate: `2029-0${n}-01`,
      })
      await addAffectedItem(op(), {
        ecoId, variantId: v4, componentTypeId: t4, disposition: 'add', quantity: n,
      })
      return ecoId
    }
    const [e1, e2] = [await mk(1), await mk(2)]

    const results = await Promise.allSettled([
      applyEcoEffectivity(op(), { ecoId: e1 }),
      applyEcoEffectivity(op(), { ecoId: e2 }),
    ])
    const won = results.filter((r) => r.status === 'fulfilled')
    const lost = results.filter((r) => r.status === 'rejected')
    expect(won).toHaveLength(1)
    expect(lost).toHaveLength(1)

    // The loser's error is the domain refusal, NOT a raw unique-violation.
    const reason = (lost[0] as PromiseRejectedResult).reason
    expect(reason).toBeInstanceOf(BomApplyError)
    expect((reason as BomApplyError).code).toBe('already_on_bom')
    expect(String((reason as BomApplyError).message)).not.toContain('bom_line_open_unique')

    // Exactly one line exists, and the loser consumed no applied_at stamp.
    const { rows } = await db.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM variant_bom_line
        WHERE variant_id=$1 AND component_type_id=$2 AND deleted_at IS NULL`, [v4, t4])
    expect(rows[0].n).toBe('1')
  })
})

/**
 * ORDERING, not merely outcome — the same property deviceWriteService.test.ts
 * pins for changeDeviceStatus, and for the same reason. authorize.ts is "the
 * choke point. Every service entry point calls this before touching data", and
 * `applyEcoEffectivityTx`'s extraction is EXACTLY the refactor shape that moves
 * the check inward: every other assertion in this file stays green if it does,
 * while a denied call starts burning a pooled connection plus a BEGIN/ROLLBACK,
 * and a denial during a database outage starts surfacing as a connection error
 * (a 500) instead of a PermissionError (a 403).
 *
 * Proven the only way the outcome distinguishes the two: point a FRESH module
 * graph's pool at an unreachable port. Guard first ⇒ PermissionError; connection
 * first ⇒ the refusal wins and an AggregateError comes back instead.
 */
describe('bomEffectivityService — guards run before the connection', () => {
  it('authorizes and validates before it ever acquires a connection', async () => {
    const previous = process.env.DATABASE_URL
    vi.resetModules()
    process.env.DATABASE_URL = 'postgresql://nobody:nobody@127.0.0.1:1/unreachable'
    try {
      const svc = await import('@/modules/engineering/services/bomEffectivityService')
      const authz = await import('@/modules/shared/authz/authorize')

      await expect(svc.applyEcoEffectivity(viewer(), { ecoId: crypto.randomUUID() }))
        .rejects.toThrow(authz.PermissionError)
      await expect(svc.addAffectedItem(viewer(), {
        ecoId: crypto.randomUUID(), variantId: crypto.randomUUID(),
        componentTypeId: crypto.randomUUID(), disposition: 'remove',
      })).rejects.toThrow(authz.PermissionError)
      // A viewer HOLDS view_records, so the read gate has to be tested with an
      // actor outside the module — otherwise this line would pass while proving
      // nothing about where authorize sits.
      await expect(svc.getVariantBom(outsider(), {
        variantId: crypto.randomUUID(), date: '2026-01-01',
      })).rejects.toThrow(authz.PermissionError)

      // …and validation, which must also fail before a connection is asked for.
      await expect(svc.applyEcoEffectivity(op(), { ecoId: 'not-a-uuid' }))
        .rejects.toThrow(/uuid/i)
      await expect(svc.getVariantBom(op(), { variantId: crypto.randomUUID(), date: '01/01/2026' }))
        .rejects.toThrow(/YYYY-MM-DD/)
    } finally {
      process.env.DATABASE_URL = previous
      vi.resetModules()
    }
  })
})
