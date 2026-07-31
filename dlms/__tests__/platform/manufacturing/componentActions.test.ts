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
// Stand-in for the real class: same 3-arg signature, and a message derived from
// the arguments so the assertion below pins "the action surfaces err.message"
// without restating the real wording (which repairStatus/attribution own).
vi.mock('@/modules/maintenance/services/attributionService', () => ({
  InvalidAttributionError: class InvalidAttributionError extends Error {
    constructor(kind: string, code: string, _attributionId: string) {
      super(`${kind}:${code}`)
      this.name = 'InvalidAttributionError'
    }
  },
}))
vi.mock('@/modules/shared/authz/authorize', () => ({
  authorize: mockAuthorize,
  PermissionError: class PermissionError extends Error {},
}))
vi.mock('@/lib/db/tx', () => ({
  OptimisticLockError: class OptimisticLockError extends Error {},
  withTransaction: mockWithTransaction,
}))
const mockRevalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath: mockRevalidatePath }))

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
  mockRevalidatePath.mockReset()
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

  it('maps a cross-device attribution to its own message, not the generic one', async () => {
    const { InvalidAttributionError } = await import(
      '@/modules/maintenance/services/attributionService')
    mockReplace.mockRejectedValue(
      new InvalidAttributionError('repair', 'device_mismatch', 'r-elsewhere'))
    const res = await replaceComponentAction('dev1', { removedInstallationId: 'i1', reason: 'x',
      replacementUnitId: 'u2', repairId: 'r-elsewhere' })
    expect(res).toEqual({ ok: false, error: 'repair:device_mismatch' })
  })

  // The attributed record's page shows the same component set, so it has to be
  // revalidated too — derived from the INPUT, never a path the client passes.
  it('revalidates the attributed repair / modification page as well as the device', async () => {
    mockReplace.mockResolvedValue({ closedId: 'a', newId: 'b', current: [] })
    await replaceComponentAction('dev1', { removedInstallationId: 'i1', reason: 'x',
      replacementUnitId: 'u2', repairId: 'r1' })
    expect(mockRevalidatePath.mock.calls.flat()).toEqual(
      expect.arrayContaining(['/manufacturing/devices/dev1', '/maintenance/repairs/r1']))

    mockRevalidatePath.mockReset()
    await replaceComponentAction('dev1', { removedInstallationId: 'i1', reason: 'x',
      replacementUnitId: 'u2', modificationId: 'm1' })
    expect(mockRevalidatePath.mock.calls.flat()).toEqual(
      expect.arrayContaining(['/maintenance/modifications/m1']))
  })

  it('revalidates only the device page for an unattributed replacement', async () => {
    mockReplace.mockResolvedValue({ closedId: 'a', newId: 'b', current: [] })
    await replaceComponentAction('dev1', { removedInstallationId: 'i1', reason: 'x',
      replacementUnitId: 'u2' })
    expect(mockRevalidatePath.mock.calls).toEqual([['/manufacturing/devices/dev1']])
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
