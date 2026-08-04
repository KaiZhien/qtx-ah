import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRequireAal2Actor = vi.fn()
const mockCreate = vi.fn()
const mockUpdate = vi.fn()
const mockChangeStatus = vi.fn()
const mockSignOff = vi.fn()

vi.mock('@/modules/shared/auth/session', () => ({
  requireAal2Actor: mockRequireAal2Actor,
  MfaRequiredError: class MfaRequiredError extends Error {},
}))
vi.mock('@/modules/maintenance/services/modificationService', () => ({
  createModification: mockCreate,
  updateModification: mockUpdate,
  changeModificationStatus: mockChangeStatus,
  signOffModification: mockSignOff,
  ModificationNotFoundError: class ModificationNotFoundError extends Error {},
  ModificationTerminalError: class ModificationTerminalError extends Error {
    status: string
    constructor(_id: string, status: string) {
      super(`A ${status} modification cannot be edited.`)
      this.status = status
    }
  },
  ModificationReferenceNotFoundError: class ModificationReferenceNotFoundError extends Error {
    reference: string
    referenceId: string
    constructor(reference: string, referenceId: string) {
      super(reference); this.reference = reference; this.referenceId = referenceId
    }
  },
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const {
  createModificationAction, updateModificationAction,
  changeModificationStatusAction, signOffModificationAction,
} = await import('@/app/(platform)/maintenance/modifications/actions')
const { MfaRequiredError } = await import('@/modules/shared/auth/session')
const {
  ModificationNotFoundError, ModificationReferenceNotFoundError, ModificationTerminalError,
} = await import('@/modules/maintenance/services/modificationService')
const {
  InvalidModificationTransitionError, ModificationSignOffError,
  messageForModificationSignOffError,
} = await import('@/modules/maintenance/domain/modificationStatus')
const { InvalidAttributionError } = await import('@/modules/maintenance/services/attributionService')
const { OptimisticLockError } = await import('@/lib/db/tx')
const { PermissionError } = await import('@/modules/shared/authz/authorize')

const ACTOR = {
  id: 'u1', roleKey: 'operator' as const,
  permissions: new Set(['create_records' as const, 'edit_records' as const]),
  moduleAccess: new Set(['maintenance' as const]), active: true,
}
const ID = '3f2a1b4c-0000-4000-8000-000000000001'
const DEVICE = '3f2a1b4c-0000-4000-8000-000000000002'
const TYPE = '3f2a1b4c-0000-4000-8000-000000000003'

beforeEach(() => {
  mockRequireAal2Actor.mockReset().mockResolvedValue(ACTOR)
  mockCreate.mockReset()
  mockUpdate.mockReset()
  mockChangeStatus.mockReset()
  mockSignOff.mockReset()
})

describe('createModificationAction', () => {
  it('raises a modification and returns its human reference', async () => {
    mockCreate.mockResolvedValue({ modificationId: ID, modificationNo: 'MOD-2026-0001' })
    const res = await createModificationAction({ deviceId: DEVICE, modificationTypeId: TYPE })
    expect(res).toEqual({ ok: true, data: { modificationId: ID, modificationNo: 'MOD-2026-0001' } })
  })

  // The regression this project has shipped before: requireAal2Actor OUTSIDE the
  // try throws out of the action instead of returning a renderable result, and
  // __tests__/actionAalPinning.test.ts only checks that the identifier appears.
  it('RETURNS a failure when the session is not AAL2 — it does not throw', async () => {
    mockRequireAal2Actor.mockRejectedValue(new MfaRequiredError())
    const res = await createModificationAction({ deviceId: DEVICE, modificationTypeId: TYPE })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toContain('Two-factor')
    expect(mockCreate).not.toHaveBeenCalled()
  })

  // Four references can go missing (device / modification_type / eco / repair)
  // and "something you linked no longer exists" is not actionable — the message
  // must name which one.
  it('names WHICH reference went missing', async () => {
    mockCreate.mockRejectedValue(new ModificationReferenceNotFoundError('device', DEVICE))
    const res = await createModificationAction({ deviceId: DEVICE, modificationTypeId: TYPE })
    expect((res as { error: string }).error).toContain('device')

    mockCreate.mockRejectedValue(new ModificationReferenceNotFoundError('modification_type', TYPE))
    const res2 = await createModificationAction({ deviceId: DEVICE, modificationTypeId: TYPE })
    // The underscore is rendered as a space rather than leaked raw.
    expect((res2 as { error: string }).error).toContain('modification type')
  })

  it('passes the same-device refusal through in the domain’s own words', async () => {
    mockCreate.mockRejectedValue(new InvalidAttributionError('repair', 'device_mismatch', 'r1'))
    const res = await createModificationAction({ deviceId: DEVICE, modificationTypeId: TYPE })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toContain('different device')
  })

  it('never leaks an internal error message', async () => {
    mockCreate.mockRejectedValue(new Error(
      'insert or update on table "modification" violates foreign key constraint "modification_device_id_fkey"'))
    const res = await createModificationAction({ deviceId: DEVICE, modificationTypeId: TYPE })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).not.toContain('constraint')
    expect((res as { error: string }).error).not.toContain('modification_device_id_fkey')
  })
})

describe('updateModificationAction', () => {
  it('returns the bumped version so the form can re-arm', async () => {
    mockUpdate.mockResolvedValue({ version: 3 })
    expect(await updateModificationAction({ modificationId: ID, version: 2 }))
      .toEqual({ ok: true, data: { version: 3 } })
  })

  it('explains a concurrent edit rather than failing opaquely', async () => {
    mockUpdate.mockRejectedValue(new OptimisticLockError('modification', ID))
    const res = await updateModificationAction({ modificationId: ID, version: 2 })
    expect(res).toEqual({
      ok: false, error: 'Someone else changed this modification. Reload and try again.',
    })
  })

  it('reports an unknown modification without confirming anything about it', async () => {
    mockUpdate.mockRejectedValue(new ModificationNotFoundError(ID))
    const res = await updateModificationAction({ modificationId: ID, version: 2 })
    expect(res).toEqual({
      ok: false, error: 'That modification no longer exists. Reload and try again.',
    })
  })

  // The page hides the edit form on a terminal record, but the action is
  // directly callable, so the refusal has to survive the UI being bypassed —
  // and it has to SAY the record is closed, because the likeliest cause is
  // someone signing it off in another tab.
  it('explains the terminal-state refusal in the service’s own words', async () => {
    mockUpdate.mockRejectedValue(new ModificationTerminalError(ID, 'closed'))
    const res = await updateModificationAction({ modificationId: ID, version: 2, costSgd: 5000 })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toContain('closed')
    expect((res as { error: string }).error).toContain('cannot be edited')
  })

  it('RETURNS a failure when the session is not AAL2', async () => {
    mockRequireAal2Actor.mockRejectedValue(new MfaRequiredError())
    const res = await updateModificationAction({ modificationId: ID, version: 2 })
    expect(res.ok).toBe(false)
    expect(mockUpdate).not.toHaveBeenCalled()
  })
})

describe('changeModificationStatusAction', () => {
  it('moves the modification and reports the new state', async () => {
    mockChangeStatus.mockResolvedValue({ status: 'approved', version: 2 })
    expect(await changeModificationStatusAction({
      modificationId: ID, toStatus: 'approved', version: 1 }))
      .toEqual({ ok: true, data: { status: 'approved', version: 2 } })
  })

  it('repeats the pure domain’s wording for a forbidden move', async () => {
    const message = 'Cannot move a modification from "Completed" to "Approved".'
    mockChangeStatus.mockRejectedValue(
      new InvalidModificationTransitionError('transition_forbidden', message))
    expect(await changeModificationStatusAction({
      modificationId: ID, toStatus: 'approved', version: 1 }))
      .toEqual({ ok: false, error: message })
  })

  it('repeats the domain’s wording for a missing cancellation note', async () => {
    const message = 'Cancelling a modification requires a reason.'
    mockChangeStatus.mockRejectedValue(
      new InvalidModificationTransitionError('note_required', message))
    expect(await changeModificationStatusAction({
      modificationId: ID, toStatus: 'cancelled', version: 1 }))
      .toEqual({ ok: false, error: message })
  })

  it('maps a permission failure to a fixed string', async () => {
    mockChangeStatus.mockRejectedValue(new PermissionError('edit_records', 'maintenance'))
    expect(await changeModificationStatusAction({
      modificationId: ID, toStatus: 'approved', version: 1 }))
      .toEqual({ ok: false, error: "You don't have permission to do that." })
  })

  it('RETURNS a failure when the session is not AAL2', async () => {
    mockRequireAal2Actor.mockRejectedValue(new MfaRequiredError())
    const res = await changeModificationStatusAction({
      modificationId: ID, toStatus: 'approved', version: 1 })
    expect(res.ok).toBe(false)
    expect(mockChangeStatus).not.toHaveBeenCalled()
  })
})

describe('signOffModificationAction', () => {
  it('closes the modification', async () => {
    mockSignOff.mockResolvedValue({ status: 'closed', version: 4 })
    expect(await signOffModificationAction({ modificationId: ID, version: 3 }))
      .toEqual({ ok: true, data: { status: 'closed' } })
  })

  it('repeats the sign-off precondition’s own wording', async () => {
    mockSignOff.mockRejectedValue(new ModificationSignOffError(
      'not_completed', messageForModificationSignOffError('not_completed')))
    const res = await signOffModificationAction({ modificationId: ID, version: 3 })
    expect(res).toEqual({
      ok: false, error: messageForModificationSignOffError('not_completed'),
    })
  })

  // sign_off_repairs, not a made-up sign_off_modifications — the catalogue has
  // no such permission, and the action must not leak which one was missing.
  it('maps a missing sign_off_repairs to the fixed permission string', async () => {
    mockSignOff.mockRejectedValue(new PermissionError('sign_off_repairs', 'maintenance'))
    const res = await signOffModificationAction({ modificationId: ID, version: 3 })
    expect(res).toEqual({ ok: false, error: "You don't have permission to do that." })
    expect((res as { error: string }).error).not.toContain('sign_off_repairs')
  })

  it('RETURNS a failure when the session is not AAL2', async () => {
    mockRequireAal2Actor.mockRejectedValue(new MfaRequiredError())
    const res = await signOffModificationAction({ modificationId: ID, version: 3 })
    expect(res.ok).toBe(false)
    expect(mockSignOff).not.toHaveBeenCalled()
  })
})
