import { describe, it, expect, beforeEach, vi } from 'vitest'

const { linkReplacement } = vi.hoisted(() => ({ linkReplacement: vi.fn() }))
vi.mock('@/lib/services/successionService', () => ({ linkReplacement }))

let currentUser: { id: string; role: string; email?: string } | null = null
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: () => Promise.resolve(currentUser) }))

const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidatePath(p) }))

import { linkReplacementAction } from '@/app/devices/[id]/succession/actions'

const ENGINEER = { id: 'eng-1', role: 'engineer', email: 'e@quantumtx.com' }
const VIEWER = { id: 'vwr-1', role: 'viewer', email: 'v@quantumtx.com' }

beforeEach(() => {
  vi.clearAllMocks()
  currentUser = null
})

// NOTE (discrepancy vs brief): this action has NO can() gate — only a null-user check.
// The role authorization is delegated entirely to linkReplacement in the service.
// Error convention: RESULT ({ ok } / { error }); never throws.

describe('linkReplacementAction', () => {
  it('returns { error: Unauthorized } when no user', async () => {
    currentUser = null
    expect(await linkReplacementAction('old', 'new', 1)).toEqual({ error: 'Unauthorized' })
    expect(linkReplacement).not.toHaveBeenCalled()
  })

  it('does NOT gate a viewer at the action layer — delegates to the service', async () => {
    currentUser = VIEWER
    linkReplacement.mockResolvedValue(undefined)
    const out = await linkReplacementAction('old', 'new', 1)
    expect(linkReplacement).toHaveBeenCalledWith('old', 'new', 1, 'vwr-1', 'viewer')
    expect(out).toEqual({ ok: true })
  })

  it('happy path: delegates then revalidates BOTH device detail paths', async () => {
    currentUser = ENGINEER
    linkReplacement.mockResolvedValue(undefined)
    const out = await linkReplacementAction('old-7', 'new-8', 3)
    expect(linkReplacement).toHaveBeenCalledWith('old-7', 'new-8', 3, 'eng-1', 'engineer')
    expect(revalidatePath).toHaveBeenCalledWith('/devices/old-7')
    expect(revalidatePath).toHaveBeenCalledWith('/devices/new-8')
    expect(out).toEqual({ ok: true })
  })

  it('maps a thrown service error to { error: message }', async () => {
    currentUser = ENGINEER
    linkReplacement.mockRejectedValue(new Error('already linked'))
    expect(await linkReplacementAction('old', 'new', 1)).toEqual({ error: 'already linked' })
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})
