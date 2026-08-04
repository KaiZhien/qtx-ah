import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'

/**
 * ECO server actions, and in particular the one that was MISSING.
 *
 * `requestEcoApproval` shipped in AP2 fully implemented, tested, templated and
 * registered — with no server action and no component. Nothing in the product
 * could raise an ECO approval request, so the engine's "requested ⇒ binding"
 * posture had no observable effect on Engineering at all and `/approvals` could
 * only ever contain invoice rows. This file pins the action that closes that,
 * and the error mapping it needs in order to be usable rather than merely present.
 */

const mockRequireAal2Actor = vi.fn()
const mockRequestEcoApproval = vi.fn()
const mockChangeEcoStatus = vi.fn()
const mockUpdateEco = vi.fn()
const mockCreateEco = vi.fn()

vi.mock('@/modules/shared/auth/session', () => ({
  requireAal2Actor: mockRequireAal2Actor,
  MfaRequiredError: class MfaRequiredError extends Error {},
  UnauthenticatedError: class UnauthenticatedError extends Error {},
  SESSION_EXPIRED_MESSAGE: 'Your session has expired. Sign in again.',
}))
// Only the entry points are doubled; the REAL error classes are kept, as
// warrantyWriteActions.test.ts does and for the same reason — importActual is
// safe because lib/db/pool builds its Pool lazily inside getPool(). It matters
// twice over here: EcoApprovalRequestError carries a sentence written for the
// user, and EcoApprovalError EXTENDS ApprovalGateError, so a stub class would
// silently break the `instanceof ApprovalGateError` arm the mapping relies on
// while the test went on passing.
vi.mock('@/modules/engineering/services/engineeringWriteService', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/modules/engineering/services/engineeringWriteService')>()),
  createEco: mockCreateEco,
  updateEco: mockUpdateEco,
  changeEcoStatus: mockChangeEcoStatus,
}))
vi.mock('@/modules/engineering/services/ecoService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/engineering/services/ecoService')>()),
  requestEcoApproval: mockRequestEcoApproval,
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const { requestEcoApprovalAction, changeEcoStatusAction } =
  await import('@/app/(platform)/engineering/eco/ecoActions')
const { MfaRequiredError, UnauthenticatedError } = await import('@/modules/shared/auth/session')
const { EcoApprovalRequestError, EcoApprovalError, EcoNotFoundError } =
  await import('@/modules/engineering/services/ecoService')
const { EcoScopeLockedError } = await import('@/modules/shared/approvals/domain/ecoApproval')
const { ApprovalAlreadyPendingError } =
  await import('@/modules/shared/approvals/services/approvalService')
const { OptimisticLockError } = await import('@/lib/db/tx')
const { PermissionError } = await import('@/modules/shared/authz/authorize')

const ACTOR = {
  id: 'u1', roleKey: 'operator' as const,
  permissions: new Set(['edit_records' as const]),
  moduleAccess: new Set(['engineering' as const]), active: true,
}
const ECO = '3f2a1b4c-0000-4000-8000-000000000001'

beforeEach(() => {
  mockRequireAal2Actor.mockReset().mockResolvedValue(ACTOR)
  mockRequestEcoApproval.mockReset()
  mockChangeEcoStatus.mockReset()
})

describe('requestEcoApprovalAction', () => {
  it('raises a request and returns its id', async () => {
    mockRequestEcoApproval.mockResolvedValue({ approvalId: 'a1' })
    expect(await requestEcoApprovalAction({ ecoId: ECO, version: 3 }))
      .toEqual({ ok: true, data: { approvalId: 'a1' } })
    expect(mockRequestEcoApproval).toHaveBeenCalledWith(ACTOR, { ecoId: ECO, version: 3 })
  })

  // The regression this project has shipped before: requireAal2Actor OUTSIDE the
  // try throws out of the action instead of returning a renderable result, and
  // actionAalPinning.test.ts only checks that the identifier appears in the file.
  it('returns a renderable result when the MFA gate refuses — never throws', async () => {
    mockRequireAal2Actor.mockRejectedValue(new MfaRequiredError())
    expect(await requestEcoApprovalAction({ ecoId: ECO, version: 3 })).toEqual({
      ok: false,
      error: 'Two-factor authentication required — reload the page to finish signing in.',
    })
  })

  it('returns the shared expiry line when the session has gone', async () => {
    mockRequireAal2Actor.mockRejectedValue(new UnauthenticatedError())
    expect(await requestEcoApprovalAction({ ecoId: ECO, version: 3 }))
      .toEqual({ ok: false, error: 'Your session has expired. Sign in again.' })
  })

  it('passes the status refusal through verbatim', async () => {
    // "Only a submitted ECO can be sent for approval … and this ECO is 'draft'."
    // IS the value of the refusal; flattening it discards the only actionable
    // sentence the service produced.
    const msg = 'Only a submitted ECO can be sent for approval — the approval gates the move '
      + 'from submitted to approved, and this ECO is "draft".'
    mockRequestEcoApproval.mockRejectedValue(new EcoApprovalRequestError(msg))
    expect(await requestEcoApprovalAction({ ecoId: ECO, version: 3 }))
      .toEqual({ ok: false, error: msg })
  })

  it('passes an ApprovalAlreadyPendingError through as guidance, not as a 500', async () => {
    // Expected traffic, not a bug: the honest double-click produces it.
    mockRequestEcoApproval.mockRejectedValue(new ApprovalAlreadyPendingError('eco', 'eco'))
    const res = await requestEcoApprovalAction({ ecoId: ECO, version: 3 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/already has a pending/i)
  })

  it('renders a ZodError as the field message rather than a generic failure', async () => {
    const zerr = new z.ZodError([{
      code: 'invalid_string', validation: 'uuid', path: ['ecoId'], message: 'Invalid uuid',
    } as never])
    mockRequestEcoApproval.mockRejectedValue(zerr)
    expect(await requestEcoApprovalAction({ ecoId: 'nope', version: 3 }))
      .toEqual({ ok: false, error: 'Invalid uuid' })
  })

  it('maps a stale version to the reload line', async () => {
    mockRequestEcoApproval.mockRejectedValue(new OptimisticLockError('eco', ECO))
    expect(await requestEcoApprovalAction({ ecoId: ECO, version: 1 }))
      .toEqual({ ok: false, error: 'Someone else changed this order. Reload and try again.' })
  })

  it('maps a deleted ECO to the reload line', async () => {
    mockRequestEcoApproval.mockRejectedValue(new EcoNotFoundError(ECO))
    expect(await requestEcoApprovalAction({ ecoId: ECO, version: 1 }))
      .toEqual({ ok: false, error: 'That change order no longer exists. Reload and try again.' })
  })

  it('maps a permission denial without naming the permission', async () => {
    mockRequestEcoApproval.mockRejectedValue(new PermissionError('edit_records', 'engineering'))
    expect(await requestEcoApprovalAction({ ecoId: ECO, version: 1 }))
      .toEqual({ ok: false, error: "You don't have permission to do that." })
  })

  it('sanitizes an unknown error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockRequestEcoApproval.mockRejectedValue(new Error('relation "approval" does not exist'))
    const res = await requestEcoApprovalAction({ ecoId: ECO, version: 1 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).not.toMatch(/relation/)
    spy.mockRestore()
  })
})

describe('the ECO gate refusals stay readable (AP3 mapping, re-pinned)', () => {
  it('passes an ApprovalGateError drift refusal through verbatim', async () => {
    const msg = 'this ECO cannot be approved: effectivitySerial: "0001-0015" → "0001-0900"'
    mockChangeEcoStatus.mockRejectedValue(new EcoApprovalError('approval_drifted', msg))
    expect(await changeEcoStatusAction({ id: ECO, version: 2, toStatus: 'approved' }))
      .toEqual({ ok: false, error: msg })
  })

  it('passes an EcoScopeLockedError through verbatim', async () => {
    const msg = 'This ECO is covered by an approval that has already been acted on.'
    mockChangeEcoStatus.mockRejectedValue(new EcoScopeLockedError(msg))
    expect(await changeEcoStatusAction({ id: ECO, version: 2, toStatus: 'implemented' }))
      .toEqual({ ok: false, error: msg })
  })
})
