import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import {
  listComponentTypes, createComponentType, updateComponentType,
} from '@/modules/manufacturing/services/componentCatalogueService'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client
let adminId: string
const admin = (): Actor => ({
  id: adminId, roleKey: 'super_admin',
  permissions: new Set(['manage_vocabularies', 'view_records']),
  moduleAccess: new Set(['manufacturing']), active: true,
})
const operator = (): Actor => ({
  id: adminId, roleKey: 'operator',
  permissions: new Set(['view_records']), moduleAccess: new Set(['manufacturing']), active: true,
})

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  adminId = (await db.query(`SELECT id FROM app_user WHERE email='reetmitra8@gmail.com'`)).rows[0].id
})
afterAll(async () => { await db.end(); await getPool().end() })

describe('componentCatalogueService', () => {
  it('lists active types by default, incl. the three seeded', async () => {
    const types = await listComponentTypes(admin())
    expect(types.map((t) => t.code)).toEqual(expect.arrayContaining(['pcba_a', 'pcba_b', 'hmi_screen']))
    expect(types.every((t) => t.active)).toBe(true)
  })

  it('refuses creation without manage_vocabularies', async () => {
    await expect(createComponentType(operator(), {
      code: 'sensor', name: 'Sensor', trackingMode: 'batch',
    })).rejects.toThrow(PermissionError)
  })

  it('creates a batch type and audits it', async () => {
    const { id } = await createComponentType(admin(), {
      code: 'cable', name: 'Cable', trackingMode: 'batch',
    })
    const { rows } = await db.query(`SELECT tracking_mode FROM component_type WHERE id=$1`, [id])
    expect(rows[0].tracking_mode).toBe('batch')
    const audit = await db.query(
      `SELECT actor_id FROM audit_log WHERE table_name='component_type' AND row_id=$1
        ORDER BY occurred_at DESC LIMIT 1`, [id])
    expect(audit.rows[0].actor_id).toBe(adminId)
  })

  it('rejects a duplicate code', async () => {
    await expect(createComponentType(admin(), {
      code: 'pcba_a', name: 'Dup', trackingMode: 'serialized',
    })).rejects.toThrow()
  })

  it('updates name/active but NEVER tracking_mode', async () => {
    const { id } = await createComponentType(admin(), {
      code: 'enclosure', name: 'Enclosure', trackingMode: 'batch',
    })
    const v = (await db.query(`SELECT version FROM component_type WHERE id=$1`, [id])).rows[0].version
    await updateComponentType(admin(), id, { name: 'Enclosure v2', active: false }, v)
    const { rows } = await db.query(
      `SELECT name, active, tracking_mode FROM component_type WHERE id=$1`, [id])
    expect(rows[0]).toMatchObject({ name: 'Enclosure v2', active: false, tracking_mode: 'batch' })
  })

  it('rejects a stale version', async () => {
    const { id } = await createComponentType(admin(), {
      code: 'gasket', name: 'Gasket', trackingMode: 'batch',
    })
    await expect(updateComponentType(admin(), id, { name: 'X' }, 999))
      .rejects.toThrow(/modified by someone else/i)
  })
})
