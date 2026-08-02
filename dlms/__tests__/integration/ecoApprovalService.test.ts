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
  requestEcoApproval, getEcoApprovalState,
  EcoApprovalError, EcoApprovalRequestError, EcoNotFoundError,
} from '@/modules/engineering/services/ecoService'
import { decideApproval } from '@/modules/shared/approvals/services/approvalService'
import { drainOutbox } from '@/modules/shared/outbox/services/outboxService'

// actor.ts (reached through the outbox drain) imports the Supabase server client
// for the HUMAN login path; nothing under test goes near it.
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client
let engineerId: string
let approverId: string

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

/** Creates an ECO and drives it to `submitted`, the state the gated edge leaves. */
async function submittedEco(over: Record<string, unknown> = {}) {
  const eco = await createEco(eng(), {
    title: `Regulator change ${runTag}`,
    description: 'Thermal margin too small on rev C.',
    effectivitySerial: 'EE-02A-2603-0001 to 0015',
    effectivityDate: '2026-09-01',
    ...over,
  })
  createdEcoIds.push(eco.id)
  const v0 = (await ecoRow(eco.id)).version
  const { version } = await changeEcoStatus(eng(), {
    id: eco.id, toStatus: 'submitted', version: v0 })
  return { id: eco.id, ecoNo: eco.ecoNo, version }
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  engineerId = await makeUser('eco-approval-engineer@test.local', 'Elena Engineer', 'operator')
  approverId = await makeUser('eco-approval-manager@test.local', 'Manny Manager', 'manager')
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
  if (createdEcoIds.length) {
    await db.query(`DELETE FROM eco WHERE id = ANY($1)`, [createdEcoIds])
    await db.query(`DELETE FROM audit_log WHERE table_name='eco' AND row_id = ANY($1)`,
      [createdEcoIds])
  }
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

  it('does not gate the un-gated edges', async () => {
    // approved → implemented carries no approval requirement, so a stale or
    // drifted approval must not block it.
    const eco = await submittedEco()
    const { approvalId } = track(await requestEcoApproval(eng(), {
      ecoId: eco.id, version: eco.version }))
    await decideApproval(mgr(), { approvalId, decision: 'approved' })
    const approved = await changeEcoStatus(mgr(), {
      id: eco.id, toStatus: 'approved', version: eco.version })

    const { version: edited } = await updateEco(eng(), {
      id: eco.id, version: approved.version, effectivityNotes: 'changed after approval' })
    const impl = await changeEcoStatus(eng(), {
      id: eco.id, toStatus: 'implemented', version: edited })
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
