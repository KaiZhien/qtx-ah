import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRequireAal2Actor = vi.fn()
const mockDecideApproval = vi.fn()

vi.mock('@/modules/shared/auth/session', () => ({
  requireAal2Actor: mockRequireAal2Actor,
  MfaRequiredError: class MfaRequiredError extends Error {},
}))
vi.mock('@/modules/shared/approvals/services/approvalService', () => ({
  decideApproval: mockDecideApproval,
  ApprovalNotFoundError: class ApprovalNotFoundError extends Error {},
  RejectionNeedsNoteError: class RejectionNeedsNoteError extends Error {
    constructor() { super('A rejection needs a note saying what has to change') }
  },
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const { decideApprovalAction } = await import('@/app/(platform)/approvals/actions')
const { MfaRequiredError } = await import('@/modules/shared/auth/session')
const {
  ApprovalNotFoundError, RejectionNeedsNoteError,
} = await import('@/modules/shared/approvals/services/approvalService')
const {
  ApprovalDecisionError, messageForDecisionError,
} = await import('@/modules/shared/approvals/domain/approvalDecision')

const ACTOR = {
  id: 'u1', roleKey: 'manager' as const,
  permissions: new Set(['approve_requests' as const]),
  moduleAccess: new Set(['finance' as const]), active: true,
}
const ID = '3f2a1b4c-0000-4000-8000-000000000001'

beforeEach(() => {
  mockRequireAal2Actor.mockReset().mockResolvedValue(ACTOR)
  mockDecideApproval.mockReset()
})

describe('decideApprovalAction', () => {
  it('approves and reports the new status', async () => {
    mockDecideApproval.mockResolvedValue({ status: 'approved', version: 2 })
    expect(await decideApprovalAction({ approvalId: ID, decision: 'approved' }))
      .toEqual({ ok: true, data: { status: 'approved' } })
    expect(mockDecideApproval).toHaveBeenCalledWith(
      ACTOR, { approvalId: ID, decision: 'approved', note: undefined })
  })

  it('carries the rejection note through to the service', async () => {
    mockDecideApproval.mockResolvedValue({ status: 'rejected', version: 2 })
    await decideApprovalAction({ approvalId: ID, decision: 'rejected', note: 'Discount unagreed' })
    expect(mockDecideApproval).toHaveBeenCalledWith(
      ACTOR, { approvalId: ID, decision: 'rejected', note: 'Discount unagreed' })
  })

  // The regression this project has shipped before: requireAal2Actor OUTSIDE the
  // try throws out of the action instead of returning a result the UI can render,
  // and __tests__/actionAalPinning.test.ts only checks that the identifier appears.
  it('RETURNS a failure when the session is not AAL2 — it does not throw', async () => {
    mockRequireAal2Actor.mockRejectedValue(new MfaRequiredError())
    const res = await decideApprovalAction({ approvalId: ID, decision: 'approved' })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toContain('Two-factor')
    expect(mockDecideApproval).not.toHaveBeenCalled()
  })

  it('reports an unknown approval without confirming anything about it', async () => {
    mockDecideApproval.mockRejectedValue(new ApprovalNotFoundError('gone'))
    expect(await decideApprovalAction({ approvalId: ID, decision: 'approved' }))
      .toEqual({ ok: false, error: 'That approval request no longer exists.' })
  })

  it('repeats the domain’s own wording for the three decision refusals', async () => {
    for (const code of ['already_decided', 'permission_denied', 'self_approval'] as const) {
      mockDecideApproval.mockRejectedValue(
        new ApprovalDecisionError(code, messageForDecisionError(code)))
      const res = await decideApprovalAction({ approvalId: ID, decision: 'approved' })
      expect(res).toEqual({ ok: false, error: messageForDecisionError(code) })
    }
  })

  it('explains a missing rejection note rather than swallowing it', async () => {
    mockDecideApproval.mockRejectedValue(new RejectionNeedsNoteError())
    const res = await decideApprovalAction({ approvalId: ID, decision: 'rejected' })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toContain('note')
  })

  it('refuses a blank rejection note in the ACTION, before the service is called', async () => {
    // The UI collects the note, but a form can still be posted without one; the
    // point is that the user is never told "you needed a note" by a 500.
    const res = await decideApprovalAction({ approvalId: ID, decision: 'rejected', note: '   ' })
    expect(res.ok).toBe(false)
    expect(mockDecideApproval).not.toHaveBeenCalled()
  })

  it('rejects a malformed id before touching the service', async () => {
    const res = await decideApprovalAction({ approvalId: 'not-a-uuid', decision: 'approved' })
    expect(res.ok).toBe(false)
    expect(mockDecideApproval).not.toHaveBeenCalled()
  })

  it('never leaks an internal error message', async () => {
    mockDecideApproval.mockRejectedValue(
      new Error('duplicate key value violates unique constraint "approval_one_pending_idx"'))
    const res = await decideApprovalAction({ approvalId: ID, decision: 'approved' })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).not.toContain('constraint')
    expect((res as { error: string }).error).not.toContain('approval_one_pending_idx')
  })
})
