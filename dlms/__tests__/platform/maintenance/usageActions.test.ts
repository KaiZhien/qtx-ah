import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRequireAal2Actor = vi.fn()
const mockRecordUsage = vi.fn()

vi.mock('@/modules/shared/auth/session', () => ({
  requireAal2Actor: mockRequireAal2Actor,
  MfaRequiredError: class MfaRequiredError extends Error {},
  UnauthenticatedError: class UnauthenticatedError extends Error {},
  SESSION_EXPIRED_MESSAGE: 'Your session has expired. Sign in again.',
}))
vi.mock('@/modules/maintenance/services/usageService', () => ({
  recordUsage: mockRecordUsage,
  UsageDeviceNotFoundError: class UsageDeviceNotFoundError extends Error {},
  UsageDateInFutureError: class UsageDateInFutureError extends Error {
    recordedOn: string
    constructor(recordedOn: string) {
      super(`A usage reading cannot be dated in the future (got ${recordedOn}).`)
      this.recordedOn = recordedOn
    }
  },
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const { recordUsageAction } = await import('@/app/(platform)/maintenance/usage/actions')
const { MfaRequiredError } = await import('@/modules/shared/auth/session')
const {
  UsageDeviceNotFoundError, UsageDateInFutureError,
} = await import('@/modules/maintenance/services/usageService')
const { PermissionError } = await import('@/modules/shared/authz/authorize')

const ACTOR = {
  id: 'u1', roleKey: 'operator' as const,
  permissions: new Set(['log_usage_service' as const]),
  moduleAccess: new Set(['maintenance' as const]), active: true,
}
const DEVICE = '3f2a1b4c-0000-4000-8000-000000000001'

beforeEach(() => {
  mockRequireAal2Actor.mockReset().mockResolvedValue(ACTOR)
  mockRecordUsage.mockReset()
})

describe('recordUsageAction', () => {
  it('appends a reading and returns the classification', async () => {
    mockRecordUsage.mockResolvedValue({
      usageRecordId: 'ur1', classification: { kind: 'increase', delta: 120 },
    })
    const res = await recordUsageAction({ deviceId: DEVICE, cumulativeSessions: 620 })
    expect(res).toEqual({
      ok: true,
      data: { usageRecordId: 'ur1', classification: { kind: 'increase', delta: 120 } },
    })
    expect(mockRecordUsage).toHaveBeenCalledWith(
      ACTOR, { deviceId: DEVICE, cumulativeSessions: 620 })
  })

  // The rule this whole feature turns on: a lower reading is NOT an error. It
  // must come back as a SUCCESS carrying a reset classification, so the UI warns
  // instead of refusing. An action that mapped this to { ok: false } would make
  // a device with a legitimately-replaced counter unrecordable.
  it('reports a counter reset as a SUCCESS, not a failure', async () => {
    mockRecordUsage.mockResolvedValue({
      usageRecordId: 'ur2', classification: { kind: 'reset', previous: 500, next: 20 },
    })
    const res = await recordUsageAction({ deviceId: DEVICE, cumulativeSessions: 20 })
    expect(res.ok).toBe(true)
    expect(res).toMatchObject({ data: { classification: { kind: 'reset', previous: 500, next: 20 } } })
  })

  // The regression this project has shipped before: requireAal2Actor OUTSIDE the
  // try throws out of the action instead of returning a renderable result, and
  // __tests__/actionAalPinning.test.ts only checks that the identifier appears.
  it('RETURNS a failure when the session is not AAL2 — it does not throw', async () => {
    mockRequireAal2Actor.mockRejectedValue(new MfaRequiredError())
    const res = await recordUsageAction({ deviceId: DEVICE, cumulativeSessions: 10 })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toContain('Two-factor')
    expect(mockRecordUsage).not.toHaveBeenCalled()
  })

  // The counterpart to the reset test above, and the distinction that matters:
  // a LOWER reading is a real observation and comes back ok:true with a warning;
  // a FUTURE reading is a domain impossibility and comes back ok:false. The two
  // must not be conflated in either direction.
  it('reports a future-dated reading as a FAILURE, naming the date', async () => {
    mockRecordUsage.mockRejectedValue(new UsageDateInFutureError('2030-01-01'))
    const res = await recordUsageAction({
      deviceId: DEVICE, cumulativeSessions: 10, recordedOn: '2030-01-01' })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toContain('2030-01-01')
    expect((res as { error: string }).error).toContain('future')
  })

  it('reports an unknown device without confirming anything about it', async () => {
    mockRecordUsage.mockRejectedValue(new UsageDeviceNotFoundError('gone'))
    const res = await recordUsageAction({ deviceId: DEVICE, cumulativeSessions: 10 })
    expect(res).toEqual({ ok: false, error: 'That device no longer exists. Reload and try again.' })
  })

  it('maps a permission failure to a fixed string', async () => {
    mockRecordUsage.mockRejectedValue(new PermissionError('log_usage_service', 'maintenance'))
    const res = await recordUsageAction({ deviceId: DEVICE, cumulativeSessions: 10 })
    expect(res).toEqual({ ok: false, error: "You don't have permission to do that." })
  })

  it('never leaks an internal error message', async () => {
    mockRecordUsage.mockRejectedValue(
      new Error('new row for relation "usage_record" violates check constraint '
        + '"usage_record_cumulative_sessions_check"'))
    const res = await recordUsageAction({ deviceId: DEVICE, cumulativeSessions: -1 })
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).not.toContain('constraint')
    expect((res as { error: string }).error).not.toContain('usage_record')
  })
})
