import { describe, it, expect, beforeEach, vi } from 'vitest'

const { promoteDraft, rejectDraft } = vi.hoisted(() => ({
  promoteDraft: vi.fn(),
  rejectDraft: vi.fn(),
}))
vi.mock('@/lib/services/draftService', () => ({ promoteDraft, rejectDraft }))

let currentUser: { id: string; role: string; email?: string } | null = null
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: () => Promise.resolve(currentUser) }))

const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidatePath(p) }))

import { promoteDraftAction, rejectDraftAction } from '@/app/legacy/drafts/actions'

const ENGINEER = { id: 'eng-1', role: 'engineer', email: 'e@quantumtx.com' }
const VIEWER = { id: 'vwr-1', role: 'viewer', email: 'v@quantumtx.com' }

beforeEach(() => {
  vi.clearAllMocks()
  currentUser = null
})

// Error convention for this file: THROWS Error('Unauthorized'); service errors propagate.

describe('promoteDraftAction', () => {
  it('throws Unauthorized when no user', async () => {
    currentUser = null
    await expect(promoteDraftAction('dr1')).rejects.toThrow('Unauthorized')
    expect(promoteDraft).not.toHaveBeenCalled()
  })

  it('throws Unauthorized for viewer (lacks confirm_draft)', async () => {
    currentUser = VIEWER
    await expect(promoteDraftAction('dr1')).rejects.toThrow('Unauthorized')
    expect(promoteDraft).not.toHaveBeenCalled()
  })

  it('engineer happy path: delegates, revalidates BOTH /drafts and /devices, returns device id', async () => {
    currentUser = ENGINEER
    promoteDraft.mockResolvedValue({ id: 'dev-77' })
    const out = await promoteDraftAction('dr1')
    expect(promoteDraft).toHaveBeenCalledWith('dr1', 'eng-1', 'engineer')
    expect(revalidatePath).toHaveBeenCalledWith('/legacy/drafts')
    expect(revalidatePath).toHaveBeenCalledWith('/legacy/devices')
    expect(out).toBe('dev-77')
  })

  it('propagates a service error (no result wrapping)', async () => {
    currentUser = ENGINEER
    promoteDraft.mockRejectedValue(new Error('draft already promoted'))
    await expect(promoteDraftAction('dr1')).rejects.toThrow('draft already promoted')
  })
})

describe('rejectDraftAction', () => {
  it('throws Unauthorized for viewer', async () => {
    currentUser = VIEWER
    await expect(rejectDraftAction('dr1')).rejects.toThrow('Unauthorized')
    expect(rejectDraft).not.toHaveBeenCalled()
  })

  it('engineer happy path: delegates + revalidates /drafts only', async () => {
    currentUser = ENGINEER
    rejectDraft.mockResolvedValue(undefined)
    await rejectDraftAction('dr1')
    expect(rejectDraft).toHaveBeenCalledWith('dr1', 'eng-1', 'engineer')
    expect(revalidatePath).toHaveBeenCalledWith('/legacy/drafts')
    expect(revalidatePath).not.toHaveBeenCalledWith('/legacy/devices')
  })
})
