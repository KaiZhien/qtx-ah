import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRequireAal2Actor = vi.fn()
const mockChangeTaskStatus = vi.fn()

vi.mock('@/modules/shared/auth/session', () => ({
  requireAal2Actor: mockRequireAal2Actor,
  MfaRequiredError: class MfaRequiredError extends Error {},
}))
vi.mock('@/modules/shared/tasks/services/taskService', () => ({
  changeTaskStatus: mockChangeTaskStatus,
  TaskNotFoundError: class TaskNotFoundError extends Error {},
  InvalidTransitionError: class InvalidTransitionError extends Error {},
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const { changeStatusAction } = await import('@/app/(platform)/tasks/actions')

const ACTOR = {
  id: 'u1', roleKey: 'operator' as const,
  permissions: new Set(['edit_records' as const]),
  moduleAccess: new Set(['tasks' as const]), active: true,
}

beforeEach(() => {
  mockRequireAal2Actor.mockReset().mockResolvedValue(ACTOR)
  mockChangeTaskStatus.mockReset()
})

describe('changeStatusAction', () => {
  it('reports success when the service commits', async () => {
    mockChangeTaskStatus.mockResolvedValue(undefined)
    expect(await changeStatusAction('t1', 'in_progress', 3)).toEqual({ ok: true })
  })

  it('turns a concurrency clash into words a user can act on', async () => {
    const { OptimisticLockError } = await import('@/lib/db/tx')
    mockChangeTaskStatus.mockRejectedValue(new OptimisticLockError('task', 't1'))
    const res = await changeStatusAction('t1', 'in_progress', 2)
    expect(res).toEqual({
      ok: false,
      error: 'Someone else changed this task. Reload the page and try again.',
    })
  })

  it('never leaks an internal error message to the user', async () => {
    mockChangeTaskStatus.mockRejectedValue(new Error('duplicate key value violates unique constraint "x"'))
    const res = await changeStatusAction('t1', 'in_progress', 2)
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).not.toContain('constraint')
  })
})
