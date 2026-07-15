import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AppError } from '@/lib/types'

const { updateUserRole, deactivateUser, reactivateUser } = vi.hoisted(() => ({
  updateUserRole: vi.fn(),
  deactivateUser: vi.fn(),
  reactivateUser: vi.fn(),
}))
vi.mock('@/lib/services/userService', () => ({ updateUserRole, deactivateUser, reactivateUser }))

let currentUser: { id: string; role: string; email?: string } | null = null
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: () => Promise.resolve(currentUser) }))

const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidatePath(p) }))

import { updateRoleAction, deactivateUserAction, reactivateUserAction } from '@/app/admin/users/actions'

const ADMIN = { id: 'adm-1', role: 'admin', email: 'a@quantumtx.com' }
const ENGINEER = { id: 'eng-1', role: 'engineer', email: 'e@quantumtx.com' }

beforeEach(() => {
  vi.clearAllMocks()
  currentUser = null
})

// All three actions share the same shape: MANAGE_USERS gate + toResult() error mapping.
// Error convention for this whole file: RESULT ({ error?: string }); never throws.

describe('updateRoleAction', () => {
  it('returns { error: Unauthorized } when no user (before try — no delegation)', async () => {
    currentUser = null
    expect(await updateRoleAction('u2', 'admin')).toEqual({ error: 'Unauthorized' })
    expect(updateUserRole).not.toHaveBeenCalled()
  })

  it('returns { error: Unauthorized } for engineer (lacks manage_users)', async () => {
    currentUser = ENGINEER
    expect(await updateRoleAction('u2', 'admin')).toEqual({ error: 'Unauthorized' })
    expect(updateUserRole).not.toHaveBeenCalled()
  })

  it('admin happy path: delegates, revalidates, returns {}', async () => {
    currentUser = ADMIN
    updateUserRole.mockResolvedValue(undefined)
    const out = await updateRoleAction('u2', 'engineer')
    expect(updateUserRole).toHaveBeenCalledWith('u2', 'engineer', 'adm-1', 'admin')
    expect(revalidatePath).toHaveBeenCalledWith('/admin/users')
    expect(out).toEqual({})
  })

  it('AppError → surfaces its message via toResult', async () => {
    currentUser = ADMIN
    updateUserRole.mockRejectedValue(
      new AppError({ type: 'permission', message: 'cannot demote last admin' }),
    )
    expect(await updateRoleAction('u2', 'engineer')).toEqual({ error: 'cannot demote last admin' })
    expect(revalidatePath).not.toHaveBeenCalled()
  })

  it('non-AppError → toResult returns the fallback string, not the raw message', async () => {
    currentUser = ADMIN
    updateUserRole.mockRejectedValue(new Error('raw pg error leak'))
    expect(await updateRoleAction('u2', 'engineer')).toEqual({ error: 'Failed to update role' })
  })
})

describe('deactivateUserAction', () => {
  it('returns { error: Unauthorized } for engineer', async () => {
    currentUser = ENGINEER
    expect(await deactivateUserAction('u2')).toEqual({ error: 'Unauthorized' })
  })

  it('admin happy path: delegates + revalidates + returns {}', async () => {
    currentUser = ADMIN
    deactivateUser.mockResolvedValue(undefined)
    const out = await deactivateUserAction('u2')
    expect(deactivateUser).toHaveBeenCalledWith('u2', 'adm-1', 'admin')
    expect(revalidatePath).toHaveBeenCalledWith('/admin/users')
    expect(out).toEqual({})
  })

  it('AppError → its message; fallback distinct per action', async () => {
    currentUser = ADMIN
    deactivateUser.mockRejectedValue(new AppError({ type: 'conflict', message: 'self-deactivate blocked' }))
    expect(await deactivateUserAction('u2')).toEqual({ error: 'self-deactivate blocked' })
    deactivateUser.mockRejectedValue(new Error('boom'))
    expect(await deactivateUserAction('u2')).toEqual({ error: 'Failed to deactivate user' })
  })
})

describe('reactivateUserAction', () => {
  it('returns { error: Unauthorized } for engineer', async () => {
    currentUser = ENGINEER
    expect(await reactivateUserAction('u2')).toEqual({ error: 'Unauthorized' })
  })

  it('admin happy path: delegates + revalidates + returns {}', async () => {
    currentUser = ADMIN
    reactivateUser.mockResolvedValue(undefined)
    const out = await reactivateUserAction('u2')
    expect(reactivateUser).toHaveBeenCalledWith('u2', 'adm-1', 'admin')
    expect(revalidatePath).toHaveBeenCalledWith('/admin/users')
    expect(out).toEqual({})
  })

  it('non-AppError → fallback "Failed to reactivate user"', async () => {
    currentUser = ADMIN
    reactivateUser.mockRejectedValue(new Error('x'))
    expect(await reactivateUserAction('u2')).toEqual({ error: 'Failed to reactivate user' })
  })
})
