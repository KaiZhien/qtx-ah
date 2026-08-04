import { describe, it, expect, vi, beforeEach } from 'vitest'
import { z } from 'zod'

/**
 * The repair half of the approvals engine's missing surface, plus the mapping
 * gap that made it worse than missing.
 *
 * `requestRepairSignOffApproval` shipped in AP2 with no server action and no
 * component, exactly like the ECO one. Maintenance ALSO mapped none of the
 * approval error classes: `RepairSignOffApprovalError extends ApprovalGateError`,
 * and `toMessage` matched neither — so the drift refusal built specifically to
 * tell a signer WHICH field moved reached them as "Something went wrong" plus a
 * spurious server error log. That refusal was already reachable before this
 * branch on any repair whose approval had been raised by other means, and it is
 * about to become reachable through a button.
 */

const mockRequireAal2Actor = vi.fn()
const mockCreateRepair = vi.fn()
const mockUpdateRepair = vi.fn()
const mockChangeRepairStatus = vi.fn()
const mockSignOffRepair = vi.fn()
const mockRequestApproval = vi.fn()

vi.mock('@/modules/shared/auth/session', () => ({
  requireAal2Actor: mockRequireAal2Actor,
  MfaRequiredError: class MfaRequiredError extends Error {},
  UnauthenticatedError: class UnauthenticatedError extends Error {},
  SESSION_EXPIRED_MESSAGE: 'Your session has expired. Sign in again.',
}))
// Entry points doubled, REAL error classes kept — see warrantyWriteActions.test.ts.
// Load-bearing here: RepairSignOffApprovalError extends ApprovalGateError, and a
// stub class would break the `instanceof` arm this file exists to pin while the
// test went on passing.
vi.mock('@/modules/maintenance/services/repairService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/maintenance/services/repairService')>()),
  createRepair: mockCreateRepair,
  updateRepair: mockUpdateRepair,
  changeRepairStatus: mockChangeRepairStatus,
  signOffRepair: mockSignOffRepair,
  requestRepairSignOffApproval: mockRequestApproval,
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const { requestRepairSignOffApprovalAction, signOffRepairAction } =
  await import('@/app/(platform)/maintenance/repairs/actions')
const { MfaRequiredError, UnauthenticatedError } = await import('@/modules/shared/auth/session')
const { RepairSignOffApprovalError, RepairSignOffRequestError, RepairNotFoundError } =
  await import('@/modules/maintenance/services/repairService')
const { ApprovalAlreadyPendingError } =
  await import('@/modules/shared/approvals/services/approvalService')
const { OptimisticLockError } = await import('@/lib/db/tx')
const { PermissionError } = await import('@/modules/shared/authz/authorize')

const ACTOR = {
  id: 'u1', roleKey: 'operator' as const,
  permissions: new Set(['edit_records' as const]),
  moduleAccess: new Set(['maintenance' as const]), active: true,
}
const REPAIR = '3f2a1b4c-0000-4000-8000-000000000009'

beforeEach(() => {
  mockRequireAal2Actor.mockReset().mockResolvedValue(ACTOR)
  mockRequestApproval.mockReset()
  mockSignOffRepair.mockReset()
})

describe('requestRepairSignOffApprovalAction', () => {
  it('raises a request and returns its id', async () => {
    mockRequestApproval.mockResolvedValue({ approvalId: 'a9' })
    expect(await requestRepairSignOffApprovalAction({ repairId: REPAIR, version: 4 }))
      .toEqual({ ok: true, data: { approvalId: 'a9' } })
    expect(mockRequestApproval).toHaveBeenCalledWith(ACTOR, { repairId: REPAIR, version: 4 })
  })

  it('returns a renderable result when the MFA gate refuses — never throws', async () => {
    mockRequireAal2Actor.mockRejectedValue(new MfaRequiredError())
    expect(await requestRepairSignOffApprovalAction({ repairId: REPAIR, version: 4 })).toEqual({
      ok: false,
      error: 'Two-factor authentication required — reload the page to finish signing in.',
    })
  })

  it('returns the shared expiry line when the session has gone', async () => {
    mockRequireAal2Actor.mockRejectedValue(new UnauthenticatedError())
    expect(await requestRepairSignOffApprovalAction({ repairId: REPAIR, version: 4 }))
      .toEqual({ ok: false, error: 'Your session has expired. Sign in again.' })
  })

  it('passes the status refusal through verbatim', async () => {
    const msg = 'Only a repair that is awaiting sign-off can be sent for sign-off approval — '
      + 'the approval gates the move to closed, and this repair is "in_diagnosis".'
    mockRequestApproval.mockRejectedValue(new RepairSignOffRequestError(msg))
    expect(await requestRepairSignOffApprovalAction({ repairId: REPAIR, version: 4 }))
      .toEqual({ ok: false, error: msg })
  })

  it('passes an ApprovalAlreadyPendingError through as guidance, not as a 500', async () => {
    mockRequestApproval.mockRejectedValue(
      new ApprovalAlreadyPendingError('repair_signoff', 'repair_signoff'))
    const res = await requestRepairSignOffApprovalAction({ repairId: REPAIR, version: 4 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).toMatch(/already has a pending/i)
  })

  it('renders a ZodError as the field message rather than a generic failure', async () => {
    const zerr = new z.ZodError([{
      code: 'invalid_string', validation: 'uuid', path: ['repairId'], message: 'Invalid uuid',
    } as never])
    mockRequestApproval.mockRejectedValue(zerr)
    expect(await requestRepairSignOffApprovalAction({ repairId: 'nope', version: 4 }))
      .toEqual({ ok: false, error: 'Invalid uuid' })
  })

  it('maps a stale version to the reload line', async () => {
    mockRequestApproval.mockRejectedValue(new OptimisticLockError('repair', REPAIR))
    expect(await requestRepairSignOffApprovalAction({ repairId: REPAIR, version: 1 }))
      .toEqual({ ok: false, error: 'Someone else changed this repair. Reload and try again.' })
  })

  it('maps a deleted repair to the reload line', async () => {
    mockRequestApproval.mockRejectedValue(new RepairNotFoundError(REPAIR))
    expect(await requestRepairSignOffApprovalAction({ repairId: REPAIR, version: 1 }))
      .toEqual({ ok: false, error: 'That repair no longer exists. Reload and try again.' })
  })

  it('maps a permission denial without naming the permission', async () => {
    mockRequestApproval.mockRejectedValue(new PermissionError('edit_records', 'maintenance'))
    expect(await requestRepairSignOffApprovalAction({ repairId: REPAIR, version: 1 }))
      .toEqual({ ok: false, error: "You don't have permission to do that." })
  })

  it('sanitizes an unknown error', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockRequestApproval.mockRejectedValue(new Error('relation "approval" does not exist'))
    const res = await requestRepairSignOffApprovalAction({ repairId: REPAIR, version: 1 })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).not.toMatch(/relation/)
    spy.mockRestore()
  })
})

describe('the sign-off gate refusal is readable — it was NOT before this branch', () => {
  it('passes a drift refusal through verbatim instead of flattening it', async () => {
    // The whole point of the snapshot gate is that it names what moved:
    // recordedReplacementCount 1 → 2 means the approver reviewed one board swap
    // and is being asked to authorise two. Flattened, the signer is told nothing.
    const msg = 'this repair cannot be signed off: recordedReplacementCount: "1" → "2"'
    mockSignOffRepair.mockRejectedValue(new RepairSignOffApprovalError('approval_drifted', msg))
    expect(await signOffRepairAction({ repairId: REPAIR, version: 4 }))
      .toEqual({ ok: false, error: msg })
  })

  it('does not log a drift refusal as a server error', async () => {
    // A refusal the system meant to make is not a fault. Logging it at ERROR
    // trains whoever reads the logs to ignore the level.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockSignOffRepair.mockRejectedValue(
      new RepairSignOffApprovalError('approval_rejected', 'this repair cannot be signed off: rejected'))
    await signOffRepairAction({ repairId: REPAIR, version: 4 })
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
