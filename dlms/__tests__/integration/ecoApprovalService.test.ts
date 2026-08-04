// __tests__/integration/ecoApprovalService.test.ts
//
// Engineering's ECO approval, migrated onto the shared approvals engine.
//
// The file is organised around the one question a reviewer of this refactor
// should ask: DID ANYTHING THAT WORKED STOP WORKING? So the first describe block
// re-asserts the pre-existing behaviour end to end (approve_requests still gates
// submitted → approved; an ECO nobody raised a request for still approves exactly
// as before), and only then does the engine's ceremony get exercised.
//
// The drift test is the point of the whole slice: approve, edit the ECO, attempt
// the gated move, and assert the refusal NAMES the field and both values.
//
// Run and green as of the 2026-08-04 merge (`npm run test:integration`).
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import { PermissionError } from '@/modules/shared/authz/authorize'
import { OptimisticLockError } from '@/lib/db/tx'
import type { Actor } from '@/modules/shared/authz/catalog'
import {
  createEco, updateEco, changeEcoStatus,
} from '@/modules/engineering/services/engineeringWriteService'
import {
  addAffectedItem, removeAffectedItem, applyEcoEffectivity,
} from '@/modules/engineering/services/bomEffectivityService'
import {
  requestEcoApproval, getEcoApprovalState,
  EcoApprovalError, EcoApprovalRequestError, EcoNotFoundError,
} from '@/modules/engineering/services/ecoService'
import { EcoScopeLockedError } from '@/modules/shared/approvals/domain/ecoApproval'
import { decideApproval } from '@/modules/shared/approvals/services/approvalService'
import { drainOutbox } from '@/modules/shared/outbox/services/outboxService'

// actor.ts (reached through the outbox drain) imports the Supabase server client
// for the HUMAN login path; nothing under test goes near it.
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client
let engineerId: string
let approverId: string
// Private BOM fixtures, tagged per run: `variant_bom_line` is shared, non-rollback
// state and a test that rewrote a seeded variant's BOM would corrupt every later
// run. Nothing here touches a seeded row.
let variantA: string
let variantB: string
let typeA: string
let typeB: string

const createdEcoIds: string[] = []
const createdApprovalIds: string[] = []

const runTag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

const makeUser = async (email: string, name: string, roleKey: string) =>
  (await db.query<{ id: string }>(
    `INSERT INTO app_user (email, full_name, role_id, department, module_access, active)
     SELECT $1, $2, r.id, 'Engineering', ARRAY['engineering','tasks']::text[], true
       FROM role r WHERE r.key = $3
     ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
     RETURNING id`, [email, name, roleKey])).rows[0].id

/** Engineer: may edit and submit ECOs. May NOT approve — no approve_requests. */
const eng = (over: Partial<Actor> = {}): Actor => ({
  id: engineerId, roleKey: 'operator',
  permissions: new Set(['view_records', 'create_records', 'edit_records']),
  moduleAccess: new Set(['engineering']), active: true, ...over,
})
/** Manager: holds approve_requests in Engineering. */
const mgr = (over: Partial<Actor> = {}): Actor => ({
  id: approverId, roleKey: 'manager',
  permissions: new Set(['view_records', 'create_records', 'edit_records', 'approve_requests']),
  moduleAccess: new Set(['engineering']), active: true, ...over,
})

const track = <T extends { approvalId: string }>(r: T): T => {
  createdApprovalIds.push(r.approvalId)
  return r
}

const ecoRow = async (id: string) => (await db.query<{
  status: string; version: number; title: string; effectivity_serial: string | null
}>(`SELECT status, version, title, effectivity_serial FROM eco WHERE id=$1`, [id])).rows[0]

/**
 * Creates an ECO, optionally lists affected items on it, and drives it to
 * `submitted` — the state the gated edge leaves. Items are added BEFORE the
 * submit so they are part of what a request captures.
 */
async function submittedEco(
  over: Record<string, unknown> = {},
  items: { variantId: string; componentTypeId: string; quantity?: number }[] = [],
) {
  const eco = await createEco(eng(), {
    title: `Regulator change ${runTag}`,
    description: 'Thermal margin too small on rev C.',
    effectivitySerial: 'EE-02A-2603-0001 to 0015',
    effectivityDate: '2026-09-01',
    ...over,
  })
  createdEcoIds.push(eco.id)
  for (const item of items) {
    await addAffectedItem(eng(), {
      ecoId: eco.id, variantId: item.variantId, componentTypeId: item.componentTypeId,
      disposition: 'change', quantity: item.quantity ?? 1,
    })
  }
  const v0 = (await ecoRow(eco.id)).version
  const { version } = await changeEcoStatus(eng(), {
    id: eco.id, toStatus: 'submitted', version: v0 })
  return { id: eco.id, ecoNo: eco.ecoNo, version }
}

/** The snapshot an approval actually stored, straight from the column. */
const snapshotOf = async (approvalId: string) => (await db.query<{
  snapshot: Record<string, unknown>
}>(`SELECT snapshot FROM approval WHERE id=$1`, [approvalId])).rows[0].snapshot

/** Live affected-item rows for an ECO, in the projection's own order. */
const itemRowsOf = async (ecoId: string) => (await db.query<{
  variant_id: string; component_type_id: string; disposition: string
}>(`SELECT variant_id, component_type_id, disposition FROM ec_affected_item
     WHERE eco_id=$1 AND deleted_at IS NULL ORDER BY id`, [ecoId])).rows

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  engineerId = await makeUser('eco-approval-engineer@test.local', 'Elena Engineer', 'operator')
  approverId = await makeUser('eco-approval-manager@test.local', 'Manny Manager', 'manager')

  const variant = async (suffix: string) => (await db.query<{ id: string }>(
    `INSERT INTO device_variant (code, name, active) VALUES ($1,$2,true) RETURNING id`,
    [`ecoappr-${suffix}-${runTag}`, `ECO Approval ${suffix} ${runTag}`])).rows[0].id
  const compType = async (suffix: string) => (await db.query<{ id: string }>(
    `INSERT INTO component_type (code, name, tracking_mode, created_by)
     VALUES ($1,$2,'serialized',$3) RETURNING id`,
    [`ea-${suffix}-${runTag}`, `EA Type ${suffix} ${runTag}`, engineerId])).rows[0].id

  variantA = await variant('a')
  variantB = await variant('b')
  typeA = await compType('a')
  typeB = await compType('b')

  // A starting BOM on variant A only — unbounded on both axes, the state every
  // pre-effectivity line is in. Variant B deliberately has none, which is what
  // makes "an item added after approval names a variant the approval never saw"
  // a rewrite of a BOM nobody reviewed.
  await db.query(
    `INSERT INTO variant_bom_line (variant_id, component_type_id, quantity, created_by, updated_by)
     VALUES ($1,$2,1,$3,$3)`, [variantA, typeA, engineerId])
})

afterAll(async () => {
  // Rows first, then their audit trail — fn_audit is attached to DELETE too, so
  // clearing audit_log first leaves the delete's own row behind and it surfaces as
  // a phantom entry on the next run against a reused container.
  if (createdEcoIds.length) {
    const { rows: taskIds } = await db.query<{ task_id: string }>(
      `SELECT DISTINCT task_id FROM task_link WHERE entity_id = ANY($1)`, [createdEcoIds])
    const ids = taskIds.map((r) => r.task_id)
    if (ids.length) {
      await db.query(`DELETE FROM task_link WHERE task_id = ANY($1)`, [ids])
      await db.query(`DELETE FROM task WHERE id = ANY($1)`, [ids])
      await db.query(`DELETE FROM audit_log WHERE table_name IN ('task','task_link')
                        AND row_id = ANY($1)`, [ids])
    }
  }
  if (createdApprovalIds.length) {
    const { rows: outboxIds } = await db.query<{ id: string }>(
      `SELECT id FROM outbox WHERE aggregate_id = ANY($1)`, [createdApprovalIds])
    await db.query(`DELETE FROM outbox WHERE aggregate_id = ANY($1)`, [createdApprovalIds])
    await db.query(`DELETE FROM audit_log WHERE table_name='outbox' AND row_id = ANY($1)`,
      [outboxIds.map((r) => r.id)])
    await db.query(`DELETE FROM approval WHERE id = ANY($1)`, [createdApprovalIds])
    await db.query(`DELETE FROM audit_log WHERE table_name='approval' AND row_id = ANY($1)`,
      [createdApprovalIds])
  }
  // BOM LINES BEFORE THE ECOs THAT OPENED THEM, not merely before their variants:
  // an apply stamps variant_bom_line.created_by_eco_id / superseded_by_eco_id, so
  // every line this file opened is a foreign key INTO `eco`. Deleting the ECOs
  // first fails on variant_bom_line_created_by_eco_id_fkey and takes the whole
  // afterAll with it, leaving every row below un-cleaned.
  await db.query(`DELETE FROM variant_bom_line WHERE variant_id = ANY($1)`, [[variantA, variantB]])
  if (createdEcoIds.length) {
    const { rows: itemIds } = await db.query<{ id: string }>(
      `SELECT id FROM ec_affected_item WHERE eco_id = ANY($1)`, [createdEcoIds])
    await db.query(`DELETE FROM ec_affected_item WHERE eco_id = ANY($1)`, [createdEcoIds])
    await db.query(`DELETE FROM audit_log WHERE table_name='ec_affected_item'
                      AND row_id = ANY($1)`, [itemIds.map((r) => r.id)])
    await db.query(`DELETE FROM eco WHERE id = ANY($1)`, [createdEcoIds])
    await db.query(`DELETE FROM audit_log WHERE table_name='eco' AND row_id = ANY($1)`,
      [createdEcoIds])
  }
  await db.query(`DELETE FROM component_type WHERE id = ANY($1)`, [[typeA, typeB]])
  await db.query(`DELETE FROM device_variant WHERE id = ANY($1)`, [[variantA, variantB]])
  await db.end()
  await getPool().end()
})

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE REGRESSION GUARD: what worked before the migration still works.
// ═══════════════════════════════════════════════════════════════════════════
describe('ECO approval — pre-existing behaviour is unchanged', () => {
  it('still refuses submitted → approved without approve_requests', async () => {
    const eco = await submittedEco()
    await expect(changeEcoStatus(eng(), {
      id: eco.id, toStatus: 'approved', version: eco.version })).rejects.toThrow(PermissionError)
    expect((await ecoRow(eco.id)).status).toBe('submitted')
  })

  it('still approves an ECO nobody raised a request for', async () => {
    // The migration's central promise: no new precondition. An ECO with no
    // approval record is governed by approve_requests exactly as it always was.
    const eco = await submittedEco()
    const approved = await changeEcoStatus(mgr(), {
      id: eco.id, toStatus: 'approved', version: eco.version })
    expect(approved.status).toBe('approved')
    expect((await ecoRow(eco.id)).status).toBe('approved')
  })

  it('still lets an un-gated move run with only edit_records', async () => {
    const eco = await submittedEco()
    const approved = await changeEcoStatus(mgr(), {
      id: eco.id, toStatus: 'approved', version: eco.version })
    const impl = await changeEcoStatus(eng(), {
      id: eco.id, toStatus: 'implemented', version: approved.version })
    expect(impl.status).toBe('implemented')
  })

  it('still refuses an illegal transition, and says so rather than blaming an approval', async () => {
    const eco = await submittedEco()
    const err = await changeEcoStatus(mgr(), {
      id: eco.id, toStatus: 'implemented', version: eco.version }).catch((e) => e)
    expect(err.name).toBe('InvalidTransitionError')
  })

  it('still refuses a stale version', async () => {
    const eco = await submittedEco()
    await expect(changeEcoStatus(mgr(), {
      id: eco.id, toStatus: 'approved', version: eco.version + 99 }))
      .rejects.toThrow(OptimisticLockError)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. Requesting.
// ═══════════════════════════════════════════════════════════════════════════
describe('requestEcoApproval', () => {
  it('records a snapshot of the CHANGE, not merely the id', async () => {
    const eco = await submittedEco()
    const { approvalId } = track(await requestEcoApproval(eng(), {
      ecoId: eco.id, version: eco.version }))

    const { rows } = await db.query<{
      status: string; kind: string; module: string; entity_type: string
      snapshot: Record<string, unknown>; requested_by: string
    }>(`SELECT status, kind, module, entity_type, snapshot, requested_by FROM approval
         WHERE id=$1`, [approvalId])
    expect(rows[0]).toMatchObject({
      status: 'pending', kind: 'eco', module: 'engineering', entity_type: 'eco',
      requested_by: engineerId,
    })
    // Every value an approver weighs — "a snapshot of only the id authorises nothing".
    expect(rows[0].snapshot).toMatchObject({
      ecoNo: eco.ecoNo,
      title: `Regulator change ${runTag}`,
      effectivitySerial: 'EE-02A-2603-0001 to 0015',
      effectivityDate: '2026-09-01',
    })
  })

  it('emits the outbox event in the SAME transaction as the request', async () => {
    const eco = await submittedEco()
    const { approvalId } = track(await requestEcoApproval(eng(), {
      ecoId: eco.id, version: eco.version }))
    const { rows } = await db.query<{ event_type: string; payload: Record<string, unknown> }>(
      `SELECT event_type, payload FROM outbox WHERE aggregate_id=$1`, [approvalId])
    expect(rows).toHaveLength(1)
    expect(rows[0].event_type).toBe('approval_requested')
    expect(rows[0].payload).toMatchObject({ kind: 'eco', module: 'engineering' })
  })

  it('refuses a request for an ECO that is not submitted', async () => {
    const draft = await createEco(eng(), { title: `Draft ${runTag}` })
    createdEcoIds.push(draft.id)
    const { version } = await ecoRow(draft.id)
    await expect(requestEcoApproval(eng(), { ecoId: draft.id, version }))
      .rejects.toThrow(EcoApprovalRequestError)
  })

  it('refuses a request raised from a stale screen', async () => {
    const eco = await submittedEco()
    await expect(requestEcoApproval(eng(), { ecoId: eco.id, version: eco.version + 99 }))
      .rejects.toThrow(OptimisticLockError)
  })

  it('refuses a request for an ECO that does not exist', async () => {
    const { rows } = await db.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)
    await expect(requestEcoApproval(eng(), { ecoId: rows[0].id, version: 1 }))
      .rejects.toThrow(EcoNotFoundError)
  })

  it('refuses a requester without edit_records in engineering', async () => {
    const eco = await submittedEco()
    const viewer = eng({ permissions: new Set(['view_records']) })
    await expect(requestEcoApproval(viewer, { ecoId: eco.id, version: eco.version }))
      .rejects.toThrow(PermissionError)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. The gate: a request, once raised, BINDS.
// ═══════════════════════════════════════════════════════════════════════════
describe('the ECO approval gate', () => {
  it('blocks approval while the request is still pending', async () => {
    const eco = await submittedEco()
    track(await requestEcoApproval(eng(), { ecoId: eco.id, version: eco.version }))

    const err = await changeEcoStatus(mgr(), {
      id: eco.id, toStatus: 'approved', version: eco.version }).catch((e) => e)
    expect(err).toBeInstanceOf(EcoApprovalError)
    expect(err.code).toBe('approval_pending')
    expect((await ecoRow(eco.id)).status).toBe('submitted')
  })

  it('blocks approval when the request was rejected, and repeats the note', async () => {
    const eco = await submittedEco()
    const { approvalId } = track(await requestEcoApproval(eng(), {
      ecoId: eco.id, version: eco.version }))
    await decideApproval(mgr(), {
      approvalId, decision: 'rejected', note: 'Effectivity range is too wide' })

    const err = await changeEcoStatus(mgr(), {
      id: eco.id, toStatus: 'approved', version: eco.version }).catch((e) => e)
    expect(err.code).toBe('approval_rejected')
    expect(err.message).toContain('Effectivity range is too wide')
    expect((await ecoRow(eco.id)).status).toBe('submitted')
  })

  it('permits approval once the request is approved and nothing moved', async () => {
    const eco = await submittedEco()
    const { approvalId } = track(await requestEcoApproval(eng(), {
      ecoId: eco.id, version: eco.version }))
    await decideApproval(mgr(), { approvalId, decision: 'approved' })

    const res = await changeEcoStatus(mgr(), {
      id: eco.id, toStatus: 'approved', version: eco.version })
    expect(res.status).toBe('approved')
  })

  /**
   * THE TEST THIS SLICE EXISTS FOR. Without it the engine is theatre: approve a
   * narrow change, widen it, apply it against an approval nobody granted.
   */
  it('REFUSES approval after the ECO was edited, naming the field and both values',
    async () => {
      const eco = await submittedEco()
      const { approvalId } = track(await requestEcoApproval(eng(), {
        ecoId: eco.id, version: eco.version }))
      await decideApproval(mgr(), { approvalId, decision: 'approved' })

      // Widen the effectivity range — in today's schema, adding affected items.
      const { version: bumped } = await updateEco(eng(), {
        id: eco.id, version: eco.version, effectivitySerial: 'EE-02A-2603-0001 to 0090' })
      expect((await ecoRow(eco.id)).effectivity_serial).toBe('EE-02A-2603-0001 to 0090')

      const err = await changeEcoStatus(mgr(), {
        id: eco.id, toStatus: 'approved', version: bumped }).catch((e) => e)
      expect(err).toBeInstanceOf(EcoApprovalError)
      expect(err.code).toBe('approval_drifted')
      // Named field, and BOTH values: "this ECO changed" is a dead end.
      expect(err.message).toContain('effectivitySerial')
      expect(err.message).toContain('0015')
      expect(err.message).toContain('0090')

      // and nothing moved
      expect((await ecoRow(eco.id)).status).toBe('submitted')
    })

  it('refuses when the TITLE was rewritten after approval', async () => {
    const eco = await submittedEco()
    const { approvalId } = track(await requestEcoApproval(eng(), {
      ecoId: eco.id, version: eco.version }))
    await decideApproval(mgr(), { approvalId, decision: 'approved' })

    const { version: bumped } = await updateEco(eng(), {
      id: eco.id, version: eco.version, title: `Something else entirely ${runTag}` })
    const err = await changeEcoStatus(mgr(), {
      id: eco.id, toStatus: 'approved', version: bumped }).catch((e) => e)
    expect(err.code).toBe('approval_drifted')
    expect(err.message).toContain('title')
  })

  it('approves once the drift is PUT BACK — the check is on the state, not on the edit',
    async () => {
      // Mirrors the Finance gate's behaviour deliberately: the snapshot carries
      // content, not the optimistic-lock counter, so a mistaken edit and its
      // correction leave an approval that still describes the ECO exactly.
      const eco = await submittedEco()
      const { approvalId } = track(await requestEcoApproval(eng(), {
        ecoId: eco.id, version: eco.version }))
      await decideApproval(mgr(), { approvalId, decision: 'approved' })

      const v2 = (await updateEco(eng(), {
        id: eco.id, version: eco.version, effectivityNotes: 'temporarily changed' })).version
      await expect(changeEcoStatus(mgr(), { id: eco.id, toStatus: 'approved', version: v2 }))
        .rejects.toMatchObject({ code: 'approval_drifted' })

      // submittedEco leaves effectivityNotes unset, so NULL is the approved state.
      const v3 = (await updateEco(eng(), {
        id: eco.id, version: v2, effectivityNotes: null })).version
      const res = await changeEcoStatus(mgr(), {
        id: eco.id, toStatus: 'approved', version: v3 })
      expect(res.status).toBe('approved')
    })

  /**
   * BOTH GATES HOLD. The engine is not a replacement for the permission: an
   * actor with a perfectly good approval in hand still may not approve.
   */
  it('still demands approve_requests even with an approved, non-drifted approval', async () => {
    const eco = await submittedEco()
    const { approvalId } = track(await requestEcoApproval(eng(), {
      ecoId: eco.id, version: eco.version }))
    await decideApproval(mgr(), { approvalId, decision: 'approved' })

    await expect(changeEcoStatus(eng(), {
      id: eco.id, toStatus: 'approved', version: eco.version })).rejects.toThrow(PermissionError)
    expect((await ecoRow(eco.id)).status).toBe('submitted')
  })

  /**
   * `approved → implemented` carries no approval requirement and still does not.
   *
   * THIS TEST USED TO ENCODE THE BUG. Its original body edited the ECO's
   * effectivity notes AFTER the approval had been acted on and asserted that
   * `implemented` succeeded — which was true, and was precisely the hole: the last
   * re-check happened at `approved`, so every edit after it rode free. What was
   * legitimately being claimed is that the edge itself is un-gated, and that claim
   * is tested here on an ECO with NO approval request, where it is the whole of
   * the "requested ⇒ binding" posture. The edit-after-approval half moved to the
   * scope-lock block below, where it is now a REFUSAL.
   */
  it('does not gate the un-gated edges on an ECO nobody raised a request for', async () => {
    const eco = await submittedEco()
    const approved = await changeEcoStatus(mgr(), {
      id: eco.id, toStatus: 'approved', version: eco.version })

    // No approval exists, so editing an approved ECO is unchanged behaviour...
    const { version: edited } = await updateEco(eng(), {
      id: eco.id, version: approved.version, effectivityNotes: 'changed after approval' })
    // ...and so is implementing it.
    const impl = await changeEcoStatus(eng(), {
      id: eco.id, toStatus: 'implemented', version: edited })
    expect(impl.status).toBe('implemented')
  })

  it('leaves approved → implemented un-gated even WITH an approval, when nothing moved',
    async () => {
      // The edge is not where the check belongs — the apply is. An untouched ECO
      // walks to `implemented` exactly as it always did.
      const eco = await submittedEco({}, [{ variantId: variantA, componentTypeId: typeA }])
      const { approvalId } = track(await requestEcoApproval(eng(), {
        ecoId: eco.id, version: eco.version }))
      await decideApproval(mgr(), { approvalId, decision: 'approved' })
      const approved = await changeEcoStatus(mgr(), {
        id: eco.id, toStatus: 'approved', version: eco.version })
      const impl = await changeEcoStatus(eng(), {
        id: eco.id, toStatus: 'implemented', version: approved.version })
      expect(impl.status).toBe('implemented')
    })

  it('nobody decides their own request, even holding approve_requests', async () => {
    const eco = await submittedEco()
    // The manager REQUESTS this one themselves.
    const { approvalId } = track(await requestEcoApproval(mgr(), {
      ecoId: eco.id, version: eco.version }))
    await expect(decideApproval(mgr(), { approvalId, decision: 'approved' }))
      .rejects.toMatchObject({ name: 'ApprovalDecisionError', code: 'self_approval' })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3b. THE AFFECTED ITEMS — the scope `effectivity_serial` never covered.
// ═══════════════════════════════════════════════════════════════════════════
describe('the ECO approval snapshot covers ec_affected_item', () => {
  it('stores the affected items with the request, by identity', async () => {
    const eco = await submittedEco({}, [
      { variantId: variantA, componentTypeId: typeA, quantity: 2 },
    ])
    const { approvalId } = track(await requestEcoApproval(eng(), {
      ecoId: eco.id, version: eco.version }))

    const snapshot = await snapshotOf(approvalId)
    expect(snapshot.affectedItems).toEqual([{
      variantId: variantA, componentTypeId: typeA,
      disposition: 'change', quantity: 2, notes: null,
    }])
  })

  it('stores an empty array for an ECO that affects no BOM, not a missing key', async () => {
    // `null` and absent are different events to describeSnapshotDrift, and an ECO
    // that later GAINS its first item must read as drift rather than as agreement.
    const eco = await submittedEco()
    const { approvalId } = track(await requestEcoApproval(eng(), {
      ecoId: eco.id, version: eco.version }))
    expect(await snapshotOf(approvalId)).toMatchObject({ affectedItems: [] })
  })

  /**
   * ORDERED BY AN IMMUTABLE KEY. The display query (`listAffectedItems`) orders by
   * `v.name, ct.sort, ct.name`; array order is significant to `snapshotsAgree`, so
   * reusing it would make RENAMING A VARIANT report drift on an ECO nobody touched.
   * Renaming both variants here must leave the approval agreeing exactly.
   */
  it('does not drift when a variant is RENAMED — the projection carries ids', async () => {
    const eco = await submittedEco({}, [
      { variantId: variantA, componentTypeId: typeA },
      { variantId: variantB, componentTypeId: typeB },
    ])
    const { approvalId } = track(await requestEcoApproval(eng(), {
      ecoId: eco.id, version: eco.version }))
    await decideApproval(mgr(), { approvalId, decision: 'approved' })

    // Swap the names so any name-ordered projection re-orders the array, and any
    // name-carrying projection changes its content.
    await db.query(`UPDATE device_variant SET name = $2 WHERE id = $1`,
      [variantA, `zzz-renamed-a-${runTag}`])
    await db.query(`UPDATE device_variant SET name = $2 WHERE id = $1`,
      [variantB, `aaa-renamed-b-${runTag}`])

    expect((await getEcoApprovalState(eng(), eco.id))!.drift).toEqual([])
    const res = await changeEcoStatus(mgr(), {
      id: eco.id, toStatus: 'approved', version: eco.version })
    expect(res.status).toBe('approved')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3c. THE SCOPE LOCK — the edit is refused at the moment of the mistake.
// ═══════════════════════════════════════════════════════════════════════════
describe('an acted-on approval freezes what the ECO changes', () => {
  /** Requests, approves, and crosses the gated edge. Returns the approved ECO. */
  async function approvedEco(items = [{ variantId: variantA, componentTypeId: typeA }]) {
    const eco = await submittedEco({}, items)
    const { approvalId } = track(await requestEcoApproval(eng(), {
      ecoId: eco.id, version: eco.version }))
    await decideApproval(mgr(), { approvalId, decision: 'approved' })
    const approved = await changeEcoStatus(mgr(), {
      id: eco.id, toStatus: 'approved', version: eco.version })
    return { ...eco, version: approved.version }
  }

  it('refuses ADDING an affected item once the approval has been acted on', async () => {
    const eco = await approvedEco()
    await expect(addAffectedItem(eng(), {
      ecoId: eco.id, variantId: variantB, componentTypeId: typeB,
      disposition: 'change', quantity: 1,
    })).rejects.toThrow(EcoScopeLockedError)
    expect(await itemRowsOf(eco.id)).toHaveLength(1)
  })

  it('refuses REMOVING one too — narrowing is a change of scope as much as widening',
    async () => {
      const eco = await approvedEco()
      const [item] = await db.query<{ id: string; version: number }>(
        `SELECT id, version FROM ec_affected_item WHERE eco_id=$1 AND deleted_at IS NULL`,
        [eco.id]).then((r) => r.rows)
      await expect(removeAffectedItem(eng(), { id: item.id, version: item.version }))
        .rejects.toThrow(EcoScopeLockedError)
      expect(await itemRowsOf(eco.id)).toHaveLength(1)
    })

  /**
   * `updateEco` had NO status guard at all, and `applyEcoEffectivityTx` reads
   * `effectivity_serial` LIVE at apply time — so approving at "0001 to 0015",
   * editing to "0001 to 0900" while approved and applying landed the BOM rewrite
   * on the wider range.
   */
  it('refuses WIDENING the effectivity range on an approved ECO', async () => {
    const eco = await approvedEco()
    await expect(updateEco(eng(), {
      id: eco.id, version: eco.version, effectivitySerial: 'EE-02A-2603-0001 to 0900',
    })).rejects.toThrow(EcoScopeLockedError)
    expect((await ecoRow(eco.id)).effectivity_serial).toBe('EE-02A-2603-0001 to 0015')
  })

  it('still allows every one of those on an ECO with NO approval request', async () => {
    // The regression guard for the new refusal: "requested ⇒ binding" means an ECO
    // nobody asked for a second pair of eyes on is untouched, in every status.
    const eco = await submittedEco({}, [{ variantId: variantA, componentTypeId: typeA }])
    const approved = await changeEcoStatus(mgr(), {
      id: eco.id, toStatus: 'approved', version: eco.version })

    const added = await addAffectedItem(eng(), {
      ecoId: eco.id, variantId: variantB, componentTypeId: typeB,
      disposition: 'change', quantity: 1 })
    expect(added.id).toBeTruthy()
    const { rows: [row] } = await db.query<{ version: number }>(
      `SELECT version FROM ec_affected_item WHERE id=$1`, [added.id])
    await removeAffectedItem(eng(), { id: added.id, version: row.version })
    const edited = await updateEco(eng(), {
      id: eco.id, version: approved.version, effectivitySerial: 'EE-02A-2603-0001 to 0900' })
    expect(edited.version).toBeGreaterThan(approved.version)
  })

  it('still allows them while the ECO is SUBMITTED, so drift stays re-checkable', async () => {
    // Editing under a live approval is how the put-it-back behaviour works. The
    // lock must not start until the gated edge has actually been crossed.
    const eco = await submittedEco({}, [{ variantId: variantA, componentTypeId: typeA }])
    const { approvalId } = track(await requestEcoApproval(eng(), {
      ecoId: eco.id, version: eco.version }))
    await decideApproval(mgr(), { approvalId, decision: 'approved' })

    const added = await addAffectedItem(eng(), {
      ecoId: eco.id, variantId: variantB, componentTypeId: typeB,
      disposition: 'change', quantity: 1 })
    // …and the ADDED ITEM is what the gate now refuses at the edge.
    const err = await changeEcoStatus(mgr(), {
      id: eco.id, toStatus: 'approved', version: eco.version }).catch((e) => e)
    expect(err).toBeInstanceOf(EcoApprovalError)
    expect(err.code).toBe('approval_drifted')
    expect(err.message).toContain('affectedItems')
    expect(err.message).toContain(variantB)

    // Put it back, and the same approval describes the ECO again.
    const { rows: [row] } = await db.query<{ version: number }>(
      `SELECT version FROM ec_affected_item WHERE id=$1`, [added.id])
    await removeAffectedItem(eng(), { id: added.id, version: row.version })
    expect((await changeEcoStatus(mgr(), {
      id: eco.id, toStatus: 'approved', version: eco.version })).status).toBe('approved')
  })

  it('reports the freeze on the read path so a screen can stop offering the edit', async () => {
    const eco = await approvedEco()
    const state = await getEcoApprovalState(eng(), eco.id)
    expect(state!.scopeLocked).toBe(true)
    expect(state!.scopeLockedReason).toMatch(/approval/i)

    const open = await submittedEco({}, [{ variantId: variantA, componentTypeId: typeA }])
    const openState = await getEcoApprovalState(eng(), open.id)
    expect(openState!.scopeLocked).toBe(false)
    expect(openState!.scopeLockedReason).toBeNull()
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3d. THE APPLY GATE — the check on the act that rewrites the BOM.
// ═══════════════════════════════════════════════════════════════════════════
describe('applying an ECO re-checks its approval', () => {
  it('applies normally when the approval still describes the ECO', async () => {
    const eco = await submittedEco({ effectivityDate: '2026-09-01' },
      [{ variantId: variantA, componentTypeId: typeA, quantity: 3 }])
    const { approvalId } = track(await requestEcoApproval(eng(), {
      ecoId: eco.id, version: eco.version }))
    await decideApproval(mgr(), { approvalId, decision: 'approved' })
    const approved = await changeEcoStatus(mgr(), {
      id: eco.id, toStatus: 'approved', version: eco.version })
    await changeEcoStatus(eng(), {
      id: eco.id, toStatus: 'implemented', version: approved.version })

    const result = await applyEcoEffectivity(eng(), { ecoId: eco.id })
    expect(result).toMatchObject({ itemsApplied: 1, alreadyApplied: false })
  })

  /**
   * ═══ THE REVIEWER'S SCENARIO, END TO END ═══════════════════════════════════
   *
   * BEFORE: create an ECO with 1 affected item → submit → request → approve →
   * changeEcoStatus to `approved` (the snapshot agreed, so it passed) → ADD FOUR
   * MORE ITEMS ACROSS ANOTHER VARIANT → `implemented` (never gated) → apply. An
   * approval for a one-line change implemented a five-line change, and the drift
   * re-check never fired once.
   *
   * AFTER: the service refuses the additions outright. This test then FORCES them
   * in with direct SQL — standing in for any write path that does not go through
   * `addAffectedItem`, which is exactly why the second gate exists — and the apply
   * refuses, naming `affectedItems` and the variant that appeared. Not one BOM row
   * is written.
   */
  it('REFUSES the apply when items were added after approval, and writes no BOM row',
    async () => {
      const eco = await submittedEco({ effectivityDate: '2026-09-01' },
        [{ variantId: variantA, componentTypeId: typeA }])
      const { approvalId } = track(await requestEcoApproval(eng(), {
        ecoId: eco.id, version: eco.version }))
      await decideApproval(mgr(), { approvalId, decision: 'approved' })
      const approved = await changeEcoStatus(mgr(), {
        id: eco.id, toStatus: 'approved', version: eco.version })

      // Gate 1 — the edit is refused at the moment of the mistake.
      await expect(addAffectedItem(eng(), {
        ecoId: eco.id, variantId: variantB, componentTypeId: typeB,
        disposition: 'change', quantity: 1,
      })).rejects.toThrow(EcoScopeLockedError)

      // Force it in behind the service's back — a bulk editor, an import, a
      // migration, a psql session. Gate 2 must not care how the row arrived.
      await db.query(
        `INSERT INTO ec_affected_item
           (eco_id, variant_id, component_type_id, disposition, quantity, created_by, updated_by)
         VALUES ($1,$2,$3,'change',1,$4,$4)`, [eco.id, variantB, typeB, engineerId])
      expect(await itemRowsOf(eco.id)).toHaveLength(2)

      await changeEcoStatus(eng(), {
        id: eco.id, toStatus: 'implemented', version: approved.version })

      // Gate 2 — the act itself.
      const err = await applyEcoEffectivity(eng(), { ecoId: eco.id }).catch((e) => e)
      expect(err).toBeInstanceOf(EcoApprovalError)
      expect(err.code).toBe('approval_drifted')
      expect(err.message).toContain('affectedItems')
      expect(err.message).toContain(variantB)

      // Nothing was half-written: no line opened on either variant, no item stamped.
      const { rows: opened } = await db.query(
        `SELECT 1 FROM variant_bom_line WHERE created_by_eco_id = $1`, [eco.id])
      expect(opened).toHaveLength(0)
      const { rows: closed } = await db.query(
        `SELECT 1 FROM variant_bom_line WHERE superseded_by_eco_id = $1`, [eco.id])
      expect(closed).toHaveLength(0)
      const { rows: stamped } = await db.query(
        `SELECT 1 FROM ec_affected_item WHERE eco_id = $1 AND applied_at IS NOT NULL`, [eco.id])
      expect(stamped).toHaveLength(0)
    })

  it('REFUSES the apply when the effectivity range was widened after approval', async () => {
    // The apply reads effectivity LIVE, so this is the drift that would otherwise
    // rewrite the BOM for 900 devices on an approval granted for 15.
    const eco = await submittedEco({ effectivityDate: '2026-09-01' },
      [{ variantId: variantA, componentTypeId: typeA }])
    const { approvalId } = track(await requestEcoApproval(eng(), {
      ecoId: eco.id, version: eco.version }))
    await decideApproval(mgr(), { approvalId, decision: 'approved' })
    const approved = await changeEcoStatus(mgr(), {
      id: eco.id, toStatus: 'approved', version: eco.version })
    await changeEcoStatus(eng(), {
      id: eco.id, toStatus: 'implemented', version: approved.version })

    await db.query(
      `UPDATE eco SET effectivity_serial = $2 WHERE id = $1`,
      [eco.id, 'EE-02A-2603-0001 to 0900'])

    const err = await applyEcoEffectivity(eng(), { ecoId: eco.id }).catch((e) => e)
    expect(err).toBeInstanceOf(EcoApprovalError)
    expect(err.message).toContain('effectivitySerial')
    expect(err.message).toContain('0900')
  })

  it('applies an ECO nobody raised a request for, exactly as before', async () => {
    // The apply gate is "requested ⇒ binding" too: no request, no new refusal.
    const eco = await submittedEco({ effectivityDate: '2026-10-01' },
      [{ variantId: variantB, componentTypeId: typeB, quantity: 1 }])
    const approved = await changeEcoStatus(mgr(), {
      id: eco.id, toStatus: 'approved', version: eco.version })
    await changeEcoStatus(eng(), {
      id: eco.id, toStatus: 'implemented', version: approved.version })
    // An `add` is the right disposition for variant B, which carries no open line.
    await db.query(
      `UPDATE ec_affected_item SET disposition='add' WHERE eco_id=$1`, [eco.id])

    const result = await applyEcoEffectivity(eng(), { ecoId: eco.id })
    expect(result).toMatchObject({ itemsApplied: 1, linesOpened: 1, alreadyApplied: false })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. Reading, and the queued task.
// ═══════════════════════════════════════════════════════════════════════════
describe('getEcoApprovalState', () => {
  it('reports a submitted ECO as requestable with no approval yet', async () => {
    const eco = await submittedEco()
    const state = await getEcoApprovalState(eng(), eco.id)
    expect(state).toMatchObject({ requestable: true, requestableReason: null, approval: null })
    expect(state!.drift).toEqual([])
  })

  it('reports a draft ECO as not requestable, and says why', async () => {
    const draft = await createEco(eng(), { title: `Draft state ${runTag}` })
    createdEcoIds.push(draft.id)
    const state = await getEcoApprovalState(eng(), draft.id)
    expect(state!.requestable).toBe(false)
    expect(state!.requestableReason).toContain('submitted')
  })

  it('surfaces drift BEFORE anyone clicks approve', async () => {
    // A refusal discovered at the click is a worse experience than a warning on
    // the page, and the page is where the requester can act on it.
    const eco = await submittedEco()
    const { approvalId } = track(await requestEcoApproval(eng(), {
      ecoId: eco.id, version: eco.version }))
    await decideApproval(mgr(), { approvalId, decision: 'approved' })
    await updateEco(eng(), {
      id: eco.id, version: eco.version, title: `Drifted ${runTag}` })

    const state = await getEcoApprovalState(eng(), eco.id)
    expect(state!.drift.join('; ')).toContain('title')
  })

  it('returns null for an unknown id rather than throwing', async () => {
    const { rows } = await db.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)
    expect(await getEcoApprovalState(eng(), rows[0].id)).toBeNull()
    expect(await getEcoApprovalState(eng(), 'not-a-uuid')).toBeNull()
  })
})

describe('the queued ECO approval task', () => {
  it('drains into a real task now that the eco kind is registered', async () => {
    // Before the migration this kind was unregistered on purpose and its events
    // accumulated as parked outbox rows. Registering it is what turns the request
    // into something that reaches an approver's queue.
    const eco = await submittedEco()
    track(await requestEcoApproval(eng(), { ecoId: eco.id, version: eco.version }))
    await drainOutbox()

    const { rows } = await db.query<{
      title: string; description: string; department: string | null; priority: string
    }>(
      `SELECT t.title, t.description, t.department, t.priority
         FROM task t JOIN task_link l ON l.task_id = t.id
        WHERE l.entity_id = $1`, [eco.id])
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toContain(eco.ecoNo)
    expect(rows[0].department).toBe('Engineering')
    expect(rows[0].priority).toBe('high')
    expect(rows[0].description.toLowerCase()).toContain('effectivity')
  })

  it('marks the event processed exactly once', async () => {
    const eco = await submittedEco()
    const { approvalId } = track(await requestEcoApproval(eng(), {
      ecoId: eco.id, version: eco.version }))
    await drainOutbox()
    await drainOutbox()

    const { rows } = await db.query<{ processed_at: Date | null; attempts: number }>(
      `SELECT processed_at, attempts FROM outbox WHERE aggregate_id=$1`, [approvalId])
    expect(rows[0].processed_at).not.toBeNull()
    const tasks = await db.query(
      `SELECT 1 FROM task_link WHERE entity_id = $1`, [eco.id])
    expect(tasks.rows).toHaveLength(1)
  })
})
