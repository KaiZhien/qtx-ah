// __tests__/integration/repairSignOffApproval.test.ts
//
// Maintenance's repair sign-off, migrated onto the shared approvals engine.
//
// Organised like ecoApprovalService.test.ts and for the same reason: the first
// block re-asserts the behaviour that shipped before this refactor — including
// the THREE-FACT precondition, which the engine must not dissolve — and only then
// exercises the engine's ceremony.
//
// The precondition's three facts are awaiting_sign_off, testing notes present,
// and (only when the repair CLAIMS parts were replaced) at least one
// component_installation referencing it, counted inside the sign-off transaction.
// It runs FIRST, ahead of the approval gate, so a repair that is not finishable
// says so rather than blaming an approval.
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { Client } from 'pg'
import { getPool } from '@/lib/db/pool'
import { PermissionError } from '@/modules/shared/authz/authorize'
import { OptimisticLockError } from '@/lib/db/tx'
import type { Actor } from '@/modules/shared/authz/catalog'
import {
  createRepair, updateRepair, changeRepairStatus, signOffRepair,
  requestRepairSignOffApproval, getRepairSignOffApprovalState,
  RepairSignOffApprovalError, RepairSignOffRequestError, RepairNotFoundError,
} from '@/modules/maintenance/services/repairService'
import { RepairSignOffError } from '@/modules/maintenance/domain/repairStatus'
import {
  installComponent, replaceComponentInstallation,
} from '@/modules/manufacturing/services/componentService'
import { decideApproval } from '@/modules/shared/approvals/services/approvalService'
import { drainOutbox } from '@/modules/shared/outbox/services/outboxService'

vi.mock('@/lib/supabase/server', () => ({ createAdminClient: () => ({}) }))

let db: Client
let techId: string
let approverId: string
let pcbaTypeId: string

const createdRepairIds: string[] = []
const createdDeviceIds: string[] = []
const createdInstallationIds: string[] = []
const createdUnitIds: string[] = []
const createdApprovalIds: string[] = []

const runTag = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`

const makeUser = async (email: string, name: string, roleKey: string) =>
  (await db.query<{ id: string }>(
    `INSERT INTO app_user (email, full_name, role_id, department, module_access, active)
     SELECT $1, $2, r.id, 'Maintenance',
            ARRAY['maintenance','manufacturing','tasks']::text[], true
       FROM role r WHERE r.key = $3
     ON CONFLICT (email) DO UPDATE SET full_name = EXCLUDED.full_name
     RETURNING id`, [email, name, roleKey])).rows[0].id

/** Technician: does the work, may request. Cannot sign off, cannot approve. */
const tech = (over: Partial<Actor> = {}): Actor => ({
  id: techId, roleKey: 'operator',
  permissions: new Set([
    'view_records', 'create_records', 'edit_records', 'change_device_status']),
  moduleAccess: new Set(['maintenance', 'manufacturing']), active: true, ...over,
})
/** Signer: holds sign_off_repairs (and approve_requests, so they can decide). */
const signer = (over: Partial<Actor> = {}): Actor => ({
  id: approverId, roleKey: 'manager',
  permissions: new Set([
    'view_records', 'create_records', 'edit_records', 'sign_off_repairs',
    'change_device_status', 'approve_requests']),
  moduleAccess: new Set(['maintenance', 'manufacturing']), active: true, ...over,
})

const track = <T extends { approvalId: string }>(r: T): T => {
  createdApprovalIds.push(r.approvalId)
  return r
}

const repairRow = async (id: string) => (await db.query<{
  status: string; version: number; signed_off_by: string | null; testing_notes: string | null
}>(`SELECT status, version, signed_off_by, testing_notes FROM repair WHERE id=$1`, [id])).rows[0]

const currentVersion = async (repairId: string) => (await repairRow(repairId)).version

async function makeDevice(status: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO device (variant_id, status, created_by, updated_by)
     VALUES ((SELECT id FROM device_variant WHERE code='pro'), $1, $2, $2)
     RETURNING id`, [status, techId])
  createdDeviceIds.push(rows[0].id)
  return rows[0].id
}

async function openRepair(moveDevice = false) {
  const deviceId = await makeDevice('active')
  const res = await createRepair(tech(), {
    deviceId, faultDescription: 'no power', moveDevice })
  createdRepairIds.push(res.repairId)
  return { deviceId, ...res }
}

/** Walks a repair to awaiting_sign_off, recording testing notes on the way. */
async function driveToAwaitingSignOff(repairId: string) {
  await changeRepairStatus(tech(), {
    repairId, toStatus: 'in_diagnosis', version: await currentVersion(repairId) })
  await changeRepairStatus(tech(), {
    repairId, toStatus: 'in_repair', version: await currentVersion(repairId) })
  await updateRepair(tech(), {
    repairId, version: await currentVersion(repairId),
    testingNotes: 'Burn-in 4 h at 45 C, no resets.', correctiveAction: 'Replaced PCBA-A.' })
  await changeRepairStatus(tech(), {
    repairId, toStatus: 'testing', version: await currentVersion(repairId) })
  await changeRepairStatus(tech(), {
    repairId, toStatus: 'awaiting_sign_off', version: await currentVersion(repairId) })
}

async function makeUnit(label: string): Promise<string> {
  const { rows } = await db.query<{ id: string }>(
    `INSERT INTO component_unit (component_type_id, serial_no, created_by, updated_by)
     VALUES ($1,$2,$3,$3) RETURNING id`, [pcbaTypeId, `SGN-${label}-${runTag}`, techId])
  createdUnitIds.push(rows[0].id)
  return rows[0].id
}

async function installPcba(deviceId: string, unitId: string): Promise<string> {
  const { installationId } = await installComponent(tech(), {
    deviceId, componentTypeId: pcbaTypeId, unitId })
  createdInstallationIds.push(installationId)
  return installationId
}

beforeAll(async () => {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
  db = new Client({ connectionString: process.env.TEST_DATABASE_URL })
  await db.connect()
  techId = await makeUser('signoff-tech@test.local', 'Tina Technician', 'operator')
  approverId = await makeUser('signoff-manager@test.local', 'Sam Signer', 'manager')
  pcbaTypeId = (await db.query(`SELECT id FROM component_type WHERE code='pcba_a'`)).rows[0].id
})

afterAll(async () => {
  if (createdRepairIds.length) {
    const { rows: taskIds } = await db.query<{ task_id: string }>(
      `SELECT DISTINCT task_id FROM task_link WHERE entity_id = ANY($1)`, [createdRepairIds])
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
  if (createdInstallationIds.length) {
    // component_installation is append-only (fn_component_installation_guard
    // rejects DELETE), so the guard comes off for teardown — repairService's idiom.
    await db.query(`ALTER TABLE component_installation DISABLE TRIGGER trg_component_installation_guard`)
    await db.query(`DELETE FROM component_installation WHERE device_id = ANY($1)`, [createdDeviceIds])
    await db.query(`ALTER TABLE component_installation ENABLE TRIGGER trg_component_installation_guard`)
  }
  if (createdUnitIds.length) {
    await db.query(`DELETE FROM component_unit WHERE id = ANY($1)`, [createdUnitIds])
  }
  if (createdRepairIds.length) {
    await db.query(`DELETE FROM repair_status_history WHERE repair_id = ANY($1)`, [createdRepairIds])
    await db.query(`DELETE FROM repair WHERE id = ANY($1)`, [createdRepairIds])
    await db.query(`DELETE FROM audit_log WHERE table_name='repair' AND row_id = ANY($1)`,
      [createdRepairIds])
  }
  if (createdDeviceIds.length) {
    await db.query(`DELETE FROM device_status_history WHERE device_id = ANY($1)`, [createdDeviceIds])
    await db.query(`DELETE FROM device WHERE id = ANY($1)`, [createdDeviceIds])
  }
  await db.end()
  await getPool().end()
})

// ═══════════════════════════════════════════════════════════════════════════
// 1. THE REGRESSION GUARD.
// ═══════════════════════════════════════════════════════════════════════════
describe('repair sign-off — pre-existing behaviour is unchanged', () => {
  it('still refuses sign-off without sign_off_repairs', async () => {
    const { repairId } = await openRepair()
    await driveToAwaitingSignOff(repairId)
    await expect(signOffRepair(tech(), { repairId, version: await currentVersion(repairId) }))
      .rejects.toThrow(PermissionError)
  })

  it('still signs off a repair nobody raised a request for', async () => {
    // The migration's central promise: no new precondition.
    const { deviceId, repairId } = await openRepair(true)
    await driveToAwaitingSignOff(repairId)
    const res = await signOffRepair(signer(), {
      repairId, version: await currentVersion(repairId) })
    expect(res.status).toBe('closed')
    expect(res.deviceReturned).toBe(true)

    const row = await repairRow(repairId)
    expect(row.status).toBe('closed')
    expect(row.signed_off_by).toBe(approverId)
    const dev = await db.query(`SELECT status FROM device WHERE id=$1`, [deviceId])
    expect(dev.rows[0].status).toBe('active')
  })

  // ── The three-fact precondition, intact ──────────────────────────────────
  it('FACT 1: still refuses sign-off unless the repair is awaiting_sign_off', async () => {
    const { repairId } = await openRepair()
    await expect(signOffRepair(signer(), { repairId, version: 1 }))
      .rejects.toThrow(RepairSignOffError)
  })

  it('FACT 2: still refuses sign-off when testing notes are missing', async () => {
    const { repairId } = await openRepair()
    await changeRepairStatus(tech(), {
      repairId, toStatus: 'in_diagnosis', version: await currentVersion(repairId) })
    await changeRepairStatus(tech(), {
      repairId, toStatus: 'in_repair', version: await currentVersion(repairId) })
    await changeRepairStatus(tech(), {
      repairId, toStatus: 'testing', version: await currentVersion(repairId) })
    await changeRepairStatus(tech(), {
      repairId, toStatus: 'awaiting_sign_off', version: await currentVersion(repairId) })

    await expect(signOffRepair(signer(), { repairId, version: await currentVersion(repairId) }))
      .rejects.toMatchObject({ name: 'RepairSignOffError', code: 'testing_notes_required' })
  })

  it('FACT 3: still refuses when parts_replaced is claimed but nothing backs it', async () => {
    const { repairId } = await openRepair(true)
    await driveToAwaitingSignOff(repairId)
    await updateRepair(tech(), {
      repairId, version: await currentVersion(repairId), partsReplaced: true })

    await expect(signOffRepair(signer(), { repairId, version: await currentVersion(repairId) }))
      .rejects.toMatchObject({ name: 'RepairSignOffError', code: 'replacement_not_recorded' })

    const row = await repairRow(repairId)
    expect(row.status).toBe('awaiting_sign_off')
    expect(row.signed_off_by).toBeNull()
  })

  it('FACT 3: still signs off once a replacement FROM the repair references it', async () => {
    const { deviceId, repairId } = await openRepair(true)
    const open = await installPcba(deviceId, await makeUnit('a'))
    const res = await replaceComponentInstallation(tech(), {
      removedInstallationId: open, reason: 'board dead', repairId,
      replacementUnitId: await makeUnit('b'),
    })
    createdInstallationIds.push(res.newId)

    await driveToAwaitingSignOff(repairId)
    await updateRepair(tech(), {
      repairId, version: await currentVersion(repairId), partsReplaced: true })

    const signed = await signOffRepair(signer(), {
      repairId, version: await currentVersion(repairId) })
    expect(signed.status).toBe('closed')
  })

  /**
   * ORDERING, pinned. The precondition is the older, stricter rule and must be
   * reported first: telling a technician their approval drifted when the real
   * problem is a missing component record sends them to the wrong fix.
   */
  it('reports a FAILED PRECONDITION even when an approval also exists', async () => {
    const { repairId } = await openRepair(true)
    await driveToAwaitingSignOff(repairId)
    const { approvalId } = track(await requestRepairSignOffApproval(tech(), {
      repairId, version: await currentVersion(repairId) }))
    await decideApproval(signer(), { approvalId, decision: 'approved' })

    // Now break the precondition: claim parts were replaced, with no backing.
    await updateRepair(tech(), {
      repairId, version: await currentVersion(repairId), partsReplaced: true })

    const err = await signOffRepair(signer(), {
      repairId, version: await currentVersion(repairId) }).catch((e) => e)
    expect(err).toBeInstanceOf(RepairSignOffError)
    expect(err.code).toBe('replacement_not_recorded')
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 2. Requesting.
// ═══════════════════════════════════════════════════════════════════════════
describe('requestRepairSignOffApproval', () => {
  it('records the claim, its backing, the evidence, the technician and the device', async () => {
    const { deviceId, repairId } = await openRepair(true)
    await driveToAwaitingSignOff(repairId)
    const { approvalId } = track(await requestRepairSignOffApproval(tech(), {
      repairId, version: await currentVersion(repairId) }))

    const { rows } = await db.query<{
      status: string; kind: string; module: string; entity_type: string
      snapshot: Record<string, unknown>
    }>(`SELECT status, kind, module, entity_type, snapshot FROM approval WHERE id=$1`,
      [approvalId])
    expect(rows[0]).toMatchObject({
      status: 'pending', kind: 'repair_signoff', module: 'maintenance', entity_type: 'repair',
    })
    expect(rows[0].snapshot).toMatchObject({
      deviceId,
      partsReplaced: false,
      recordedReplacementCount: 0,
      testingNotes: 'Burn-in 4 h at 45 C, no resets.',
      correctiveAction: 'Replaced PCBA-A.',
    })
    expect(rows[0].snapshot.repairNo).toMatch(/^REP-/)
  })

  it('refuses a request unless the repair is awaiting sign-off', async () => {
    const { repairId } = await openRepair()
    await expect(requestRepairSignOffApproval(tech(), {
      repairId, version: await currentVersion(repairId) }))
      .rejects.toThrow(RepairSignOffRequestError)
  })

  it('refuses a request raised from a stale screen', async () => {
    const { repairId } = await openRepair()
    await driveToAwaitingSignOff(repairId)
    await expect(requestRepairSignOffApproval(tech(), { repairId, version: 999 }))
      .rejects.toThrow(OptimisticLockError)
  })

  it('refuses a request for a repair that does not exist', async () => {
    const { rows } = await db.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)
    await expect(requestRepairSignOffApproval(tech(), { repairId: rows[0].id, version: 1 }))
      .rejects.toThrow(RepairNotFoundError)
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 3. The gate.
// ═══════════════════════════════════════════════════════════════════════════
describe('the repair sign-off approval gate', () => {
  it('blocks sign-off while the request is pending', async () => {
    const { repairId } = await openRepair(true)
    await driveToAwaitingSignOff(repairId)
    track(await requestRepairSignOffApproval(tech(), {
      repairId, version: await currentVersion(repairId) }))

    const err = await signOffRepair(signer(), {
      repairId, version: await currentVersion(repairId) }).catch((e) => e)
    expect(err).toBeInstanceOf(RepairSignOffApprovalError)
    expect(err.code).toBe('approval_pending')
    expect((await repairRow(repairId)).status).toBe('awaiting_sign_off')
  })

  it('blocks sign-off when the request was rejected, and repeats the note', async () => {
    const { repairId } = await openRepair(true)
    await driveToAwaitingSignOff(repairId)
    const { approvalId } = track(await requestRepairSignOffApproval(tech(), {
      repairId, version: await currentVersion(repairId) }))
    await decideApproval(signer(), {
      approvalId, decision: 'rejected', note: 'Burn-in was too short' })

    const err = await signOffRepair(signer(), {
      repairId, version: await currentVersion(repairId) }).catch((e) => e)
    expect(err.code).toBe('approval_rejected')
    expect(err.message).toContain('Burn-in was too short')
  })

  it('permits sign-off once approved and nothing moved', async () => {
    const { repairId } = await openRepair(true)
    await driveToAwaitingSignOff(repairId)
    const { approvalId } = track(await requestRepairSignOffApproval(tech(), {
      repairId, version: await currentVersion(repairId) }))
    await decideApproval(signer(), { approvalId, decision: 'approved' })

    const res = await signOffRepair(signer(), {
      repairId, version: await currentVersion(repairId) })
    expect(res.status).toBe('closed')
  })

  /**
   * THE TEST THIS SLICE EXISTS FOR, in its most consequential form: the testing
   * notes are the evidence being signed off, and rewriting them after an approver
   * read them is precisely the failure the snapshot exists to catch.
   */
  it('REFUSES sign-off after the TESTING NOTES were rewritten, naming the field', async () => {
    const { repairId } = await openRepair(true)
    await driveToAwaitingSignOff(repairId)
    const { approvalId } = track(await requestRepairSignOffApproval(tech(), {
      repairId, version: await currentVersion(repairId) }))
    await decideApproval(signer(), { approvalId, decision: 'approved' })

    await updateRepair(tech(), {
      repairId, version: await currentVersion(repairId),
      testingNotes: 'Powered on, looked fine.' })

    const err = await signOffRepair(signer(), {
      repairId, version: await currentVersion(repairId) }).catch((e) => e)
    expect(err).toBeInstanceOf(RepairSignOffApprovalError)
    expect(err.code).toBe('approval_drifted')
    expect(err.message).toContain('testingNotes')
    expect(err.message).toContain('Burn-in')
    expect(err.message).toContain('Powered on')

    // and nothing moved
    const row = await repairRow(repairId)
    expect(row.status).toBe('awaiting_sign_off')
    expect(row.signed_off_by).toBeNull()
  })

  it('REFUSES sign-off after the parts-replaced CLAIM was flipped', async () => {
    const { deviceId, repairId } = await openRepair(true)
    const open = await installPcba(deviceId, await makeUnit('c'))
    const res = await replaceComponentInstallation(tech(), {
      removedInstallationId: open, reason: 'board dead', repairId,
      replacementUnitId: await makeUnit('d'),
    })
    createdInstallationIds.push(res.newId)

    await driveToAwaitingSignOff(repairId)
    await updateRepair(tech(), {
      repairId, version: await currentVersion(repairId), partsReplaced: true })

    const { approvalId } = track(await requestRepairSignOffApproval(tech(), {
      repairId, version: await currentVersion(repairId) }))
    await decideApproval(signer(), { approvalId, decision: 'approved' })

    // Withdraw the claim after approval.
    await updateRepair(tech(), {
      repairId, version: await currentVersion(repairId), partsReplaced: false })

    const err = await signOffRepair(signer(), {
      repairId, version: await currentVersion(repairId) }).catch((e) => e)
    expect(err.code).toBe('approval_drifted')
    expect(err.message).toContain('partsReplaced')
  })

  /**
   * THE AFFECTED-ITEMS CASE for Maintenance. The precondition only ever asks "is
   * there at least one?", which stays true while the answer moves from two to
   * four — so without the snapshot an approver who reviewed one board swap would
   * silently be signing off on two.
   */
  it('REFUSES sign-off when MORE replacements were recorded after approval', async () => {
    const { deviceId, repairId } = await openRepair(true)
    const first = await installPcba(deviceId, await makeUnit('e'))
    const r1 = await replaceComponentInstallation(tech(), {
      removedInstallationId: first, reason: 'board dead', repairId,
      replacementUnitId: await makeUnit('f'),
    })
    createdInstallationIds.push(r1.newId)

    await driveToAwaitingSignOff(repairId)
    await updateRepair(tech(), {
      repairId, version: await currentVersion(repairId), partsReplaced: true })

    const { approvalId } = track(await requestRepairSignOffApproval(tech(), {
      repairId, version: await currentVersion(repairId) }))
    await decideApproval(signer(), { approvalId, decision: 'approved' })

    // A SECOND replacement lands after the approver signed off on the first.
    const r2 = await replaceComponentInstallation(tech(), {
      removedInstallationId: r1.newId, reason: 'second board also dead', repairId,
      replacementUnitId: await makeUnit('g'),
    })
    createdInstallationIds.push(r2.newId)

    const err = await signOffRepair(signer(), {
      repairId, version: await currentVersion(repairId) }).catch((e) => e)
    expect(err).toBeInstanceOf(RepairSignOffApprovalError)
    expect(err.code).toBe('approval_drifted')
    expect(err.message).toContain('recordedReplacementCount')

    const row = await repairRow(repairId)
    expect(row.status).toBe('awaiting_sign_off')
    expect(row.signed_off_by).toBeNull()
  })

  it('still demands sign_off_repairs even with an approved, non-drifted approval', async () => {
    const { repairId } = await openRepair(true)
    await driveToAwaitingSignOff(repairId)
    const { approvalId } = track(await requestRepairSignOffApproval(tech(), {
      repairId, version: await currentVersion(repairId) }))
    await decideApproval(signer(), { approvalId, decision: 'approved' })

    await expect(signOffRepair(tech(), { repairId, version: await currentVersion(repairId) }))
      .rejects.toThrow(PermissionError)
    expect((await repairRow(repairId)).status).toBe('awaiting_sign_off')
  })

  it('nobody signs off against their own request', async () => {
    const { repairId } = await openRepair(true)
    await driveToAwaitingSignOff(repairId)
    // The SIGNER raises this one themselves.
    const { approvalId } = track(await requestRepairSignOffApproval(signer(), {
      repairId, version: await currentVersion(repairId) }))
    await expect(decideApproval(signer(), { approvalId, decision: 'approved' }))
      .rejects.toMatchObject({ name: 'ApprovalDecisionError', code: 'self_approval' })
  })
})

// ═══════════════════════════════════════════════════════════════════════════
// 4. Reading, and the queued task.
// ═══════════════════════════════════════════════════════════════════════════
describe('getRepairSignOffApprovalState', () => {
  it('reports an awaiting-sign-off repair as requestable', async () => {
    const { repairId } = await openRepair()
    await driveToAwaitingSignOff(repairId)
    const state = await getRepairSignOffApprovalState(tech(), repairId)
    expect(state).toMatchObject({ requestable: true, requestableReason: null, approval: null })
    expect(state!.drift).toEqual([])
  })

  it('reports an in-progress repair as not requestable, and says why', async () => {
    const { repairId } = await openRepair()
    const state = await getRepairSignOffApprovalState(tech(), repairId)
    expect(state!.requestable).toBe(false)
    expect(state!.requestableReason!.toLowerCase()).toContain('awaiting sign-off')
  })

  it('surfaces drift BEFORE anyone clicks sign off', async () => {
    const { repairId } = await openRepair(true)
    await driveToAwaitingSignOff(repairId)
    const { approvalId } = track(await requestRepairSignOffApproval(tech(), {
      repairId, version: await currentVersion(repairId) }))
    await decideApproval(signer(), { approvalId, decision: 'approved' })
    await updateRepair(tech(), {
      repairId, version: await currentVersion(repairId), testingNotes: 'changed' })

    const state = await getRepairSignOffApprovalState(tech(), repairId)
    expect(state!.drift.join('; ')).toContain('testingNotes')
  })

  it('returns null for an unknown id rather than throwing', async () => {
    const { rows } = await db.query<{ id: string }>(`SELECT gen_random_uuid() AS id`)
    expect(await getRepairSignOffApprovalState(tech(), rows[0].id)).toBeNull()
    expect(await getRepairSignOffApprovalState(tech(), 'not-a-uuid')).toBeNull()
  })
})

describe('the queued sign-off approval task', () => {
  it('drains into a real task now that the repair_signoff kind is registered', async () => {
    const { repairId } = await openRepair()
    await driveToAwaitingSignOff(repairId)
    track(await requestRepairSignOffApproval(tech(), {
      repairId, version: await currentVersion(repairId) }))
    await drainOutbox()

    const { rows } = await db.query<{
      title: string; description: string; department: string | null; priority: string
    }>(
      `SELECT t.title, t.description, t.department, t.priority
         FROM task t JOIN task_link l ON l.task_id = t.id
        WHERE l.entity_id = $1`, [repairId])
    expect(rows).toHaveLength(1)
    expect(rows[0].title).toContain('REP-')
    expect(rows[0].department).toBe('Maintenance')
    expect(rows[0].priority).toBe('high')
    expect(rows[0].description.toLowerCase()).toContain('testing notes')
  })
})
