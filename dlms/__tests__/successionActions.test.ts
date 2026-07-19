import { describe, it, expect, beforeEach, vi } from 'vitest'

const { linkReplacement } = vi.hoisted(() => ({ linkReplacement: vi.fn() }))
vi.mock('@/lib/services/successionService', () => ({ linkReplacement }))

let currentUser: { id: string; role: string; email?: string } | null = null
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: () => Promise.resolve(currentUser) }))

const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidatePath(p) }))

import { linkReplacementAction } from '@/app/legacy/devices/[id]/succession/actions'

const ENGINEER = { id: 'eng-1', role: 'engineer', email: 'e@quantumtx.com' }
const VIEWER = { id: 'vwr-1', role: 'viewer', email: 'v@quantumtx.com' }

beforeEach(() => {
  vi.clearAllMocks()
  currentUser = null
})

// This action carries a belt-and-suspenders can(EDIT_DEVICE) gate at the action
// layer (restores the house convention); the service also enforces it in
// linkReplacement. Error convention: RESULT ({ ok } / { error }); never throws.

describe('linkReplacementAction', () => {
  it('returns { error: Unauthorized } when no user', async () => {
    currentUser = null
    expect(await linkReplacementAction('old', 'new', 1)).toEqual({ error: 'Unauthorized' })
    expect(linkReplacement).not.toHaveBeenCalled()
  })

  it('gates a viewer at the ACTION layer — the service is never called', async () => {
    currentUser = VIEWER
    const out = await linkReplacementAction('old', 'new', 1)
    expect(out).toEqual({ error: 'Unauthorized' })
    expect(linkReplacement).not.toHaveBeenCalled()
  })

  it('happy path: delegates then revalidates BOTH device detail paths', async () => {
    currentUser = ENGINEER
    linkReplacement.mockResolvedValue(undefined)
    const out = await linkReplacementAction('old-7', 'new-8', 3)
    expect(linkReplacement).toHaveBeenCalledWith('old-7', 'new-8', 3, 'eng-1', 'engineer')
    expect(revalidatePath).toHaveBeenCalledWith('/legacy/devices/old-7')
    expect(revalidatePath).toHaveBeenCalledWith('/legacy/devices/new-8')
    expect(out).toEqual({ ok: true })
  })

  it('maps a thrown service error to { error: message }', async () => {
    currentUser = ENGINEER
    linkReplacement.mockRejectedValue(new Error('already linked'))
    expect(await linkReplacementAction('old', 'new', 1)).toEqual({ error: 'already linked' })
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})
