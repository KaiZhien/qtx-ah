import { describe, it, expect } from 'vitest'
import {
  REPAIR_SIGNOFF_ENTITY_TYPE, REPAIR_SIGNOFF_KIND, REPAIR_SIGNOFF_SUBJECT,
  buildRepairSignOffSnapshot, repairSignOffRequestable,
} from '@/modules/shared/approvals/domain/repairSignOffApproval'
import { evaluateApprovalGate } from '@/modules/shared/approvals/domain/approvalGate'

const facts = (over: Record<string, unknown> = {}) => ({
  repairNo: 'REP-2026-0042',
  deviceId: '33333333-3333-3333-3333-333333333333',
  deviceSn: 'EE-02A-2603-0007',
  technicianId: '44444444-4444-4444-4444-444444444444',
  technicianName: 'Aisyah Rahman',
  partsReplaced: true,
  recordedReplacementCount: 2,
  testingNotes: 'Burn-in 4 h at 45 °C, no resets.',
  correctiveAction: 'Replaced PCBA-A.',
  version: 9,
  ...over,
}) as Parameters<typeof buildRepairSignOffSnapshot>[0]

describe('the repair sign-off approval target', () => {
  it('names the entity type and kind the shared engine registered', () => {
    // APPROVAL_TARGETS maps kind 'repair_signoff' → entityType 'repair'. The two
    // differ on purpose (the kind names the ACT, the entity type names the ROW),
    // which is exactly why they are pinned rather than assumed equal.
    expect(REPAIR_SIGNOFF_ENTITY_TYPE).toBe('repair')
    expect(REPAIR_SIGNOFF_KIND).toBe('repair_signoff')
    expect(REPAIR_SIGNOFF_SUBJECT).toBe('this repair')
  })
})

describe('buildRepairSignOffSnapshot — what a sign-off approver is agreeing to', () => {
  it('captures the repair STATE: the claim, its backing, the evidence, who and what', () => {
    expect(buildRepairSignOffSnapshot(facts())).toEqual({
      repairNo: 'REP-2026-0042',
      deviceId: '33333333-3333-3333-3333-333333333333',
      deviceSn: 'EE-02A-2603-0007',
      technicianId: '44444444-4444-4444-4444-444444444444',
      technicianName: 'Aisyah Rahman',
      partsReplaced: true,
      recordedReplacementCount: 2,
      testingNotes: 'Burn-in 4 h at 45 °C, no resets.',
      correctiveAction: 'Replaced PCBA-A.',
      version: 9,
    })
  })

  it('keeps an unassigned technician as an explicit null', () => {
    const snap = buildRepairSignOffSnapshot(facts({
      technicianId: null, technicianName: null, deviceSn: null,
    })) as Record<string, unknown>
    expect(Object.prototype.hasOwnProperty.call(snap, 'technicianId')).toBe(true)
    expect(snap.technicianId).toBeNull()
  })
})

describe('the repair snapshot catches the edits that matter', () => {
  const gate = (current: Record<string, unknown>, approvedSnap: Record<string, unknown>) =>
    evaluateApprovalGate({
      subject: REPAIR_SIGNOFF_SUBJECT, action: 'signed off', requiredWithoutRequest: false,
      current, approval: { status: 'approved', snapshot: approvedSnap, decisionNote: null },
    })

  it('permits signing off a repair nobody touched', () => {
    expect(gate(buildRepairSignOffSnapshot(facts()), buildRepairSignOffSnapshot(facts())))
      .toEqual({ ok: true })
  })

  it('refuses when the parts-replaced CLAIM flipped after approval', () => {
    // The claim is an assertion about the world (see the column COMMENT). An
    // approver who agreed "yes, a board was swapped, here is the backing" has not
    // agreed to a sign-off that now claims nothing was replaced, or vice versa.
    const result = gate(
      buildRepairSignOffSnapshot(facts({ partsReplaced: false, recordedReplacementCount: 0 })),
      buildRepairSignOffSnapshot(facts()))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('approval_drifted')
    expect(result.message).toContain('partsReplaced')
  })

  it('refuses when the BACKING for the claim changed — the affected-items case', () => {
    // component_installation rows are the evidence behind parts_replaced. Another
    // replacement recorded between the approval and the sign-off means the
    // approver signed off on different work.
    const result = gate(
      buildRepairSignOffSnapshot(facts({ recordedReplacementCount: 4 })),
      buildRepairSignOffSnapshot(facts({ recordedReplacementCount: 2 })))
    if (result.ok) throw new Error('unreachable')
    expect(result.message).toContain('recordedReplacementCount')
    expect(result.message).toContain('4')
  })

  it('refuses when the testing notes — the evidence being signed off — were rewritten', () => {
    const result = gate(
      buildRepairSignOffSnapshot(facts({ testingNotes: 'Powered on, looked fine.' })),
      buildRepairSignOffSnapshot(facts()))
    if (result.ok) throw new Error('unreachable')
    expect(result.message).toContain('testingNotes')
  })

  it('refuses when the repair was reassigned to a different technician', () => {
    const result = gate(
      buildRepairSignOffSnapshot(facts({
        technicianId: '55555555-5555-5555-5555-555555555555', technicianName: 'Wei Lin',
      })),
      buildRepairSignOffSnapshot(facts()))
    if (result.ok) throw new Error('unreachable')
    expect(result.message).toContain('technicianId')
  })

  it('refuses when the repair points at a different device', () => {
    const result = gate(
      buildRepairSignOffSnapshot(facts({
        deviceId: '66666666-6666-6666-6666-666666666666', deviceSn: 'EE-02A-2603-0099',
      })),
      buildRepairSignOffSnapshot(facts()))
    if (result.ok) throw new Error('unreachable')
    expect(result.message).toContain('deviceId')
  })

  it('agrees when the replacement count arrives as a numeric string from the driver', () => {
    // A count read back through jsonb is a number; one that came from a COUNT(*)
    // may arrive as text. Cross-type numeric agreement is deliberate — reporting
    // drift on every unchanged repair would train everyone to ignore the warning.
    const result = gate(
      buildRepairSignOffSnapshot(facts({ recordedReplacementCount: '2' })),
      buildRepairSignOffSnapshot(facts({ recordedReplacementCount: 2 })))
    expect(result).toEqual({ ok: true })
  })
})

describe('repairSignOffRequestable', () => {
  it('permits a request only while the repair is awaiting sign-off', () => {
    // Sign-off is the awaiting_sign_off → closed edge, and only that edge. Asking
    // for approval earlier asks someone to agree to work still in progress.
    expect(repairSignOffRequestable('awaiting_sign_off')).toEqual({ ok: true })
    for (const status of ['reported', 'in_diagnosis', 'in_repair', 'testing', 'closed',
                          'cancelled']) {
      const result = repairSignOffRequestable(status)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.message.toLowerCase()).toContain('awaiting sign-off')
    }
  })
})
