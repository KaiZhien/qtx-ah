import { describe, it, expect, beforeEach, vi } from 'vitest'

const { listPresets, savePreset, deletePreset } = vi.hoisted(() => ({
  listPresets: vi.fn(),
  savePreset: vi.fn(),
  deletePreset: vi.fn(),
}))
vi.mock('@/lib/services/filterPresetService', () => ({ listPresets, savePreset, deletePreset }))

let currentUser: { id: string; role: string; email?: string } | null = null
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: () => Promise.resolve(currentUser) }))

const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidatePath(p) }))

import { listPresetsAction, savePresetAction, deletePresetAction } from '@/app/devices/presets/actions'

const VIEWER = { id: 'vwr-1', role: 'viewer', email: 'v@quantumtx.com' }
// system role has an EMPTY permission set — used to prove the gate is can()-based,
// not merely a null check (SAVE_FILTER_PRESET is held by all human roles incl. viewer).
const SYSTEM = { id: 'sys-1', role: 'system' }

beforeEach(() => {
  vi.clearAllMocks()
  currentUser = null
})

// Error convention: RESULT ({ error } / { ok } / { preset }); never throws.

describe('listPresetsAction', () => {
  it('returns [] when no user (auth-only gate, no can())', async () => {
    currentUser = null
    expect(await listPresetsAction()).toEqual([])
    expect(listPresets).not.toHaveBeenCalled()
  })

  it('delegates to listPresets(user.id) when authenticated', async () => {
    currentUser = VIEWER
    listPresets.mockResolvedValue([{ id: 'p1' }])
    const out = await listPresetsAction()
    expect(listPresets).toHaveBeenCalledWith('vwr-1')
    expect(out).toEqual([{ id: 'p1' }])
  })
})

describe('savePresetAction', () => {
  it('returns { error: Unauthorized } when no user', async () => {
    currentUser = null
    expect(await savePresetAction('n', 'q')).toEqual({ error: 'Unauthorized' })
  })

  it('returns { error: Unauthorized } for system role (empty permission set)', async () => {
    currentUser = SYSTEM
    expect(await savePresetAction('n', 'q')).toEqual({ error: 'Unauthorized' })
    expect(savePreset).not.toHaveBeenCalled()
  })

  it('viewer happy path: delegates, revalidates /devices, returns { preset }', async () => {
    currentUser = VIEWER
    savePreset.mockResolvedValue({ id: 'p9', name: 'n' })
    const out = await savePresetAction('n', 'status=x')
    expect(savePreset).toHaveBeenCalledWith('vwr-1', 'n', 'status=x', 'viewer')
    expect(revalidatePath).toHaveBeenCalledWith('/devices')
    expect(out).toEqual({ preset: { id: 'p9', name: 'n' } })
  })

  it('maps a thrown error to { error: message }', async () => {
    currentUser = VIEWER
    savePreset.mockRejectedValue(new Error('dup name'))
    expect(await savePresetAction('n', 'q')).toEqual({ error: 'dup name' })
  })
})

describe('deletePresetAction', () => {
  it('returns { error: Unauthorized } for system role', async () => {
    currentUser = SYSTEM
    expect(await deletePresetAction('p1')).toEqual({ error: 'Unauthorized' })
  })

  it('viewer happy path: delegates, revalidates, returns { ok: true }', async () => {
    currentUser = VIEWER
    deletePreset.mockResolvedValue(undefined)
    const out = await deletePresetAction('p1')
    expect(deletePreset).toHaveBeenCalledWith('p1', 'vwr-1', 'viewer')
    expect(revalidatePath).toHaveBeenCalledWith('/devices')
    expect(out).toEqual({ ok: true })
  })

  it('maps a thrown error to { error: message }', async () => {
    currentUser = VIEWER
    deletePreset.mockRejectedValue(new Error('not yours'))
    expect(await deletePresetAction('p1')).toEqual({ error: 'not yours' })
  })
})
