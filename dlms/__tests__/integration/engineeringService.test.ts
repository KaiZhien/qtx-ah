// __tests__/integration/engineeringService.test.ts
//
// Integration tests for the Engineering services against a real Postgres
// (TEST_DATABASE_URL), mirroring deviceWriteService.test.ts's harness idiom:
// mock @/lib/supabase/server, real pg for setup/assertions, runTag for unique
// values, cleanup in afterAll. NOT run in this worktree (the controller runs the
// integration suite serially at merge — the DB port is shared with parallel
// agents).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import {
  createEcr, updateEcr, changeEcrStatus,
  createEco, changeEcoStatus,
  createFirmwareRelease, updateFirmwareRelease, changeFirmwareStatus,
  RecordNotFoundError, DuplicateFirmwareError,
} from '@/modules/engineering/services/engineeringWriteService'
import {
  listEcrs, getEcr, listEcos, getEco, listFirmwareReleases, getFirmwareRelease,
  getEngineeringCounts,
} from '@/modules/engineering/services/engineeringReadService'
import { InvalidTransitionError } from '@/modules/engineering/domain/transition'
import { OptimisticLockError } from '@/lib/db/tx'
import { PermissionError } from '@/modules/shared/authz/authorize'
import type { Actor } from '@/modules/shared/authz/catalog'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client
let userId: string
let variantId: string
let componentTypeId: string
const runTag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`
const ecrIds: string[] = []
const ecoIds: string[] = []
const firmwareIds: string[] = []

// operator: view/create/edit, NOT approve_requests
const op = (): Actor => ({
  id: userId, roleKey: 'operator',
  permissions: new Set(['view_records', 'create_records', 'edit_records']),
  moduleAccess: new Set(['engineering']), active: true,
})
// manager: adds approve_requests (can approve ECOs)
const mgr = (): Actor => ({
  id: userId, roleKey: 'manager',
  permissions: new Set(['view_records', 'create_records', 'edit_records', 'approve_requests']),
  moduleAccess: new Set(['engineering']), active: true,
})
const viewer = (): Actor => ({
  id: userId, roleKey: 'viewer',
  permissions: new Set(['view_records']), moduleAccess: new Set(['engineering']), active: true,
})
// no engineering module access at all
const outsider = (): Actor => ({
  id: userId, roleKey: 'operator',
  permissions: new Set(['view_records', 'create_records', 'edit_records']),
  moduleAccess: new Set(['manufacturing']), active: true,
})

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  userId = (await db.query(`SELECT id FROM app_user WHERE email='reetmitra8@gmail.com'`)).rows[0].id
  variantId = (await db.query(`SELECT id FROM device_variant WHERE code='pro'`)).rows[0].id
  componentTypeId = (await db.query(`SELECT id FROM component_type WHERE code='pcba_a'`)).rows[0].id
})
afterAll(async () => {
  // eco → ecr order (eco.ecr_id FK); firmware last (nothing installed references it here).
  if (ecoIds.length) await db.query(`DELETE FROM eco WHERE id = ANY($1)`, [ecoIds])
  if (ecrIds.length) await db.query(`DELETE FROM ecr WHERE id = ANY($1)`, [ecrIds])
  if (firmwareIds.length) await db.query(`DELETE FROM firmware_release WHERE id = ANY($1)`, [firmwareIds])
  await db.end(); await getPool().end()
})

// ═══════════════════════════ ECR ═══════════════════════════════════════════
describe('ECR create/read', () => {
  it('refuses an actor without create_records', async () => {
    await expect(createEcr(viewer(), { title: 'x' })).rejects.toThrow(PermissionError)
  })

  it('refuses an actor without engineering module access', async () => {
    await expect(createEcr(outsider(), { title: 'x' })).rejects.toThrow(PermissionError)
  })

  it('creates a draft ECR with an auto ECR-YYYY-NNNN number', async () => {
    const res = await createEcr(op(), {
      title: 'Tighten PCBA-A torque spec', reason: 'field failures', priority: 'high', variantId,
    })
    ecrIds.push(res.id)
    expect(res.ecrNo).toMatch(/^ECR-\d{4}-\d{4}$/)
    const row = await db.query(
      `SELECT status, title, priority, variant_id, created_by, version FROM ecr WHERE id=$1`, [res.id])
    expect(row.rows[0]).toMatchObject({
      status: 'draft', title: 'Tighten PCBA-A torque spec', priority: 'high',
      variant_id: variantId, created_by: userId, version: 1,
    })
  })

  it('getEcr returns null for an unknown id (→ 404)', async () => {
    expect(await getEcr(op(), '00000000-0000-0000-0000-000000000000')).toBeNull()
  })

  it('listEcrs finds a created ECR by title fragment', async () => {
    const res = await createEcr(op(), { title: `Findable-${runTag}` })
    ecrIds.push(res.id)
    const { items } = await listEcrs(op(), { q: `findable-${runTag}` })
    expect(items.map((i) => i.id)).toContain(res.id)
  })
})

describe('ECR status flow', () => {
  it('advances draft → submitted → accepted and bumps version each step', async () => {
    const c = await createEcr(op(), { title: 'flow' })
    ecrIds.push(c.id)
    const v0 = (await db.query(`SELECT version FROM ecr WHERE id=$1`, [c.id])).rows[0].version
    const s1 = await changeEcrStatus(op(), { id: c.id, toStatus: 'submitted', version: v0 })
    expect(s1).toMatchObject({ status: 'submitted', version: v0 + 1 })
    const s2 = await changeEcrStatus(op(), { id: c.id, toStatus: 'accepted', version: s1.version })
    expect(s2.status).toBe('accepted')
  })

  it('rejects an illegal move fail-closed (draft → accepted)', async () => {
    const c = await createEcr(op(), { title: 'illegal' })
    ecrIds.push(c.id)
    const v0 = (await db.query(`SELECT version FROM ecr WHERE id=$1`, [c.id])).rows[0].version
    await expect(changeEcrStatus(op(), { id: c.id, toStatus: 'accepted', version: v0 }))
      .rejects.toThrow(InvalidTransitionError)
    const still = await db.query(`SELECT status FROM ecr WHERE id=$1`, [c.id])
    expect(still.rows[0].status).toBe('draft') // unchanged
  })

  it('rejects a stale version with OptimisticLockError', async () => {
    const c = await createEcr(op(), { title: 'stale' })
    ecrIds.push(c.id)
    await expect(changeEcrStatus(op(), { id: c.id, toStatus: 'submitted', version: 999 }))
      .rejects.toThrow(OptimisticLockError)
  })
})

describe('updateEcr', () => {
  it('edits fields, bumps version, leaves status untouched', async () => {
    const c = await createEcr(op(), { title: 'before', priority: 'low' })
    ecrIds.push(c.id)
    const v0 = (await db.query(`SELECT version FROM ecr WHERE id=$1`, [c.id])).rows[0].version
    const res = await updateEcr(op(), { id: c.id, version: v0, title: 'after', priority: 'urgent' })
    expect(res.version).toBe(v0 + 1)
    const row = await db.query(`SELECT title, priority, status, updated_by FROM ecr WHERE id=$1`, [c.id])
    expect(row.rows[0]).toMatchObject({ title: 'after', priority: 'urgent', status: 'draft', updated_by: userId })
  })

  it('throws RecordNotFoundError for an unknown id', async () => {
    await expect(updateEcr(op(), { id: '00000000-0000-0000-0000-000000000000', version: 1, title: 'x' }))
      .rejects.toThrow(RecordNotFoundError)
  })
})

// ═══════════════════════════ ECO ═══════════════════════════════════════════
describe('ECO approval gate', () => {
  it('creates a draft ECO linked to an ECR', async () => {
    const ecr = await createEcr(op(), { title: 'source ecr' })
    ecrIds.push(ecr.id)
    const eco = await createEco(op(), { title: 'realising order', ecrId: ecr.id })
    ecoIds.push(eco.id)
    expect(eco.ecoNo).toMatch(/^ECO-\d{4}-\d{4}$/)
    const row = await db.query(`SELECT status, ecr_id FROM eco WHERE id=$1`, [eco.id])
    expect(row.rows[0]).toMatchObject({ status: 'draft', ecr_id: ecr.id })
  })

  it('lets any editor submit, but blocks approve without approve_requests', async () => {
    const eco = await createEco(op(), { title: 'to approve' })
    ecoIds.push(eco.id)
    const v0 = (await db.query(`SELECT version FROM eco WHERE id=$1`, [eco.id])).rows[0].version
    const submitted = await changeEcoStatus(op(), { id: eco.id, toStatus: 'submitted', version: v0 })
    // operator lacks approve_requests → PermissionError, nothing written
    await expect(changeEcoStatus(op(), { id: eco.id, toStatus: 'approved', version: submitted.version }))
      .rejects.toThrow(PermissionError)
    const still = await db.query(`SELECT status FROM eco WHERE id=$1`, [eco.id])
    expect(still.rows[0].status).toBe('submitted')
    // manager holds approve_requests → succeeds
    const approved = await changeEcoStatus(mgr(), { id: eco.id, toStatus: 'approved', version: submitted.version })
    expect(approved.status).toBe('approved')
    // then implemented (no approval needed)
    const impl = await changeEcoStatus(op(), { id: eco.id, toStatus: 'implemented', version: approved.version })
    expect(impl.status).toBe('implemented')
  })

  it('rejects skipping approval (submitted → implemented)', async () => {
    const eco = await createEco(op(), { title: 'skip' })
    ecoIds.push(eco.id)
    const v0 = (await db.query(`SELECT version FROM eco WHERE id=$1`, [eco.id])).rows[0].version
    const submitted = await changeEcoStatus(op(), { id: eco.id, toStatus: 'submitted', version: v0 })
    await expect(changeEcoStatus(mgr(), { id: eco.id, toStatus: 'implemented', version: submitted.version }))
      .rejects.toThrow(InvalidTransitionError)
  })

  it('getEco / listEcos surface the row', async () => {
    const eco = await createEco(op(), { title: `eco-${runTag}` })
    ecoIds.push(eco.id)
    const detail = await getEco(op(), eco.id)
    expect(detail?.ecoNo).toBe(eco.ecoNo)
    const { items } = await listEcos(op(), { q: `eco-${runTag}` })
    expect(items.map((i) => i.id)).toContain(eco.id)
  })
})

// ══════════════════════ Firmware releases ══════════════════════════════════
describe('firmware releases', () => {
  it('creates a draft release and rejects a duplicate version per type', async () => {
    const ver = `1.0.0-${runTag}`
    const a = await createFirmwareRelease(op(), { componentTypeId, fwVersion: ver, changelog: 'first' })
    firmwareIds.push(a.id)
    const row = await db.query(`SELECT status, fw_version, component_type_id FROM firmware_release WHERE id=$1`, [a.id])
    expect(row.rows[0]).toMatchObject({ status: 'draft', fw_version: ver, component_type_id: componentTypeId })
    await expect(createFirmwareRelease(op(), { componentTypeId, fwVersion: ver }))
      .rejects.toThrow(DuplicateFirmwareError)
  })

  it('advances draft → released → withdrawn', async () => {
    const a = await createFirmwareRelease(op(), { componentTypeId, fwVersion: `2.0.0-${runTag}` })
    firmwareIds.push(a.id)
    const v0 = (await db.query(`SELECT version FROM firmware_release WHERE id=$1`, [a.id])).rows[0].version
    const rel = await changeFirmwareStatus(op(), { id: a.id, toStatus: 'released', version: v0 })
    expect(rel.status).toBe('released')
    const wd = await changeFirmwareStatus(op(), { id: a.id, toStatus: 'withdrawn', version: rel.version })
    expect(wd.status).toBe('withdrawn')
  })

  it('rejects withdrawing a draft directly (fail-closed)', async () => {
    const a = await createFirmwareRelease(op(), { componentTypeId, fwVersion: `3.0.0-${runTag}` })
    firmwareIds.push(a.id)
    const v0 = (await db.query(`SELECT version FROM firmware_release WHERE id=$1`, [a.id])).rows[0].version
    await expect(changeFirmwareStatus(op(), { id: a.id, toStatus: 'withdrawn', version: v0 }))
      .rejects.toThrow(InvalidTransitionError)
  })

  it('updateFirmwareRelease edits the changelog under optimistic lock', async () => {
    const a = await createFirmwareRelease(op(), { componentTypeId, fwVersion: `4.0.0-${runTag}` })
    firmwareIds.push(a.id)
    const v0 = (await db.query(`SELECT version FROM firmware_release WHERE id=$1`, [a.id])).rows[0].version
    const res = await updateFirmwareRelease(op(), { id: a.id, version: v0, changelog: 'edited notes' })
    expect(res.version).toBe(v0 + 1)
    const row = await db.query(`SELECT changelog FROM firmware_release WHERE id=$1`, [a.id])
    expect(row.rows[0].changelog).toBe('edited notes')
  })

  it('getFirmwareRelease / listFirmwareReleases surface the row', async () => {
    const a = await createFirmwareRelease(op(), { componentTypeId, fwVersion: `5.0.0-${runTag}` })
    firmwareIds.push(a.id)
    const detail = await getFirmwareRelease(op(), a.id)
    expect(detail?.fwVersion).toBe(`5.0.0-${runTag}`)
    const { items } = await listFirmwareReleases(op(), { q: `5.0.0-${runTag}` })
    expect(items.map((i) => i.id)).toContain(a.id)
  })
})

// ══════════════════════ Landing counts ═════════════════════════════════════
describe('getEngineeringCounts', () => {
  it('returns status-grouped counts for each entity; a fresh draft ECR shows up', async () => {
    const c = await createEcr(op(), { title: 'counted' })
    ecrIds.push(c.id)
    const counts = await getEngineeringCounts(op())
    expect(Array.isArray(counts.ecr)).toBe(true)
    expect(Array.isArray(counts.eco)).toBe(true)
    expect(Array.isArray(counts.firmware)).toBe(true)
    const draft = counts.ecr.find((r) => r.status === 'draft')
    expect(draft && draft.count).toBeGreaterThanOrEqual(1)
  })

  it('refuses a caller without view_records / module access', async () => {
    await expect(getEngineeringCounts(outsider())).rejects.toThrow(PermissionError)
  })
})
