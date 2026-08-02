import { describe, it, expect } from 'vitest'
import {
  APPROVAL_GATE_ERROR_CODES, ApprovalGateError, evaluateApprovalGate,
} from '@/modules/shared/approvals/domain/approvalGate'

const current = { ecoNo: 'ECO-2026-0001', title: 'Swap the regulator' }

const gate = (over: Record<string, unknown> = {}) => ({
  subject: 'this ECO',
  action: 'approved',
  requiredWithoutRequest: false,
  current,
  approval: null,
  ...over,
}) as Parameters<typeof evaluateApprovalGate>[0]

const approval = (
  status: 'pending' | 'approved' | 'rejected', snapshot: unknown, note: string | null = null,
) => ({ status, snapshot, decisionNote: note })

describe('evaluateApprovalGate — no request has been raised', () => {
  it('permits the action when an approval is not required without one', () => {
    // The migration posture: ECO approval and repair sign-off keep their OWN
    // permission gate as the authorisation layer. The engine adds ceremony to a
    // request that exists; it does not newly forbid an action that has always
    // been allowed. Pinned so the refactor cannot quietly become a new rule.
    expect(evaluateApprovalGate(gate())).toEqual({ ok: true })
  })

  it('refuses when an approval IS required and none was ever requested', () => {
    const result = evaluateApprovalGate(gate({ requiredWithoutRequest: true }))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('approval_missing')
    expect(result.message).toContain('second pair of eyes')
  })
})

describe('evaluateApprovalGate — a request exists and therefore BINDS', () => {
  it('refuses while the request is still pending, whatever the required flag says', () => {
    for (const requiredWithoutRequest of [false, true]) {
      const result = evaluateApprovalGate(
        gate({ requiredWithoutRequest, approval: approval('pending', current) }))
      expect(result.ok).toBe(false)
      if (result.ok) throw new Error('unreachable')
      expect(result.code).toBe('approval_pending')
    }
  })

  it('refuses a rejected request and repeats the note so the fix is actionable', () => {
    const result = evaluateApprovalGate(
      gate({ approval: approval('rejected', current, 'Effectivity serial is wrong') }))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('approval_rejected')
    expect(result.message).toContain('Effectivity serial is wrong')
  })

  it('refuses a rejected request that somehow carries no note, without printing "null"', () => {
    const result = evaluateApprovalGate(gate({ approval: approval('rejected', current, null) }))
    if (result.ok) throw new Error('unreachable')
    expect(result.message).not.toContain('null')
  })

  it('permits an approved request whose snapshot still describes the record', () => {
    // Key ORDER differs deliberately — jsonb does not preserve it, so an
    // order-sensitive compare would report drift on every single approval.
    const reordered = { title: 'Swap the regulator', ecoNo: 'ECO-2026-0001' }
    expect(evaluateApprovalGate(gate({ approval: approval('approved', reordered) })))
      .toEqual({ ok: true })
  })
})

describe('evaluateApprovalGate — drift is the whole point', () => {
  it('refuses an approved request whose record changed, NAMING the field and both values', () => {
    const result = evaluateApprovalGate(gate({
      approval: approval('approved', { ...current, title: 'Swap the capacitor' }),
    }))
    expect(result.ok).toBe(false)
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('approval_drifted')
    // The refusal has to be actionable: "it changed" is a dead end.
    expect(result.message).toContain('title')
    expect(result.message).toContain('Swap the capacitor')
    expect(result.message).toContain('Swap the regulator')
  })

  it('names a field that was ADDED after approval — the affected-item case', () => {
    // Approving a change and then widening its scope must not ride the old
    // approval. An added key is exactly as material as a changed one.
    const result = evaluateApprovalGate(gate({
      current: { ...current, affectedItems: ['PCBA-A'] },
      approval: approval('approved', current),
    }))
    if (result.ok) throw new Error('unreachable')
    expect(result.code).toBe('approval_drifted')
    expect(result.message).toContain('affectedItems')
    expect(result.message).toContain('added')
  })

  it('names a field that was REMOVED after approval', () => {
    const result = evaluateApprovalGate(gate({
      current: { ecoNo: 'ECO-2026-0001' },
      approval: approval('approved', current),
    }))
    if (result.ok) throw new Error('unreachable')
    expect(result.message).toContain('removed')
  })

  it('mentions the subject and the action so the refusal reads in context', () => {
    const result = evaluateApprovalGate(gate({
      subject: 'this repair', action: 'signed off',
      approval: approval('approved', { ...current, title: 'other' }),
    }))
    if (result.ok) throw new Error('unreachable')
    // The subject opens the sentence, so it arrives capitalised.
    expect(result.message.toLowerCase()).toContain('this repair')
    expect(result.message).toContain('signed off')
  })
})

describe('evaluateApprovalGate — fail-closed edges', () => {
  it('treats an unknown status as undecided rather than as approval', () => {
    const result = evaluateApprovalGate(
      gate({ approval: { status: 'withdrawn', snapshot: current, decisionNote: null } }))
    expect(result.ok).toBe(false)
  })

  it('refuses when the stored snapshot is not an object at all', () => {
    // `{}` and `null` compare equal to everything under a naive walk; a snapshot
    // the comparison cannot interpret must never read as agreement.
    for (const snapshot of [null, 'nonsense', 42]) {
      const result = evaluateApprovalGate(gate({ approval: approval('approved', snapshot) }))
      expect(result.ok).toBe(false)
    }
  })

  it('exposes its error codes as a frozen vocabulary', () => {
    expect([...APPROVAL_GATE_ERROR_CODES]).toEqual([
      'approval_missing', 'approval_pending', 'approval_rejected', 'approval_drifted',
    ])
  })

  it('carries the code on the thrown error so a service can map it', () => {
    const err = new ApprovalGateError('approval_drifted', 'changed')
    expect(err).toBeInstanceOf(Error)
    expect(err.name).toBe('ApprovalGateError')
    expect(err.code).toBe('approval_drifted')
  })
})

describe('evaluateApprovalGate — the invariant the engine rests on', () => {
  it('never refuses for drift without being able to explain it', () => {
    // snapshotsAgree(a,b) === (describeSnapshotDrift(a,b).length === 0) holds
    // structurally; this pins the consequence at the gate: a drift refusal
    // always carries at least one named field.
    const pairs: [Record<string, unknown>, Record<string, unknown>][] = [
      [{ a: 1 }, { a: 2 }],
      [{ a: 1 }, { a: 1, b: 2 }],
      [{ a: [1, 2] }, { a: [2, 1] }],
      [{ a: { b: null } }, { a: {} }],
    ]
    for (const [approvedSnap, now] of pairs) {
      const result = evaluateApprovalGate(
        gate({ current: now, approval: approval('approved', approvedSnap) }))
      if (result.ok) throw new Error(`expected drift for ${JSON.stringify(approvedSnap)}`)
      expect(result.code).toBe('approval_drifted')
      expect(result.message.length).toBeGreaterThan(40)
    }
  })

  it('agrees with a numeric string of the same value, cross-type only', () => {
    // node-postgres returns numeric as TEXT; a fresh projection may hold a number.
    expect(evaluateApprovalGate(gate({
      current: { costSgd: '120.00' }, approval: approval('approved', { costSgd: 120 }),
    }))).toEqual({ ok: true })
    // ...but two STRINGS are never compared numerically: "0012" is not "12".
    const result = evaluateApprovalGate(gate({
      current: { repairNo: '12' }, approval: approval('approved', { repairNo: '0012' }),
    }))
    expect(result.ok).toBe(false)
  })
})
