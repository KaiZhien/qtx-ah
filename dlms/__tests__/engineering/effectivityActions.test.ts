import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// BOM-effectivity action layer: same sanitization contract as failureActions.
// The apply step's refusals ("not implemented yet", "no effectivity point") are
// operator-actionable, so they pass through verbatim; everything unrecognised
// becomes the generic message and the raw text never reaches the browser.
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

const mockAdd = vi.fn()
const mockRemove = vi.fn()
const mockApply = vi.fn()

vi.mock('@/modules/engineering/services/bomEffectivityService', () => ({
  addAffectedItem: (...a: unknown[]) => mockAdd(...a),
  removeAffectedItem: (...a: unknown[]) => mockRemove(...a),
  applyEcoEffectivity: (...a: unknown[]) => mockApply(...a),
  BomEcoNotFoundError: class BomEcoNotFoundError extends Error {},
  BomApplyError: class BomApplyError extends Error {},
  AffectedItemNotFoundError: class AffectedItemNotFoundError extends Error {},
  AffectedItemLockedError: class AffectedItemLockedError extends Error {},
  DuplicateAffectedItemError: class DuplicateAffectedItemError extends Error {},
}))

const {
  addAffectedItemAction, applyEcoEffectivityAction,
} = await import('@/app/(platform)/engineering/bom/effectivityActions')
const { MfaRequiredError } = await import('@/modules/shared/auth/session')
const {
  BomApplyError, AffectedItemLockedError, DuplicateAffectedItemError,
} = await import('@/modules/engineering/services/bomEffectivityService')

const MFA_MESSAGE = 'Two-factor authentication required — reload the page to finish signing in.'
const GENERIC = 'Something went wrong. Try again, and tell Reet if it keeps happening.'
const actor = { id: 'u1' }
const ITEM = {
  ecoId: 'e1', variantId: 'v1', componentTypeId: 'c1',
  disposition: 'change' as const, quantity: 2,
}

beforeEach(() => {
  vi.clearAllMocks()
  mockRequireAal2Actor.mockResolvedValue(actor)
})

describe('AAL2 guard placement', () => {
  it('resolves to the friendly MFA error instead of rejecting', async () => {
    mockRequireAal2Actor.mockRejectedValue(new MfaRequiredError())
    await expect(applyEcoEffectivityAction({ ecoId: 'e1' })).resolves.toEqual({
      ok: false, error: MFA_MESSAGE,
    })
    expect(mockApply).not.toHaveBeenCalled()
  })
})

describe('error sanitization', () => {
  it('passes an apply refusal through verbatim', async () => {
    const msg = 'A change order must be implemented before its BOM changes can be applied.'
    mockApply.mockRejectedValue(new BomApplyError(msg))
    await expect(applyEcoEffectivityAction({ ecoId: 'e1' })).resolves.toEqual({
      ok: false, error: msg,
    })
  })

  it('passes the frozen-list and duplicate refusals through verbatim', async () => {
    mockAdd.mockRejectedValue(new AffectedItemLockedError('already applied'))
    await expect(addAffectedItemAction(ITEM)).resolves.toEqual({
      ok: false, error: 'already applied',
    })

    mockAdd.mockRejectedValue(new DuplicateAffectedItemError('already listed'))
    await expect(addAffectedItemAction(ITEM)).resolves.toEqual({
      ok: false, error: 'already listed',
    })
  })

  it('NEVER leaks a raw database error', async () => {
    const raw = 'duplicate key value violates unique constraint "bom_line_open_unique"'
    mockApply.mockRejectedValue(new Error(raw))
    const res = await applyEcoEffectivityAction({ ecoId: 'e1' })
    expect(res).toEqual({ ok: false, error: GENERIC })
    expect(JSON.stringify(res)).not.toContain('bom_line_open_unique')
  })
})

describe('happy path', () => {
  it('returns the apply report so the UI can say what changed', async () => {
    mockApply.mockResolvedValue({
      ecoId: 'e1', itemsApplied: 2, linesOpened: 1, linesClosed: 2, alreadyApplied: false,
    })
    await expect(applyEcoEffectivityAction({ ecoId: 'e1' })).resolves.toEqual({
      ok: true,
      data: { ecoId: 'e1', itemsApplied: 2, linesOpened: 1, linesClosed: 2, alreadyApplied: false },
    })
  })

  it('reports an idempotent re-apply as already applied rather than erroring', async () => {
    mockApply.mockResolvedValue({
      ecoId: 'e1', itemsApplied: 0, linesOpened: 0, linesClosed: 0, alreadyApplied: true,
    })
    const res = await applyEcoEffectivityAction({ ecoId: 'e1' })
    expect(res.ok).toBe(true)
    expect(res.ok && res.data.alreadyApplied).toBe(true)
  })
})
