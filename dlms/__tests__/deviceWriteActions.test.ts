import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('@/modules/shared/auth/session', () => ({
  requireAal2Actor: vi.fn(async () => ({
    id: 'u1', roleKey: 'operator',
    permissions: new Set(['create_records', 'edit_records', 'change_device_status']),
    moduleAccess: new Set(['manufacturing']), active: true,
  })),
  MfaRequiredError: class MfaRequiredError extends Error {},
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/modules/manufacturing/services/deviceWriteService', () => ({
  createDevice: vi.fn(),
  updateDevice: vi.fn(),
  changeDeviceStatus: vi.fn(),
  DeviceNotFoundError: class DeviceNotFoundError extends Error {},
  DuplicateSerialError: class DuplicateSerialError extends Error {
    constructor(sn: string) {
      super(`A device with serial "${sn}" already exists`)
      this.name = 'DuplicateSerialError'
    }
  },
}))

import { createDeviceAction, updateDeviceAction, changeDeviceStatusAction } from '@/app/(platform)/manufacturing/devices/deviceWriteActions'
import * as svc from '@/modules/manufacturing/services/deviceWriteService'
import { InvalidStatusChangeError } from '@/modules/manufacturing/domain/deviceStatus'
import { OptimisticLockError } from '@/lib/db/tx'
import { PermissionError } from '@/modules/shared/authz/authorize'

beforeEach(() => vi.clearAllMocks())

describe('createDeviceAction', () => {
  it('returns ok with the new id on success', async () => {
    vi.mocked(svc.createDevice).mockResolvedValue({ deviceId: 'd1', status: 'in_production' })
    expect(await createDeviceAction({ variantCode: 'pro' })).toEqual({ ok: true, data: { deviceId: 'd1' } })
  })
  it('maps DuplicateSerialError to its own message', async () => {
    vi.mocked(svc.createDevice).mockRejectedValue(new svc.DuplicateSerialError('dup'))
    const res = await createDeviceAction({ variantCode: 'pro', deviceSn: 'dup' })
    expect(res).toEqual({ ok: false, error: 'A device with serial "dup" already exists' })
  })
  it('maps PermissionError to a generic denial (no internals)', async () => {
    vi.mocked(svc.createDevice).mockRejectedValue(new PermissionError('create_records', 'manufacturing'))
    const res = await createDeviceAction({ variantCode: 'pro' })
    expect(res).toEqual({ ok: false, error: "You don't have permission to do that." })
  })
  it('never leaks an unknown error', async () => {
    vi.mocked(svc.createDevice).mockRejectedValue(new Error('column "secret" does not exist'))
    const res = await createDeviceAction({ variantCode: 'pro' })
    expect(res.ok).toBe(false)
    if (!res.ok) expect(res.error).not.toContain('secret')
  })
})

describe('changeDeviceStatusAction', () => {
  it('surfaces InvalidStatusChangeError.message (safe, user-facing)', async () => {
    vi.mocked(svc.changeDeviceStatus).mockRejectedValue(
      new InvalidStatusChangeError('reason_required', 'Moving from "Active" to "Returned" requires a reason.'))
    const res = await changeDeviceStatusAction({ deviceId: 'd1', toStatus: 'returned', version: 1 })
    expect(res).toEqual({ ok: false, error: 'Moving from "Active" to "Returned" requires a reason.' })
  })
  it('maps OptimisticLockError to the reload message', async () => {
    vi.mocked(svc.changeDeviceStatus).mockRejectedValue(new OptimisticLockError('device', 'd1'))
    const res = await changeDeviceStatusAction({ deviceId: 'd1', toStatus: 'quality_check', version: 1 })
    expect(res).toEqual({ ok: false, error: 'Someone else changed this device. Reload and try again.' })
  })
  it('maps DeviceNotFoundError to the reload message', async () => {
    vi.mocked(svc.changeDeviceStatus).mockRejectedValue(new svc.DeviceNotFoundError('d1'))
    const res = await changeDeviceStatusAction({ deviceId: 'd1', toStatus: 'quality_check', version: 1 })
    expect(res).toEqual({ ok: false, error: 'That device no longer exists. Reload and try again.' })
  })
  it('returns ok with the new status/version', async () => {
    vi.mocked(svc.changeDeviceStatus).mockResolvedValue({ status: 'quality_check', version: 2 })
    expect(await changeDeviceStatusAction({ deviceId: 'd1', toStatus: 'quality_check', version: 1 }))
      .toEqual({ ok: true, data: { status: 'quality_check', version: 2 } })
  })
})

describe('updateDeviceAction', () => {
  it('returns ok with the new version', async () => {
    vi.mocked(svc.updateDevice).mockResolvedValue({ version: 3 })
    expect(await updateDeviceAction({ deviceId: 'd1', version: 2, productName: 'x' }))
      .toEqual({ ok: true, data: { version: 3 } })
  })
})
