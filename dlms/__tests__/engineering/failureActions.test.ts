import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'

// ---------------------------------------------------------------------------
// Failure-investigation action layer: the sanitization contract.
//
// Two properties, both of which have been real defects in this codebase before:
//   1. requireAal2Actor() is INSIDE the try, so an AAL1 session gets the
//      friendly MFA string rather than an unhandled server-action rejection;
//   2. NOTHING from Postgres reaches the browser — an unrecognised error becomes
//      a fixed generic message, and the raw text never appears in the result.
// ---------------------------------------------------------------------------

const mockRequireAal2Actor = vi.fn()
vi.mock('@/modules/shared/auth/session', () => ({
  requireAal2Actor: mockRequireAal2Actor,
  MfaRequiredError: class MfaRequiredError extends Error {},
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/modules/shared/authz/authorize', () => ({
  authorize: vi.fn(),
  PermissionError: class PermissionError extends Error {},
}))
vi.mock('@/lib/db/tx', () => ({
  OptimisticLockError: class OptimisticLockError extends Error {},
}))

// The mocked error classes keep the REAL constructor arity (and, where the
// action forwards err.message, the real message), so a signature change in the
// service is a type error here rather than a silently-passing test.

const mockCreate = vi.fn()
const mockUpdate = vi.fn()
const mockChangeStatus = vi.fn()
const mockEscalate = vi.fn()

vi.mock('@/modules/engineering/services/failureService', () => ({
  createFailure: (...a: unknown[]) => mockCreate(...a),
  updateFailure: (...a: unknown[]) => mockUpdate(...a),
  changeFailureStatus: (...a: unknown[]) => mockChangeStatus(...a),
  escalateFailureToEco: (...a: unknown[]) => mockEscalate(...a),
  FailureNotFoundError: class FailureNotFoundError extends Error {},
  FailureSubjectNotFoundError: class FailureSubjectNotFoundError extends Error {},
  FailureEscalationError: class FailureEscalationError extends Error {
    constructor(_code: string, message: string) { super(message) }
  },
}))

const {
  createFailureAction, changeFailureStatusAction, escalateFailureAction,
} = await import('@/app/(platform)/engineering/failures/failureActions')
const { MfaRequiredError } = await import('@/modules/shared/auth/session')
const { PermissionError } = await import('@/modules/shared/authz/authorize')
const { OptimisticLockError } = await import('@/lib/db/tx')
const {
  FailureNotFoundError, FailureEscalationError,
} = await import('@/modules/engineering/services/failureService')
const { InvalidFailureTransitionError } = await import('@/modules/engineering/domain/failureStatus')

const MFA_MESSAGE = 'Two-factor authentication required — reload the page to finish signing in.'
const GENERIC = 'Something went wrong. Try again, and tell Reet if it keeps happening.'
const actor = { id: 'u1' }

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireAal2Actor.mockResolvedValue(actor)
})

describe('AAL2 guard placement', () => {
  it('resolves to the friendly MFA error instead of rejecting', async () => {
    mockRequireAal2Actor.mockRejectedValue(new MfaRequiredError())
    await expect(createFailureAction({ title: 'x' })).resolves.toEqual({
      ok: false, error: MFA_MESSAGE,
    })
    // …and the service was never reached.
    expect(mockCreate).not.toHaveBeenCalled()
  })
})

describe('error sanitization', () => {
  it('passes a transition refusal through verbatim — it is already operator-readable', async () => {
    mockChangeStatus.mockRejectedValue(new InvalidFailureTransitionError(
      'root_cause_required', 'Record a root cause before moving the investigation forward.'))
    await expect(changeFailureStatusAction({ id: 'f1', version: 1, toStatus: 'closed' }))
      .resolves.toEqual({
        ok: false, error: 'Record a root cause before moving the investigation forward.',
      })
  })

  it('passes an escalation refusal through verbatim', async () => {
    mockEscalate.mockRejectedValue(new FailureEscalationError(
      'root_cause_required', 'Record a root cause before escalating to a change order.'))
    const res = await escalateFailureAction({ id: 'f1', version: 1, ecoId: 'e1' })
    expect(res).toEqual({
      ok: false, error: 'Record a root cause before escalating to a change order.',
    })
  })

  it('maps a lost record and a lost race to distinct reload prompts', async () => {
    mockChangeStatus.mockRejectedValue(new FailureNotFoundError('gone'))
    await expect(changeFailureStatusAction({ id: 'f1', version: 1, toStatus: 'investigating' }))
      .resolves.toEqual({
        ok: false, error: 'That investigation no longer exists. Reload and try again.',
      })

    mockChangeStatus.mockRejectedValue(new OptimisticLockError('failure_investigation', 'f1'))
    await expect(changeFailureStatusAction({ id: 'f1', version: 1, toStatus: 'investigating' }))
      .resolves.toEqual({
        ok: false, error: 'Someone else changed this investigation. Reload and try again.',
      })
  })

  it('maps a permission denial without confirming what was denied', async () => {
    mockCreate.mockRejectedValue(new PermissionError('create_records', 'engineering'))
    await expect(createFailureAction({ title: 'x' })).resolves.toEqual({
      ok: false, error: "You don't have permission to do that.",
    })
  })

  it('renders a ZodError as the field message the user can act on', async () => {
    // A ZodError is the form disagreeing with the schema, not an internal fault.
    // Untreated it fell to the generic branch, which also logged an error line
    // for every over-long title someone typed.
    const zerr = new z.ZodError([{
      code: 'too_big', maximum: 200, type: 'string', inclusive: true,
      path: ['title'], message: 'String must contain at most 200 character(s)',
    }] as never)
    mockCreate.mockRejectedValue(zerr)
    await expect(createFailureAction({ title: 'x'.repeat(400) })).resolves.toEqual({
      ok: false, error: 'String must contain at most 200 character(s)',
    })
  })

  it('NEVER leaks a raw database error', async () => {
    const raw = 'duplicate key value violates unique constraint "fi_no_key" DETAIL: Key (fi_no)=…'
    mockCreate.mockRejectedValue(new Error(raw))
    const res = await createFailureAction({ title: 'x' })
    expect(res).toEqual({ ok: false, error: GENERIC })
    expect(JSON.stringify(res)).not.toContain('constraint')
    expect(JSON.stringify(res)).not.toContain('fi_no')
  })
})

describe('happy path', () => {
  it('returns the service result under ok:true', async () => {
    mockCreate.mockResolvedValue({ id: 'f1', fiNo: 'FI-2026-0001' })
    await expect(createFailureAction({ title: 'Board fails burn-in' })).resolves.toEqual({
      ok: true, data: { id: 'f1', fiNo: 'FI-2026-0001' },
    })
    expect(mockCreate).toHaveBeenCalledWith(actor, { title: 'Board fails burn-in' })
  })
})
