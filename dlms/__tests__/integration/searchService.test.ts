// __tests__/integration/searchService.test.ts
//
// THE PERMISSION-LEAK SUITE for global search (spec §8.4).
//
// The security property of this feature is not "denied rows are hidden" — it is
// that a user without a module NEVER LEARNS THE RECORD EXISTS. A search that
// returns an empty "Invoices" group has already disclosed that there is a Finance
// module, and a search that returns the row and filters it in the UI has
// disclosed everything. So these tests assert ABSENCE OF THE GROUP, not emptiness
// of it, and they assert it against real rows that genuinely match the query.
//
// Every fixture below shares one improbable token so each assertion can be
// scoped to rows this file created, and teardown is one predicate per table.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import { globalSearch } from '@/modules/shared/search/services/searchService'
import { visibleSearchGroups } from '@/modules/shared/search/domain/searchGroups'
import type { Actor, ModuleKey, Permission } from '@/modules/shared/authz/catalog'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client
let userId: string
let buyerId: string
let variantId: string
let deviceId: string

/**
 * One token in every fixture. Chosen to survive BOTH normalizations: it has no
 * separators, so `normalizeRef` leaves it intact, and it is a single word, so
 * `normalizeName` leaves it intact too. A token containing a hyphen would be
 * findable by the ref groups and not by the name groups, which would make a
 * missing group ambiguous between "denied" and "did not match".
 */
const TOK = 'zzprobe8831'

const createdDeviceIds: string[] = []
const createdInvoiceIds: string[] = []
const createdTaskIds: string[] = []

const actor = (over: Partial<Actor> = {}): Actor => ({
  id: userId, roleKey: 'operator',
  permissions: new Set<Permission>(['view_records']),
  moduleAccess: new Set<ModuleKey>(['manufacturing', 'tasks']),
  active: true,
  ...over,
})

const groupKeys = (r: { groups: { key: string }[] }) => r.groups.map((g) => g.key)
const hitIds = (r: { groups: { key: string; hits: { id: string }[] }[] }, key: string) =>
  r.groups.find((g) => g.key === key)?.hits.map((h) => h.id) ?? []

beforeAll(async () => {
  // The service under test opens its OWN connection through getPool(), which
  // reads DATABASE_URL. Without this line the pool falls back to libpq defaults
  // and tries to open a database named after the OS user; only this file's own
  // `db` client would reach the test container.
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()

  userId = (await db.query<{ id: string }>(
    `INSERT INTO app_user (email, full_name, role_id, module_access, active)
     SELECT $1, $2, r.id, ARRAY['manufacturing','tasks']::text[], true
       FROM role r WHERE r.key = 'operator'
     ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
     RETURNING id`, [`${TOK}@example.com`, `Probe ${TOK} Person`])).rows[0].id

  variantId = (await db.query<{ id: string }>(
    `SELECT id FROM device_variant LIMIT 1`)).rows[0].id

  // A device whose serial contains the token.
  deviceId = (await db.query<{ id: string }>(
    `INSERT INTO device (device_sn, variant_id, status, created_by, updated_by)
     SELECT $1, $2, s.code, $3, $3 FROM status_option s ORDER BY s.sort_order LIMIT 1
     RETURNING id`, [`QTX-${TOK}-01`, variantId, userId])).rows[0].id
  createdDeviceIds.push(deviceId)

  buyerId = (await db.query<{ id: string }>(
    `INSERT INTO buyer (name, created_by, updated_by) VALUES ($1, $2, $2) RETURNING id`,
    [`${TOK} Holdings`, userId])).rows[0].id

  createdInvoiceIds.push((await db.query<{ id: string }>(
    `INSERT INTO sales_invoice (invoice_no, buyer_id, total_sgd, created_by, updated_by)
     VALUES ($1, $2, '900.00', $3, $3) RETURNING id`,
    [`INV-${TOK}`, buyerId, userId])).rows[0].id)

  createdTaskIds.push((await db.query<{ id: string }>(
    `INSERT INTO task (title, created_by, updated_by) VALUES ($1, $2, $2) RETURNING id`,
    [`Ordinary ${TOK} task`, userId])).rows[0].id)
})

afterAll(async () => {
  await db.query(`DELETE FROM task_link WHERE task_id = ANY($1::uuid[])`, [createdTaskIds])
  await db.query(`DELETE FROM task WHERE id = ANY($1::uuid[])`, [createdTaskIds])
  await db.query(`DELETE FROM sales_invoice WHERE id = ANY($1::uuid[])`, [createdInvoiceIds])
  await db.query(`DELETE FROM buyer WHERE id = $1`, [buyerId])
  await db.query(`DELETE FROM device WHERE id = ANY($1::uuid[])`, [createdDeviceIds])
  await db.end()
  await getPool().end()
})

describe('globalSearch — a denied group is ABSENT, not empty', () => {
  it('finds the device for an actor who holds manufacturing', async () => {
    const r = await globalSearch(actor(), { q: TOK })
    expect(groupKeys(r)).toContain('devices')
    expect(hitIds(r, 'devices')).toContain(deviceId)
  })

  it('OMITS invoices and buyers entirely for an actor without Finance', async () => {
    // Both rows exist and both match the query. The operator must not learn that.
    const r = await globalSearch(actor(), { q: TOK })
    expect(groupKeys(r)).not.toContain('invoices')
    expect(groupKeys(r)).not.toContain('buyers')
    // Belt and braces: no hit anywhere in the payload carries the invoice number.
    const all = JSON.stringify(r)
    expect(all).not.toContain(`INV-${TOK}`)
    expect(all).not.toContain(`${TOK} Holdings`)
  })

  it('returns those same groups to an actor who DOES hold view_finance', async () => {
    // Proves the previous test measured a permission, not a broken query.
    const financeActor = actor({
      roleKey: 'finance',
      permissions: new Set<Permission>(['view_records', 'view_finance']),
      moduleAccess: new Set<ModuleKey>(['finance']),
    })
    const r = await globalSearch(financeActor, { q: TOK })
    expect(groupKeys(r)).toContain('invoices')
    expect(groupKeys(r)).toContain('buyers')
    expect(JSON.stringify(r)).toContain(`INV-${TOK}`)
  })

  it('gives a finance actor NO manufacturing group', async () => {
    const financeActor = actor({
      roleKey: 'finance',
      permissions: new Set<Permission>(['view_records', 'view_finance']),
      moduleAccess: new Set<ModuleKey>(['finance']),
    })
    const r = await globalSearch(financeActor, { q: TOK })
    expect(groupKeys(r)).not.toContain('devices')
    expect(JSON.stringify(r)).not.toContain(`QTX-${TOK}-01`)
  })

  it('OMITS the People group from a non-admin, though the user row matches', async () => {
    const r = await globalSearch(actor(), { q: TOK })
    expect(groupKeys(r)).not.toContain('users')
    expect(JSON.stringify(r)).not.toContain('@example.com')
  })

  it('gives a deactivated actor nothing at all, whatever their role', async () => {
    const dead = actor({ roleKey: 'super_admin', active: false })
    const r = await globalSearch(dead, { q: TOK })
    expect(r.groups).toEqual([])
    expect(visibleSearchGroups(dead)).toEqual([])
  })

  it('runs NO query for an actor with no searchable groups', async () => {
    // The guard is `visibleSearchGroups(...).length === 0` before withTransaction,
    // so this must not even take a connection.
    const nobody = actor({
      permissions: new Set<Permission>([]), moduleAccess: new Set<ModuleKey>([]),
    })
    await expect(globalSearch(nobody, { q: TOK })).resolves.toEqual({
      query: TOK, skipped: false, groups: [],
    })
  })
})

describe('globalSearch — task visibility is the SECOND gate (spec §8.3)', () => {
  let confidentialId: string
  let financeLinkedId: string

  beforeAll(async () => {
    confidentialId = (await db.query<{ id: string }>(
      `INSERT INTO task (title, confidential, created_by, updated_by)
       VALUES ($1, true, $2, $2) RETURNING id`,
      [`Secret ${TOK} task`, userId])).rows[0].id
    createdTaskIds.push(confidentialId)

    financeLinkedId = (await db.query<{ id: string }>(
      `INSERT INTO task (title, created_by, updated_by) VALUES ($1, $2, $2) RETURNING id`,
      [`Linked ${TOK} task`, userId])).rows[0].id
    createdTaskIds.push(financeLinkedId)
    await db.query(
      `INSERT INTO task_link (task_id, entity_type, entity_id, module, created_by)
       VALUES ($1, 'sales_invoice', $2, 'finance', $3)`,
      [financeLinkedId, createdInvoiceIds[0], userId])
  })

  it('shows an ordinary task to an actor with tasks access', async () => {
    const r = await globalSearch(actor(), { q: TOK })
    expect(hitIds(r, 'tasks')).toContain(createdTaskIds[0])
  })

  it('HIDES a confidential task from an uninvolved user, though the title matches', async () => {
    const stranger = actor({ id: '00000000-0000-0000-0000-0000000000ff' })
    const r = await globalSearch(stranger, { q: TOK })
    expect(hitIds(r, 'tasks')).not.toContain(confidentialId)
    expect(JSON.stringify(r)).not.toContain(`Secret ${TOK} task`)
  })

  it('shows a confidential task to its creator', async () => {
    const r = await globalSearch(actor(), { q: TOK })
    expect(hitIds(r, 'tasks')).toContain(confidentialId)
  })

  it('HIDES a Finance-linked task from an actor without Finance access', async () => {
    // Link-derived confidentiality, computed at query time — spec §8.3 requires
    // exactly this so "search/autocomplete can't leak them". The creator is the
    // actor here, and involvement still does NOT waive the module gate.
    const r = await globalSearch(actor(), { q: TOK })
    expect(hitIds(r, 'tasks')).not.toContain(financeLinkedId)
  })

  it('shows that same task once the actor also holds Finance', async () => {
    const both = actor({
      permissions: new Set<Permission>(['view_records', 'view_finance']),
      moduleAccess: new Set<ModuleKey>(['manufacturing', 'tasks', 'finance']),
    })
    const r = await globalSearch(both, { q: TOK })
    expect(hitIds(r, 'tasks')).toContain(financeLinkedId)
  })
})

describe('globalSearch — cost control and ordering', () => {
  it('SKIPS a query below the minimum length without touching the database', async () => {
    const r = await globalSearch(actor(), { q: 'a' })
    expect(r).toEqual({ query: 'a', skipped: true, groups: [] })
  })

  it('skips punctuation that normalizes away, which would otherwise scan everything', async () => {
    // '--' is two characters of input and zero after ref normalization; without
    // the post-normalization length check it reaches the database as LIKE '%%'.
    const r = await globalSearch(actor(), { q: '--' })
    expect(r.skipped).toBe(true)
    expect(r.groups).toEqual([])
  })

  it('ranks an exact serial match above a partial one', async () => {
    const other = (await db.query<{ id: string }>(
      `INSERT INTO device (device_sn, variant_id, status, created_by, updated_by)
       SELECT $1, $2, s.code, $3, $3 FROM status_option s ORDER BY s.sort_order LIMIT 1
       RETURNING id`, [`PRE-QTX-${TOK}-01-SUFFIX`, variantId, userId])).rows[0].id
    createdDeviceIds.push(other)

    const r = await globalSearch(actor(), { q: `QTX-${TOK}-01` })
    const hits = r.groups.find((g) => g.key === 'devices')!.hits
    expect(hits[0].id).toBe(deviceId)          // exact
    expect(hits[0].rank).toBe(0)
    expect(hits.find((h) => h.id === other)!.rank).toBe(2)  // contains
  })

  it('finds a device by a FRAGMENT of its serial, separators and all', async () => {
    // People search for the part they remember, and type it however they like.
    for (const q of [TOK, `qtx ${TOK}`, `QTX${TOK}01`]) {
      const r = await globalSearch(actor(), { q })
      expect(hitIds(r, 'devices'), `query: ${q}`).toContain(deviceId)
    }
  })

  it('treats a LIKE wildcard in user input as a literal, not a wildcard', async () => {
    // '%' must not match every device in the fleet.
    const r = await globalSearch(actor(), { q: '%%' })
    expect(hitIds(r, 'devices')).not.toContain(deviceId)
  })

  it('caps each group at PER_GROUP_LIMIT rows', async () => {
    const extras: string[] = []
    for (let i = 0; i < 8; i++) {
      extras.push((await db.query<{ id: string }>(
        `INSERT INTO device (device_sn, variant_id, status, created_by, updated_by)
         SELECT $1, $2, s.code, $3, $3 FROM status_option s ORDER BY s.sort_order LIMIT 1
         RETURNING id`, [`BULK-${TOK}-${i}`, variantId, userId])).rows[0].id)
    }
    createdDeviceIds.push(...extras)

    const r = await globalSearch(actor(), { q: TOK })
    expect(hitIds(r, 'devices').length).toBeLessThanOrEqual(5)
  })

  it('excludes soft-deleted rows', async () => {
    const gone = (await db.query<{ id: string }>(
      `INSERT INTO device (device_sn, variant_id, status, created_by, updated_by, deleted_at)
       SELECT $1, $2, s.code, $3, $3, now() FROM status_option s ORDER BY s.sort_order LIMIT 1
       RETURNING id`, [`DEL-${TOK}-99`, variantId, userId])).rows[0].id
    createdDeviceIds.push(gone)

    const r = await globalSearch(actor(), { q: `DEL-${TOK}-99` })
    expect(hitIds(r, 'devices')).not.toContain(gone)
  })
})
