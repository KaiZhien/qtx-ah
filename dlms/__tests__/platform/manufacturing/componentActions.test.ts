import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRequireActor = vi.fn()
const mockReplace = vi.fn()
vi.mock('@/modules/shared/auth/session', () => ({ requireActor: mockRequireActor }))
vi.mock('@/modules/manufacturing/services/componentService', () => ({
  replaceComponentInstallation: mockReplace, installComponent: vi.fn(),
}))
vi.mock('@/modules/manufacturing/domain/componentInstallation', () => ({
  InvalidReplacementError: class InvalidReplacementError extends Error {},
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const { replaceComponentAction } = await import(
  '@/app/(platform)/manufacturing/devices/[id]/componentActions')

const ACTOR = { id: 'u1', roleKey: 'operator' as const, permissions: new Set(['edit_records' as const]),
  moduleAccess: new Set(['manufacturing' as const]), active: true }

beforeEach(() => { mockRequireActor.mockReset().mockResolvedValue(ACTOR); mockReplace.mockReset() })

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
