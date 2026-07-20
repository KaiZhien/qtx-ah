import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { Client } from 'pg'

let db: Client
let userId: string
let deviceId: string
let pcbaTypeId: string

beforeAll(async () => {
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  userId = (await db.query(`SELECT id FROM app_user WHERE email = 'reetmitra8@gmail.com'`)).rows[0].id
  deviceId = (await db.query(`
    INSERT INTO device (variant_id, status, created_by, updated_by)
    VALUES ((SELECT id FROM device_variant WHERE code='pro'), 'in_stock', $1, $1) RETURNING id`,
    [userId])).rows[0].id
  pcbaTypeId = (await db.query(`SELECT id FROM component_type WHERE code='pcba_a'`)).rows[0].id
})
afterAll(async () => { await db.end() })

const install = async (over: Record<string, unknown> = {}) => {
  // batch_no default satisfies unit_or_batch (component_unit_id OR batch_no required);
  // none of this file's tests exercise serialized-unit attribution, so a batch value is
  // the minimal fixture — override with component_unit_id where a test cares which.
  const cols = { device_id: deviceId, component_type_id: pcbaTypeId, slot_no: 1,
    batch_no: 'BATCH-TEST-1', installed_by: userId, created_by: userId, ...over }
  const keys = Object.keys(cols)
  const { rows } = await db.query(
    `INSERT INTO component_installation (${keys.join(',')})
     VALUES (${keys.map((_, i) => `$${i + 1}`).join(',')}) RETURNING id`, Object.values(cols))
  return rows[0].id
}

describe('component schema', () => {
  it('seeds the three existing component types with tracking_mode', async () => {
    const { rows } = await db.query(
      `SELECT code, tracking_mode FROM component_type ORDER BY sort`)
    expect(rows.map((r) => r.code)).toEqual(['pcba_a', 'pcba_b', 'hmi_screen'])
    expect(rows.every((r) => r.tracking_mode === 'serialized')).toBe(true)
  })

  it('rejects an unknown tracking_mode', async () => {
    await expect(db.query(
      `INSERT INTO component_type (code, name, tracking_mode) VALUES ('x','X','magic')`))
      .rejects.toThrow()
  })

  it('allows at most one OPEN installation per device+type+slot', async () => {
    const id = await install({ slot_no: 2 })
    await expect(install({ slot_no: 2 })).rejects.toThrow(/one_open_install/)
    // closing the first frees the slot
    await db.query(`UPDATE component_installation SET removed_at=now(), removed_by=$1 WHERE id=$2`,
      [userId, id])
    await expect(install({ slot_no: 2 })).resolves.toBeTruthy()
  })

  it('enforces removal completeness (removed_at ⇔ removed_by)', async () => {
    const id = await install({ slot_no: 3 })
    await expect(db.query(
      `UPDATE component_installation SET removed_at=now() WHERE id=$1`, [id]))
      .rejects.toThrow(/removal_complete/)
  })

  it('is append-only: a committed installation row cannot be deleted', async () => {
    const id = await install({ slot_no: 4 })
    await expect(db.query(`DELETE FROM component_installation WHERE id=$1`, [id]))
      .rejects.toThrow(/append-only/)
  })

  it('is append-only: cannot rewrite device/type/installed_at after the fact', async () => {
    const id = await install({ slot_no: 5 })
    await expect(db.query(
      `UPDATE component_installation SET installed_at=now() - interval '1 year' WHERE id=$1`, [id]))
      .rejects.toThrow(/append-only|immutable/)
  })

  it('unique serial per type among live units', async () => {
    await db.query(`INSERT INTO component_unit (component_type_id, serial_no, created_by, updated_by)
      VALUES ($1,'SN-1',$2,$2)`, [pcbaTypeId, userId])
    await expect(db.query(`INSERT INTO component_unit (component_type_id, serial_no, created_by, updated_by)
      VALUES ($1,'SN-1',$2,$2)`, [pcbaTypeId, userId])).rejects.toThrow()
  })

  it('preserves bilingual component notes verbatim', async () => {
    const id = await install({ slot_no: 6, notes: '电源板初装 — first fit' })
    const { rows } = await db.query(`SELECT notes FROM component_installation WHERE id=$1`, [id])
    expect(rows[0].notes).toBe('电源板初装 — first fit')
  })

  it('has RLS enabled on all four component tables', async () => {
    const { rows } = await db.query(
      `SELECT relname FROM pg_class WHERE relname = ANY($1) AND relkind='r' AND relrowsecurity`,
      [['component_type', 'component_unit', 'component_installation', 'variant_bom_line']])
    expect(rows.map((r) => r.relname).sort()).toEqual(
      ['component_installation', 'component_type', 'component_unit', 'variant_bom_line'])
  })
})
