import { describe, it, expect, beforeEach, vi } from 'vitest'

const { getStatuses, getPhases, previewCsvRows, importValidRows, previewExcelBuffer } = vi.hoisted(() => ({
  getStatuses: vi.fn(),
  getPhases: vi.fn(),
  previewCsvRows: vi.fn(),
  importValidRows: vi.fn(),
  previewExcelBuffer: vi.fn(),
}))
vi.mock('@/lib/services/vocabularyService', () => ({ getStatuses, getPhases }))
vi.mock('@/lib/services/importService', () => ({ previewCsvRows, importValidRows }))
vi.mock('@/lib/services/excelImportService', () => ({ previewExcelBuffer }))

let currentUser: { id: string; role: string; email?: string } | null = null
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: () => Promise.resolve(currentUser) }))

const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidatePath(p) }))

import { previewImportAction, importAction, previewExcelAction } from '@/app/legacy/import/actions'

const ENGINEER = { id: 'eng-1', role: 'engineer', email: 'e@quantumtx.com' }
const VIEWER = { id: 'vwr-1', role: 'viewer', email: 'v@quantumtx.com' }

beforeEach(() => {
  vi.clearAllMocks()
  currentUser = null
  getStatuses.mockResolvedValue([{ code: 's1' }, { code: 's2' }])
  getPhases.mockResolvedValue([{ code: 'p1' }])
})

// Error convention: THROWS Error('Unauthorized'); service errors propagate.

describe('previewImportAction', () => {
  it('throws Unauthorized when no user', async () => {
    currentUser = null
    await expect(previewImportAction([])).rejects.toThrow('Unauthorized')
  })

  it('throws Unauthorized for viewer (lacks import_data)', async () => {
    currentUser = VIEWER
    await expect(previewImportAction([])).rejects.toThrow('Unauthorized')
    expect(previewCsvRows).not.toHaveBeenCalled()
  })

  it('engineer: passes mapped status/phase codes into previewCsvRows', async () => {
    currentUser = ENGINEER
    const rows = [{ a: '1' }]
    previewCsvRows.mockReturnValue([{ rowIndex: 0 }])
    const out = await previewImportAction(rows)
    expect(previewCsvRows).toHaveBeenCalledWith(rows, ['s1', 's2'], ['p1'])
    expect(out).toEqual([{ rowIndex: 0 }])
  })
})

describe('importAction', () => {
  it('throws Unauthorized for viewer', async () => {
    currentUser = VIEWER
    await expect(importAction([])).rejects.toThrow('Unauthorized')
  })

  it('engineer: delegates to importValidRows, revalidates /devices, returns the result', async () => {
    currentUser = ENGINEER
    const rows = [{ rowIndex: 0, raw: {}, valid: true }] as never
    const result = { imported: 1, skippedInvalid: 0, skippedDuplicate: 0, failed: [] }
    importValidRows.mockResolvedValue(result)
    const out = await importAction(rows)
    expect(importValidRows).toHaveBeenCalledWith(rows, 'eng-1', 'engineer')
    expect(revalidatePath).toHaveBeenCalledWith('/legacy/devices')
    expect(out).toBe(result)
  })
})

describe('previewExcelAction', () => {
  it('throws Unauthorized for viewer', async () => {
    currentUser = VIEWER
    await expect(previewExcelAction(new Uint8Array())).rejects.toThrow('Unauthorized')
  })

  it('engineer: passes the underlying ArrayBuffer + mapped codes to previewExcelBuffer', async () => {
    currentUser = ENGINEER
    const bytes = new Uint8Array([1, 2, 3])
    previewExcelBuffer.mockResolvedValue([{ rowIndex: 0 }])
    const out = await previewExcelAction(bytes)
    expect(previewExcelBuffer).toHaveBeenCalledWith(bytes.buffer, ['s1', 's2'], ['p1'])
    expect(out).toEqual([{ rowIndex: 0 }])
  })
})
