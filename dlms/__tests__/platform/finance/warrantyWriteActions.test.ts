import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRequireAal2Actor = vi.fn()
const mockCreateWarranty = vi.fn()
const mockUpdateWarranty = vi.fn()
const mockRenewWarranty = vi.fn()
const mockRemoveWarranty = vi.fn()

vi.mock('@/modules/shared/auth/session', () => ({
  requireAal2Actor: mockRequireAal2Actor,
  MfaRequiredError: class MfaRequiredError extends Error {},
  UnauthenticatedError: class UnauthenticatedError extends Error {},
  SESSION_EXPIRED_MESSAGE: 'Your session has expired. Sign in again.',
}))
// Only the four entry points are doubled; the REAL error classes are kept
// (importActual is safe here — lib/db/pool creates its Pool lazily inside
// getPool(), so importing the service module opens nothing). That matters:
// DuplicateWarrantyError's whole job is carrying a sentence written for the
// user, and a stub class would let the action flatten it while the test still
// passed.
vi.mock('@/modules/finance/services/warrantyService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/modules/finance/services/warrantyService')>()),
  createWarranty: mockCreateWarranty,
  updateWarranty: mockUpdateWarranty,
  renewWarranty: mockRenewWarranty,
  removeWarranty: mockRemoveWarranty,
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const {
  createWarrantyAction, updateWarrantyAction, renewWarrantyAction, removeWarrantyAction,
} = await import('@/app/(platform)/finance/warranties/warrantyWriteActions')
const { WarrantyNotFoundError, DuplicateWarrantyError } =
  await import('@/modules/finance/services/warrantyService')
const { InvalidWarrantyPeriodError } = await import('@/modules/finance/domain/warrantyStatus')
const { OptimisticLockError } = await import('@/lib/db/tx')
const { PermissionError } = await import('@/modules/shared/authz/authorize')
const { MfaRequiredError } = await import('@/modules/shared/auth/session')

const ACTOR = {
  id: 'u1', roleKey: 'finance' as const,
  permissions: new Set(['manage_finance' as const]),
  moduleAccess: new Set(['finance' as const]), active: true,
}

const DEVICE = '11111111-1111-4111-8111-111111111111'
const WARRANTY = '22222222-2222-4222-8222-222222222222'

beforeEach(() => {
  mockRequireAal2Actor.mockReset().mockResolvedValue(ACTOR)
  mockCreateWarranty.mockReset()
  mockUpdateWarranty.mockReset()
  mockRenewWarranty.mockReset()
  mockRemoveWarranty.mockReset()
})

describe('createWarrantyAction', () => {
  it('returns the new warranty id when the service commits', async () => {
    mockCreateWarranty.mockResolvedValue({ warrantyId: WARRANTY })
    expect(await createWarrantyAction({
      deviceId: DEVICE, startDate: '2026-01-01', endDate: '2028-01-01',
    })).toEqual({ ok: true, data: { warrantyId: WARRANTY } })
  })

  it('explains the one-live-warranty rule instead of showing a constraint name', async () => {
    mockCreateWarranty.mockRejectedValue(new DuplicateWarrantyError(DEVICE))
    const res = await createWarrantyAction({
      deviceId: DEVICE, startDate: '2026-01-01', endDate: '2028-01-01',
    })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toMatch(/already has a live warranty/i)
  })

  it('passes the domain period refusal through verbatim — it is written for the user', async () => {
    mockCreateWarranty.mockRejectedValue(new InvalidWarrantyPeriodError(
      'end_before_start', 'The warranty end date must be on or after the start date.'))
    expect(await createWarrantyAction({
      deviceId: DEVICE, startDate: '2028-01-01', endDate: '2026-01-01',
    })).toEqual({ ok: false, error: 'The warranty end date must be on or after the start date.' })
  })

  it('never leaks a raw database error', async () => {
    mockCreateWarranty.mockRejectedValue(
      new Error('insert or update on table "warranty" violates foreign key constraint "warranty_device_id_fkey"'))
    const res = await createWarrantyAction({
      deviceId: DEVICE, startDate: '2026-01-01', endDate: '2028-01-01',
    })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).not.toMatch(/constraint|warranty_device_id_fkey/)
  })

  it('maps MfaRequiredError to the reload guidance, not a generic failure', async () => {
    // requireAal2Actor must be called INSIDE the try block, or this error escapes
    // unhandled — the exact regression __tests__/actionMfaMapping.test.ts exists for.
    mockRequireAal2Actor.mockRejectedValue(new MfaRequiredError())
    const res = await createWarrantyAction({
      deviceId: DEVICE, startDate: '2026-01-01', endDate: '2028-01-01',
    })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toMatch(/[Tt]wo-factor/)
  })

  it('maps a permission refusal without confirming anything about the record', async () => {
    mockCreateWarranty.mockRejectedValue(new PermissionError('manage_finance', 'finance'))
    expect(await createWarrantyAction({
      deviceId: DEVICE, startDate: '2026-01-01', endDate: '2028-01-01',
    })).toEqual({ ok: false, error: "You don't have permission to do that." })
  })
})

describe('updateWarrantyAction', () => {
  it('returns the bumped version on success', async () => {
    mockUpdateWarranty.mockResolvedValue({ version: 3 })
    expect(await updateWarrantyAction({ warrantyId: WARRANTY, version: 2, terms: 'x' }))
      .toEqual({ ok: true, data: { version: 3 } })
  })

  it('tells the user to reload on a concurrent edit', async () => {
    mockUpdateWarranty.mockRejectedValue(new OptimisticLockError('warranty', WARRANTY))
    const res = await updateWarrantyAction({ warrantyId: WARRANTY, version: 2 })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toMatch(/[Rr]eload/)
  })

  it('handles a warranty deleted out from under the form', async () => {
    mockUpdateWarranty.mockRejectedValue(new WarrantyNotFoundError(WARRANTY))
    const res = await updateWarrantyAction({ warrantyId: WARRANTY, version: 2 })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toMatch(/no longer exists/i)
  })
})

describe('renewWarrantyAction', () => {
  it('returns the successor warranty id', async () => {
    mockRenewWarranty.mockResolvedValue({ warrantyId: 'new-id' })
    expect(await renewWarrantyAction({
      warrantyId: WARRANTY, version: 1, startDate: '2028-01-01', endDate: '2030-01-01',
    })).toEqual({ ok: true, data: { warrantyId: 'new-id' } })
  })

  it('rejects an inverted renewal period with the domain message', async () => {
    mockRenewWarranty.mockRejectedValue(new InvalidWarrantyPeriodError(
      'end_before_start', 'The warranty end date must be on or after the start date.'))
    const res = await renewWarrantyAction({
      warrantyId: WARRANTY, version: 1, startDate: '2030-01-01', endDate: '2028-01-01',
    })
    expect(res).toEqual({
      ok: false, error: 'The warranty end date must be on or after the start date.',
    })
  })
})

describe('removeWarrantyAction', () => {
  it('reports success with no payload', async () => {
    mockRemoveWarranty.mockResolvedValue(undefined)
    expect(await removeWarrantyAction({ warrantyId: WARRANTY, version: 1 }))
      .toEqual({ ok: true, data: null })
  })

  it('maps a stale version to reload guidance', async () => {
    mockRemoveWarranty.mockRejectedValue(new OptimisticLockError('warranty', WARRANTY))
    const res = await removeWarrantyAction({ warrantyId: WARRANTY, version: 1 })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toMatch(/[Rr]eload/)
  })
})
