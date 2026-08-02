import { describe, it, expect } from 'vitest'
import {
  ECO_APPROVAL_ENTITY_TYPE, ECO_APPROVAL_KIND, ECO_APPROVAL_SUBJECT,
  buildEcoApprovalSnapshot, ecoApprovalRequestable,
} from '@/modules/shared/approvals/domain/ecoApproval'
import { evaluateApprovalGate } from '@/modules/shared/approvals/domain/approvalGate'

const facts = (over: Record<string, unknown> = {}) => ({
  ecoNo: 'ECO-2026-0007',
  title: 'Replace the 3V3 regulator',
  description: 'Thermal margin too small on rev C.',
  ecrId: '11111111-1111-1111-1111-111111111111',
  ecrNo: 'ECR-2026-0003',
  effectivityDate: '2026-09-01',
  effectivitySerial: 'EE-02A-2603-0001 to 0015',
  effectivityNotes: 'Retrofit at next service.',
  version: 4,
  ...over,
}) as Parameters<typeof buildEcoApprovalSnapshot>[0]

describe('the ECO approval target', () => {
  it('names the entity type and kind the shared engine registered for ECOs', () => {
    // APPROVAL_TARGETS in approvalService maps kind 'eco' → table/entityType 'eco';
    // a drift between these constants and that registry is a request the service
    // refuses with ApprovalTargetError, so they are pinned.
    expect(ECO_APPROVAL_ENTITY_TYPE).toBe('eco')
    expect(ECO_APPROVAL_KIND).toBe('eco')
    expect(ECO_APPROVAL_SUBJECT).toBe('this ECO')
  })
})

describe('buildEcoApprovalSnapshot — what an approver is agreeing to', () => {
  it('captures the change itself, not merely its id', () => {
    // "a snapshot of only the id authorises nothing" — the migration header.
    const snap = buildEcoApprovalSnapshot(facts())
    expect(snap).toEqual({
      ecoNo: 'ECO-2026-0007',
      title: 'Replace the 3V3 regulator',
      description: 'Thermal margin too small on rev C.',
      ecrId: '11111111-1111-1111-1111-111111111111',
      ecrNo: 'ECR-2026-0003',
      effectivityDate: '2026-09-01',
      effectivitySerial: 'EE-02A-2603-0001 to 0015',
      effectivityNotes: 'Retrofit at next service.',
      version: 4,
    })
  })

  it('is a non-empty plain object the engine will accept as a snapshot', () => {
    // approvalService refuses `{}` — it would compare equal to everything and make
    // the re-check pass vacuously.
    const snap = buildEcoApprovalSnapshot(facts()) as Record<string, unknown>
    expect(Object.keys(snap).length).toBeGreaterThan(0)
    expect(JSON.stringify(snap)).not.toBe('{}')
  })

  it('keeps nulls as nulls rather than dropping the keys', () => {
    // `null` is not a missing key: a field CLEARED after approval must read as a
    // changed value, not as an absent one, so the drift line can say which.
    const snap = buildEcoApprovalSnapshot(facts({
      description: null, ecrId: null, ecrNo: null,
      effectivityDate: null, effectivitySerial: null, effectivityNotes: null,
    })) as Record<string, unknown>
    for (const key of ['description', 'ecrId', 'effectivityDate', 'effectivitySerial']) {
      expect(Object.prototype.hasOwnProperty.call(snap, key)).toBe(true)
      expect(snap[key]).toBeNull()
    }
  })
})

describe('the ECO snapshot catches the edits that matter', () => {
  const gate = (current: Record<string, unknown>, approvedSnap: Record<string, unknown>) =>
    evaluateApprovalGate({
      subject: ECO_APPROVAL_SUBJECT, action: 'approved', requiredWithoutRequest: false,
      current, approval: { status: 'approved', snapshot: approvedSnap, decisionNote: null },
    })

  it('permits approving an ECO nobody touched', () => {
    expect(gate(buildEcoApprovalSnapshot(facts()), buildEcoApprovalSnapshot(facts())))
      .toEqual({ ok: true })
  })

  it('refuses when the SCOPE widened — the affected-items case', () => {
    // effectivity_serial is which devices the change applies to. Widening it
    // after approval is adding affected items, and it must not ride the old
    // approval.
    const result = gate(
      buildEcoApprovalSnapshot(facts({ effectivitySerial: 'EE-02A-2603-0001 to 0090' })),
      buildEcoApprovalSnapshot(facts()))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('approval_drifted')
    expect(result.message).toContain('effectivitySerial')
    expect(result.message).toContain('0090')
  })

  it('refuses when the change itself was rewritten', () => {
    const result = gate(
      buildEcoApprovalSnapshot(facts({ title: 'Replace the 5V regulator' })),
      buildEcoApprovalSnapshot(facts()))
    if (result.ok) throw new Error('unreachable')
    expect(result.message).toContain('title')
  })

  it('refuses when the ECO is re-pointed at a different ECR', () => {
    // The originating request is part of what was approved: an order realising
    // ECR-3 is not the same order once it realises ECR-9.
    const result = gate(
      buildEcoApprovalSnapshot(facts({
        ecrId: '22222222-2222-2222-2222-222222222222', ecrNo: 'ECR-2026-0009',
      })),
      buildEcoApprovalSnapshot(facts()))
    if (result.ok) throw new Error('unreachable')
    expect(result.message).toContain('ecrId')
  })

  it('refuses when the row changed in a way no enumerated field describes', () => {
    // `version` is the catch-all. Every updateEco writes it, so a column added to
    // `eco` LATER — an affected-items list, a cost, a risk class — cannot slip
    // past a snapshot written before that column existed. Fail closed by default;
    // the alternative is a snapshot that silently stops covering the record.
    const result = gate(
      buildEcoApprovalSnapshot(facts({ version: 5 })),
      buildEcoApprovalSnapshot(facts({ version: 4 })))
    if (result.ok) throw new Error('unreachable')
    expect(result.message).toContain('version')
  })

  it('refuses when effectivity is CLEARED, not only when it is changed', () => {
    const result = gate(
      buildEcoApprovalSnapshot(facts({ effectivityDate: null })),
      buildEcoApprovalSnapshot(facts()))
    if (result.ok) throw new Error('unreachable')
    expect(result.message).toContain('effectivityDate')
  })
})

describe('ecoApprovalRequestable', () => {
  it('permits a request only while the ECO is submitted', () => {
    // The gated edge is submitted → approved. Requesting approval for a draft
    // asks someone to agree to something still being written; requesting one for
    // an already-approved ECO asks for a decision that changes nothing.
    expect(ecoApprovalRequestable('submitted')).toEqual({ ok: true })
    for (const status of ['draft', 'approved', 'implemented', 'rejected']) {
      const result = ecoApprovalRequestable(status)
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.message).toContain('submitted')
    }
  })
})
