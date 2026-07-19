import { describe, it, expect, beforeEach, vi } from 'vitest'

const { addStatusOption, addPhaseOption, toggleOptionActive } = vi.hoisted(() => ({
  addStatusOption: vi.fn(),
  addPhaseOption: vi.fn(),
  toggleOptionActive: vi.fn(),
}))
vi.mock('@/lib/services/vocabularyService', () => ({ addStatusOption, addPhaseOption, toggleOptionActive }))

let currentUser: { id: string; role: string; email?: string } | null = null
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: () => Promise.resolve(currentUser) }))

const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidatePath(p) }))

import {
  addStatusAction,
  addPhaseAction,
  toggleStatusActiveAction,
  togglePhaseActiveAction,
} from '@/app/legacy/admin/vocabularies/actions'

const ADMIN = { id: 'adm-1', role: 'admin', email: 'a@quantumtx.com' }
const ENGINEER = { id: 'eng-1', role: 'engineer', email: 'e@quantumtx.com' }

beforeEach(() => {
  vi.clearAllMocks()
  currentUser = null
})

// Error convention: THROWS Error('Unauthorized') (via adminCheck); no result wrapping.
// Gate: MANAGE_VOCABULARIES — admin only.

describe('addStatusAction', () => {
  it('throws Unauthorized when no user', async () => {
    currentUser = null
    await expect(addStatusAction('c', 'En', 'Zh')).rejects.toThrow('Unauthorized')
  })

  it('throws Unauthorized for engineer (lacks manage_vocabularies)', async () => {
    currentUser = ENGINEER
    await expect(addStatusAction('c', 'En', 'Zh')).rejects.toThrow('Unauthorized')
    expect(addStatusOption).not.toHaveBeenCalled()
  })

  it('admin: passes the terminal/initial flags object through to the service', async () => {
    currentUser = ADMIN
    addStatusOption.mockResolvedValue(undefined)
    await addStatusAction('shipped', 'Shipped', '已发货', { isTerminal: true, isInitial: false })
    expect(addStatusOption).toHaveBeenCalledWith(
      'shipped', 'Shipped', '已发货', 'adm-1', 'admin', { isTerminal: true, isInitial: false },
    )
    expect(revalidatePath).toHaveBeenCalledWith('/legacy/admin/vocabularies')
  })

  it('admin: forwards undefined flags when the argument is omitted', async () => {
    currentUser = ADMIN
    addStatusOption.mockResolvedValue(undefined)
    await addStatusAction('new', 'New', '新')
    expect(addStatusOption).toHaveBeenCalledWith('new', 'New', '新', 'adm-1', 'admin', undefined)
  })
})

describe('addPhaseAction', () => {
  it('throws Unauthorized for engineer', async () => {
    currentUser = ENGINEER
    await expect(addPhaseAction('c', 'En', 'Zh')).rejects.toThrow('Unauthorized')
  })

  it('admin: delegates + revalidates', async () => {
    currentUser = ADMIN
    addPhaseOption.mockResolvedValue(undefined)
    await addPhaseAction('assembly', 'Assembly', '组装')
    expect(addPhaseOption).toHaveBeenCalledWith('assembly', 'Assembly', '组装', 'adm-1', 'admin')
    expect(revalidatePath).toHaveBeenCalledWith('/legacy/admin/vocabularies')
  })
})

describe('toggleStatusActiveAction / togglePhaseActiveAction', () => {
  it('status toggle delegates with the status_option table tag', async () => {
    currentUser = ADMIN
    toggleOptionActive.mockResolvedValue(undefined)
    await toggleStatusActiveAction('shipped', false)
    expect(toggleOptionActive).toHaveBeenCalledWith('status_option', 'shipped', false, 'adm-1', 'admin')
    expect(revalidatePath).toHaveBeenCalledWith('/legacy/admin/vocabularies')
  })

  it('phase toggle delegates with the phase_option table tag', async () => {
    currentUser = ADMIN
    toggleOptionActive.mockResolvedValue(undefined)
    await togglePhaseActiveAction('assembly', true)
    expect(toggleOptionActive).toHaveBeenCalledWith('phase_option', 'assembly', true, 'adm-1', 'admin')
  })

  it('throws Unauthorized for engineer', async () => {
    currentUser = ENGINEER
    await expect(toggleStatusActiveAction('shipped', false)).rejects.toThrow('Unauthorized')
  })
})
