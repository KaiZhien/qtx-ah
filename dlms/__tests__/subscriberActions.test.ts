import { describe, it, expect, beforeEach, vi } from 'vitest'

const { addSubscriber, setSubscriberActive, deleteSubscriber } = vi.hoisted(() => ({
  addSubscriber: vi.fn(),
  setSubscriberActive: vi.fn(),
  deleteSubscriber: vi.fn(),
}))
vi.mock('@/lib/services/reportSubscriberService', () => ({ addSubscriber, setSubscriberActive, deleteSubscriber }))

let currentUser: { id: string; role: string; email?: string } | null = null
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: () => Promise.resolve(currentUser) }))

const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidatePath(p) }))

import { addSubscriberAction, toggleSubscriberAction, deleteSubscriberAction } from '@/app/legacy/admin/subscribers/actions'

const ADMIN = { id: 'adm-1', role: 'admin', email: 'a@quantumtx.com' }
const ENGINEER = { id: 'eng-1', role: 'engineer', email: 'e@quantumtx.com' }

beforeEach(() => {
  vi.clearAllMocks()
  currentUser = null
})

// Error convention: THROWS (via adminCheck, MANAGE_USERS). These services take (…, role)
// WITHOUT the actor id — assert the exact 2/3-arg shape.

describe('addSubscriberAction', () => {
  it('throws Unauthorized when no user', async () => {
    currentUser = null
    await expect(addSubscriberAction('x@quantumtx.com')).rejects.toThrow('Unauthorized')
  })

  it('throws Unauthorized for engineer (lacks manage_users)', async () => {
    currentUser = ENGINEER
    await expect(addSubscriberAction('x@quantumtx.com')).rejects.toThrow('Unauthorized')
    expect(addSubscriber).not.toHaveBeenCalled()
  })

  it('admin: delegates with (email, role) — no actor id — and revalidates', async () => {
    currentUser = ADMIN
    addSubscriber.mockResolvedValue(undefined)
    await addSubscriberAction('x@quantumtx.com')
    expect(addSubscriber).toHaveBeenCalledWith('x@quantumtx.com', 'admin')
    expect(revalidatePath).toHaveBeenCalledWith('/legacy/admin/subscribers')
  })
})

describe('toggleSubscriberAction', () => {
  it('throws Unauthorized for engineer', async () => {
    currentUser = ENGINEER
    await expect(toggleSubscriberAction('s1', false)).rejects.toThrow('Unauthorized')
  })

  it('admin: delegates (id, active, role) + revalidates', async () => {
    currentUser = ADMIN
    setSubscriberActive.mockResolvedValue(undefined)
    await toggleSubscriberAction('s1', false)
    expect(setSubscriberActive).toHaveBeenCalledWith('s1', false, 'admin')
    expect(revalidatePath).toHaveBeenCalledWith('/legacy/admin/subscribers')
  })
})

describe('deleteSubscriberAction', () => {
  it('throws Unauthorized for engineer', async () => {
    currentUser = ENGINEER
    await expect(deleteSubscriberAction('s1')).rejects.toThrow('Unauthorized')
  })

  it('admin: delegates (id, role) + revalidates', async () => {
    currentUser = ADMIN
    deleteSubscriber.mockResolvedValue(undefined)
    await deleteSubscriberAction('s1')
    expect(deleteSubscriber).toHaveBeenCalledWith('s1', 'admin')
    expect(revalidatePath).toHaveBeenCalledWith('/legacy/admin/subscribers')
  })
})
