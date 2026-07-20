import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRequireAal2Actor = vi.fn()
const mockReplace = vi.fn()
const mockInstall = vi.fn()
const mockAuthorize = vi.fn()
const mockWithTransaction = vi.fn()
vi.mock('@/modules/shared/auth/session', () => ({
  requireAal2Actor: mockRequireAal2Actor,
  MfaRequiredError: class MfaRequiredError extends Error {},
}))
vi.mock('@/modules/manufacturing/services/componentService', () => ({
  replaceComponentInstallation: mockReplace, installComponent: mockInstall,
}))
vi.mock('@/modules/manufacturing/domain/componentInstallation', () => ({
  InvalidReplacementError: class InvalidReplacementError extends Error {},
}))
vi.mock('@/modules/shared/authz/authorize', () => ({
  authorize: mockAuthorize,
  PermissionError: class PermissionError extends Error {},
}))
vi.mock('@/lib/db/tx', () => ({
  OptimisticLockError: class OptimisticLockError extends Error {},
  withTransaction: mockWithTransaction,
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const { replaceComponentAction, installComponentAction, listAvailableUnitsAction } = await import(
  '@/app/(platform)/manufacturing/devices/[id]/componentActions')

const ACTOR = { id: 'u1', roleKey: 'operator' as const, permissions: new Set(['edit_records' as const]),
  moduleAccess: new Set(['manufacturing' as const]), active: true }

beforeEach(() => {
  mockRequireAal2Actor.mockReset().mockResolvedValue(ACTOR)
  mockReplace.mockReset()
  mockInstall.mockReset()
  mockAuthorize.mockReset()
  mockWithTransaction.mockReset()
})

describe('replaceComponentAction', () => {
  it('reports success', async () => {
    mockReplace.mockResolvedValue({ closedId: 'a', newId: 'b', current: [] })
    expect(await replaceComponentAction('dev1', { removedInstallationId: 'i1', reason: 'x',
      replacementUnitId: 'u2' })).toEqual({ ok: true })
  })
  it('maps an invalid replacement to its message, not a raw error', async () => {
    const { InvalidReplacementError } = await import(
      '@/modules/manufacturing/domain/componentInstallation')
    mockReplace.mockRejectedValue(new InvalidReplacementError('The replacement cannot be the same unit being removed'))
    const res = await replaceComponentAction('dev1', { removedInstallationId: 'i1', reason: 'x',
      replacementUnitId: 'u1' })
    expect(res).toEqual({ ok: false, error: 'The replacement cannot be the same unit being removed' })
  })
  it('never leaks an internal DB error', async () => {
    mockReplace.mockRejectedValue(new Error('duplicate key value violates unique constraint "one_open_install"'))
    const res = await replaceComponentAction('dev1', { removedInstallationId: 'i1', reason: 'x',
      replacementUnitId: 'u2' })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).not.toContain('constraint')
  })
})

describe('installComponentAction', () => {
  it('never leaks an internal DB error', async () => {
    mockInstall.mockRejectedValue(new Error('duplicate key value violates unique constraint "component_unit_serial_no_key"'))
    const res = await installComponentAction('dev1', { componentTypeId: 't1', slotNo: 1, unitId: 'u1' })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).not.toContain('constraint')
  })
})

describe('listAvailableUnitsAction', () => {
  it('never leaks a raw DB error thrown by the query', async () => {
    mockWithTransaction.mockImplementation(async (_actorId: string, fn: (tx: unknown) => unknown) => fn({
      query: vi.fn().mockRejectedValue(new Error('invalid input syntax for type uuid: "nope"')),
    }))
    const res = await listAvailableUnitsAction('nope')
    expect(res).toEqual({ ok: false, error: 'Something went wrong. Try again, and tell Reet if it keeps happening.' })
    expect(JSON.stringify(res)).not.toContain('invalid input syntax')
  })
})
