import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AppError } from '@/lib/types'

// --- Service mocks (assert delegation args) ---
// vi.hoisted so the mock factories can reference the fns at hoist time.
const {
  createDevice, updateDevice, changeStatus, softDeleteDevice, restoreDevice,
  getDevice, getDeviceByPcbaSn, assignDevice, unassignDevice, addServiceEvent,
} = vi.hoisted(() => ({
  createDevice: vi.fn(),
  updateDevice: vi.fn(),
  changeStatus: vi.fn(),
  softDeleteDevice: vi.fn(),
  restoreDevice: vi.fn(),
  getDevice: vi.fn(),
  getDeviceByPcbaSn: vi.fn(),
  assignDevice: vi.fn(),
  unassignDevice: vi.fn(),
  addServiceEvent: vi.fn(),
}))
vi.mock('@/lib/services/deviceService', () => ({
  createDevice, updateDevice, changeStatus, softDeleteDevice, restoreDevice,
  getDevice, getDeviceByPcbaSn,
}))
vi.mock('@/lib/services/assignmentService', () => ({ assignDevice, unassignDevice }))
vi.mock('@/lib/services/serviceEventService', () => ({ addServiceEvent }))

// --- Auth session mock (reassignable current user) ---
type MockUser = { id: string; role: string; email?: string } | null
let currentUser: MockUser = null
vi.mock('@/lib/auth/session', () => ({
  getCurrentUser: () => Promise.resolve(currentUser),
}))

// --- next/cache + next/navigation ---
const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidatePath(p) }))

const redirect = vi.fn((url: string): never => {
  throw new Error(`NEXT_REDIRECT:${url}`)
})
vi.mock('next/navigation', () => ({ redirect: (url: string) => redirect(url) }))

// permissions.ts stays REAL — role gates are pinned with actual role logic.

import {
  createDeviceBatchAction,
  updateDeviceAction,
  softDeleteAction,
  restoreDeviceAction,
  createDeviceRowAction,
  updateDeviceRowAction,
  bulkChangeStatusAction,
  bulkSoftDeleteAction,
  assignDeviceAction,
  unassignDeviceAction,
  addServiceEventAction,
} from '@/app/legacy/devices/actions'
import type { DeviceInput } from '@/lib/types'

const ENGINEER = { id: 'eng-1', role: 'engineer', email: 'e@quantumtx.com' }
const ADMIN = { id: 'adm-1', role: 'admin', email: 'a@quantumtx.com' }
const VIEWER = { id: 'vwr-1', role: 'viewer', email: 'v@quantumtx.com' }

const baseInput = (over: Partial<DeviceInput> = {}): DeviceInput => ({
  pcba_a_sn: 'DEV100',
  pcba_a_hw_rev: 'A',
  pcba_a_bom_rev: 'B',
  pcba_a_fw_ver: '1.0',
  status: 'in_progress',
  phase: 'assembly',
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  currentUser = null
})

// ---------------------------------------------------------------------------
// createDeviceBatchAction — range branching (highest-value orchestration).
// Convention: THROWS. Redirect path differs single vs range.
// ---------------------------------------------------------------------------
describe('createDeviceBatchAction', () => {
  it('throws Unauthorized when no user', async () => {
    currentUser = null
    await expect(createDeviceBatchAction(baseInput())).rejects.toThrow('Unauthorized')
    expect(createDevice).not.toHaveBeenCalled()
  })

  it('throws Unauthorized for viewer (lacks create_device)', async () => {
    currentUser = VIEWER
    await expect(createDeviceBatchAction(baseInput())).rejects.toThrow('Unauthorized')
    expect(createDevice).not.toHaveBeenCalled()
  })

  it('single unit: creates one device, revalidates, redirects to detail page', async () => {
    currentUser = ENGINEER
    createDevice.mockResolvedValue({ id: 'dev-single' })
    await expect(
      createDeviceBatchAction(baseInput({ pcba_a_sn: 'dev100', pcba_b_sn: null })),
    ).rejects.toThrow('NEXT_REDIRECT:/legacy/devices/dev-single')

    expect(createDevice).toHaveBeenCalledTimes(1)
    expect(createDevice).toHaveBeenCalledWith(
      { ...baseInput({ pcba_a_sn: 'DEV100', pcba_b_sn: null }), qty: 1 },
      'eng-1',
      'engineer',
    )
    expect(revalidatePath).toHaveBeenCalledWith('/legacy/devices')
    expect(redirect).toHaveBeenCalledWith('/legacy/devices/dev-single')
  })

  it('range: expands "DEV100 to 102" into 3 devices then redirects with count', async () => {
    currentUser = ENGINEER
    createDevice.mockResolvedValue({ id: 'ignored' })
    await expect(
      createDeviceBatchAction(baseInput({ pcba_a_sn: 'DEV100 to 102', pcba_b_sn: null })),
    ).rejects.toThrow('NEXT_REDIRECT:/legacy/devices?batchCreated=3')

    expect(createDevice).toHaveBeenCalledTimes(3)
    const serials = createDevice.mock.calls.map((c) => c[0].pcba_a_sn)
    expect(serials).toEqual(['DEV100', 'DEV101', 'DEV102'])
    // each range unit forces pcba_b_sn: undefined + qty 1
    for (const call of createDevice.mock.calls) {
      expect(call[0].pcba_b_sn).toBeUndefined()
      expect(call[0].qty).toBe(1)
      expect(call[1]).toBe('eng-1')
      expect(call[2]).toBe('engineer')
    }
    expect(revalidatePath).toHaveBeenCalledWith('/legacy/devices')
    expect(redirect).toHaveBeenCalledWith('/legacy/devices?batchCreated=3')
  })

  it('propagates pairSerialRanges error for ambiguous notation (no create)', async () => {
    currentUser = ENGINEER
    await expect(
      createDeviceBatchAction(baseInput({ pcba_a_sn: 'DEV1, DEV2' })),
    ).rejects.toThrow(/cannot be auto-expanded/)
    expect(createDevice).not.toHaveBeenCalled()
  })

  it('throws "No serial numbers provided" when pcba_a_sn is empty', async () => {
    currentUser = ENGINEER
    await expect(
      createDeviceBatchAction(baseInput({ pcba_a_sn: '' })),
    ).rejects.toThrow('No serial numbers provided')
    expect(createDevice).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// updateDeviceAction — THROWS convention.
// ---------------------------------------------------------------------------
describe('updateDeviceAction', () => {
  it('throws Unauthorized when no user', async () => {
    currentUser = null
    await expect(updateDeviceAction('d1', { status: 'x' }, 3)).rejects.toThrow('Unauthorized')
  })

  it('throws Unauthorized for viewer (lacks edit_device)', async () => {
    currentUser = VIEWER
    await expect(updateDeviceAction('d1', { status: 'x' }, 3)).rejects.toThrow('Unauthorized')
  })

  it('delegates to updateDevice and revalidates the detail path', async () => {
    currentUser = ENGINEER
    updateDevice.mockResolvedValue({ id: 'd1', version: 4 })
    const out = await updateDeviceAction('d1', { status: 'shipped' }, 3)
    expect(updateDevice).toHaveBeenCalledWith('d1', { status: 'shipped' }, 3, 'eng-1', 'engineer')
    expect(revalidatePath).toHaveBeenCalledWith('/legacy/devices/d1')
    expect(out).toEqual({ id: 'd1', version: 4 })
  })
})

// ---------------------------------------------------------------------------
// softDeleteAction — THROWS + redirects to /devices.
// ---------------------------------------------------------------------------
describe('softDeleteAction', () => {
  it('throws Unauthorized when no user', async () => {
    currentUser = null
    await expect(softDeleteAction('d1')).rejects.toThrow('Unauthorized')
  })

  it('throws Unauthorized for engineer (lacks soft_delete)', async () => {
    currentUser = ENGINEER
    await expect(softDeleteAction('d1')).rejects.toThrow('Unauthorized')
    expect(softDeleteDevice).not.toHaveBeenCalled()
  })

  it('admin: soft-deletes, revalidates, redirects to /devices', async () => {
    currentUser = ADMIN
    softDeleteDevice.mockResolvedValue(undefined)
    await expect(softDeleteAction('d1')).rejects.toThrow('NEXT_REDIRECT:/legacy/devices')
    expect(softDeleteDevice).toHaveBeenCalledWith('d1', 'adm-1', 'admin')
    expect(revalidatePath).toHaveBeenCalledWith('/legacy/devices')
    expect(redirect).toHaveBeenCalledWith('/legacy/devices')
  })
})

// ---------------------------------------------------------------------------
// restoreDeviceAction — RESULT convention ({ ok } | { error }); admin-only.
// ---------------------------------------------------------------------------
describe('restoreDeviceAction', () => {
  it('returns { error: Unauthorized } when no user', async () => {
    currentUser = null
    expect(await restoreDeviceAction('d1', 2)).toEqual({ error: 'Unauthorized' })
  })

  it('returns { error: Unauthorized } for engineer (lacks soft_delete)', async () => {
    currentUser = ENGINEER
    expect(await restoreDeviceAction('d1', 2)).toEqual({ error: 'Unauthorized' })
    expect(restoreDevice).not.toHaveBeenCalled()
  })

  it('admin happy path: delegates, revalidates, returns { ok: true }', async () => {
    currentUser = ADMIN
    restoreDevice.mockResolvedValue(undefined)
    const out = await restoreDeviceAction('d1', 2)
    expect(restoreDevice).toHaveBeenCalledWith('d1', 2, 'adm-1', 'admin')
    expect(revalidatePath).toHaveBeenCalledWith('/legacy/devices')
    expect(out).toEqual({ ok: true })
  })

  it('maps a thrown service error to { error: message }', async () => {
    currentUser = ADMIN
    restoreDevice.mockRejectedValue(new Error('version conflict'))
    expect(await restoreDeviceAction('d1', 2)).toEqual({ error: 'version conflict' })
    expect(revalidatePath).not.toHaveBeenCalled()
  })
})

// ---------------------------------------------------------------------------
// createDeviceRowAction — RESULT convention; duplicate-PCBA guard.
// ---------------------------------------------------------------------------
describe('createDeviceRowAction', () => {
  it('returns { error: Unauthorized } when no user', async () => {
    currentUser = null
    expect(await createDeviceRowAction(baseInput())).toEqual({ error: 'Unauthorized' })
  })

  it('returns { error: Unauthorized } for viewer', async () => {
    currentUser = VIEWER
    expect(await createDeviceRowAction(baseInput())).toEqual({ error: 'Unauthorized' })
    expect(getDeviceByPcbaSn).not.toHaveBeenCalled()
  })

  it('duplicate PCBA-A: returns error naming the serial + existingId, no create', async () => {
    currentUser = ENGINEER
    getDeviceByPcbaSn.mockResolvedValue({ id: 'existing-9' })
    const out = await createDeviceRowAction(baseInput({ pcba_a_sn: 'DUP1' }))
    expect(getDeviceByPcbaSn).toHaveBeenCalledWith('DUP1')
    expect(out).toEqual({
      error: 'A device with PCBA-A S/N "DUP1" already exists',
      existingId: 'existing-9',
    })
    expect(createDevice).not.toHaveBeenCalled()
  })

  it('non-duplicate happy path: creates, revalidates, returns { id }', async () => {
    currentUser = ENGINEER
    getDeviceByPcbaSn.mockResolvedValue(null)
    createDevice.mockResolvedValue({ id: 'new-1' })
    const input = baseInput()
    const out = await createDeviceRowAction(input)
    expect(createDevice).toHaveBeenCalledWith(input, 'eng-1', 'engineer')
    expect(revalidatePath).toHaveBeenCalledWith('/legacy/devices')
    expect(out).toEqual({ id: 'new-1' })
  })

  it('maps a thrown service error to { error: message }', async () => {
    currentUser = ENGINEER
    getDeviceByPcbaSn.mockResolvedValue(null)
    createDevice.mockRejectedValue(new AppError({ type: 'validation', message: 'bad', errors: {} }))
    expect(await createDeviceRowAction(baseInput())).toEqual({ error: 'bad' })
  })
})

// ---------------------------------------------------------------------------
// updateDeviceRowAction — RESULT convention.
// ---------------------------------------------------------------------------
describe('updateDeviceRowAction', () => {
  it('returns { error: Unauthorized } for viewer', async () => {
    currentUser = VIEWER
    expect(await updateDeviceRowAction('d1', { status: 'x' }, 1)).toEqual({ error: 'Unauthorized' })
  })

  it('happy path: delegates, revalidates /devices, returns { ok: true }', async () => {
    currentUser = ENGINEER
    updateDevice.mockResolvedValue({ id: 'd1' })
    const out = await updateDeviceRowAction('d1', { status: 'shipped' }, 2)
    expect(updateDevice).toHaveBeenCalledWith('d1', { status: 'shipped' }, 2, 'eng-1', 'engineer')
    expect(revalidatePath).toHaveBeenCalledWith('/legacy/devices')
    expect(out).toEqual({ ok: true })
  })

  it('maps a thrown error to { error: message }', async () => {
    currentUser = ENGINEER
    updateDevice.mockRejectedValue(new Error('stale'))
    expect(await updateDeviceRowAction('d1', {}, 2)).toEqual({ error: 'stale' })
  })
})

// ---------------------------------------------------------------------------
// bulkChangeStatusAction — per-item try/catch conflict aggregation.
// ---------------------------------------------------------------------------
describe('bulkChangeStatusAction', () => {
  const items = [
    { id: 'a', version: 1 },
    { id: 'b', version: 2 },
    { id: 'c', version: 3 },
  ]

  it('returns { error: Unauthorized } for viewer (lacks change_status)', async () => {
    currentUser = VIEWER
    expect(await bulkChangeStatusAction(items, 'shipped', null)).toEqual({ error: 'Unauthorized' })
    expect(changeStatus).not.toHaveBeenCalled()
  })

  it('aggregates conflicts: one missing + one throwing do not abort the rest', async () => {
    currentUser = ENGINEER
    getDevice.mockImplementation(async (id: string) => {
      if (id === 'b') return null // missing → conflict, continue
      return { id, status: 's_old', phase: 'p_old' }
    })
    changeStatus.mockImplementation(async (id: string) => {
      if (id === 'c') throw new Error('conflict')
      return { id }
    })

    const out = await bulkChangeStatusAction(items, 'shipped', null)

    expect(out).toEqual({ ok: true, updated: 1, conflicts: ['b', 'c'] })
    // 'a' succeeds: status from param, phase falls back to current.phase
    expect(changeStatus).toHaveBeenCalledWith('a', 'shipped', 'p_old', 1, 'eng-1', 'engineer')
    // 'b' never reaches changeStatus (getDevice returned null)
    expect(changeStatus).not.toHaveBeenCalledWith('b', expect.anything(), expect.anything(), expect.anything(), expect.anything(), expect.anything())
    expect(revalidatePath).toHaveBeenCalledWith('/legacy/devices')
  })

  it('null status falls back to current.status per device', async () => {
    currentUser = ENGINEER
    getDevice.mockResolvedValue({ id: 'a', status: 'keep_me', phase: 'p1' })
    changeStatus.mockResolvedValue({ id: 'a' })
    await bulkChangeStatusAction([{ id: 'a', version: 5 }], null, 'newphase')
    expect(changeStatus).toHaveBeenCalledWith('a', 'keep_me', 'newphase', 5, 'eng-1', 'engineer')
  })
})

// ---------------------------------------------------------------------------
// bulkSoftDeleteAction — admin-only; per-item conflict aggregation.
// ---------------------------------------------------------------------------
describe('bulkSoftDeleteAction', () => {
  it('returns { error: Unauthorized } for engineer (lacks soft_delete)', async () => {
    currentUser = ENGINEER
    expect(await bulkSoftDeleteAction([{ id: 'a', version: 1 }])).toEqual({ error: 'Unauthorized' })
  })

  it('admin: aggregates one success + one conflict', async () => {
    currentUser = ADMIN
    softDeleteDevice.mockImplementation(async (id: string) => {
      if (id === 'b') throw new Error('locked')
      return undefined
    })
    const out = await bulkSoftDeleteAction([{ id: 'a', version: 1 }, { id: 'b', version: 2 }])
    expect(out).toEqual({ ok: true, deleted: 1, conflicts: ['b'] })
    expect(softDeleteDevice).toHaveBeenCalledWith('a', 'adm-1', 'admin')
    expect(revalidatePath).toHaveBeenCalledWith('/legacy/devices')
  })
})

// ---------------------------------------------------------------------------
// assignDeviceAction / unassignDeviceAction — RESULT convention; ASSIGN_DEVICE.
// ---------------------------------------------------------------------------
describe('assignDeviceAction / unassignDeviceAction', () => {
  it('assign returns { error: Unauthorized } for viewer', async () => {
    currentUser = VIEWER
    expect(await assignDeviceAction('d1', 'u2')).toEqual({ error: 'Unauthorized' })
  })

  it('assign happy path: delegates + revalidates the device detail path', async () => {
    currentUser = ENGINEER
    assignDevice.mockResolvedValue(undefined)
    const out = await assignDeviceAction('d1', 'u2')
    expect(assignDevice).toHaveBeenCalledWith('d1', 'u2', 'eng-1', 'engineer')
    expect(revalidatePath).toHaveBeenCalledWith('/legacy/devices/d1')
    expect(out).toEqual({ ok: true })
  })

  it('assign maps a thrown error to { error: message }', async () => {
    currentUser = ENGINEER
    assignDevice.mockRejectedValue(new Error('nope'))
    expect(await assignDeviceAction('d1', 'u2')).toEqual({ error: 'nope' })
  })

  it('unassign happy path: delegates + revalidates', async () => {
    currentUser = ENGINEER
    unassignDevice.mockResolvedValue(undefined)
    const out = await unassignDeviceAction('d1', 'u2')
    expect(unassignDevice).toHaveBeenCalledWith('d1', 'u2', 'eng-1', 'engineer')
    expect(revalidatePath).toHaveBeenCalledWith('/legacy/devices/d1')
    expect(out).toEqual({ ok: true })
  })
})

// ---------------------------------------------------------------------------
// addServiceEventAction — RESULT convention; LOG_SERVICE_EVENT.
// ---------------------------------------------------------------------------
describe('addServiceEventAction', () => {
  it('returns { error: Unauthorized } for viewer', async () => {
    currentUser = VIEWER
    expect(await addServiceEventAction('d1', 'note', '2026-01-01')).toEqual({ error: 'Unauthorized' })
  })

  it('happy path: passes the shaped payload, revalidates, returns { ok: true }', async () => {
    currentUser = ENGINEER
    addServiceEvent.mockResolvedValue(undefined)
    const out = await addServiceEventAction('d1', 'repaired sensor', '2026-01-02')
    expect(addServiceEvent).toHaveBeenCalledWith(
      { deviceId: 'd1', description: 'repaired sensor', occurredOn: '2026-01-02' },
      'eng-1',
      'engineer',
    )
    expect(revalidatePath).toHaveBeenCalledWith('/legacy/devices/d1')
    expect(out).toEqual({ ok: true })
  })

  it('maps a thrown error to { error: message }', async () => {
    currentUser = ENGINEER
    addServiceEvent.mockRejectedValue(new Error('db down'))
    expect(await addServiceEventAction('d1', 'x', '2026-01-02')).toEqual({ error: 'db down' })
  })
})
