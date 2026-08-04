import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockRequireAal2Actor = vi.fn()
const mockUpdateSetting = vi.fn()

vi.mock('@/modules/shared/auth/session', () => ({
  requireAal2Actor: mockRequireAal2Actor,
  MfaRequiredError: class MfaRequiredError extends Error {},
  UnauthenticatedError: class UnauthenticatedError extends Error {},
  SESSION_EXPIRED_MESSAGE: 'Your session has expired. Sign in again.',
}))
vi.mock('@/modules/shared/settings/services/settingService', () => ({
  updateSetting: mockUpdateSetting,
  SettingNotEditableError: class SettingNotEditableError extends Error {
    readonly key: string
    constructor(key: string, reason: string) { super(reason); this.key = key }
  },
}))
vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

const { updateSettingAction } = await import('@/app/(platform)/admin/settings/actions')
const { MfaRequiredError } = await import('@/modules/shared/auth/session')
const { SettingNotEditableError } =
  await import('@/modules/shared/settings/services/settingService')
const { PermissionError } = await import('@/modules/shared/authz/authorize')
const { OptimisticLockError } = await import('@/lib/db/tx')

const ACTOR = {
  id: 'u1', roleKey: 'super_admin' as const,
  permissions: new Set(['manage_settings' as const]),
  moduleAccess: new Set(['admin' as const]), active: true,
}

const input = { key: 'finance_approval_threshold_sgd', value: '7500', version: 1 }

beforeEach(() => {
  mockRequireAal2Actor.mockReset().mockResolvedValue(ACTOR)
  mockUpdateSetting.mockReset()
})

describe('updateSettingAction', () => {
  it('saves and reports the new version', async () => {
    mockUpdateSetting.mockResolvedValue({ version: 2 })
    expect(await updateSettingAction(input)).toEqual({ ok: true, data: { version: 2 } })
    expect(mockUpdateSetting).toHaveBeenCalledWith(ACTOR, input)
  })

  // The regression this project has shipped before: requireAal2Actor OUTSIDE the
  // try throws out of the action instead of returning a result the UI can render,
  // and __tests__/actionAalPinning.test.ts only checks that the identifier appears.
  it('RETURNS a failure when the session is not AAL2 — it does not throw', async () => {
    mockRequireAal2Actor.mockRejectedValue(new MfaRequiredError())
    const res = await updateSettingAction(input)
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).toContain('Two-factor')
    expect(mockUpdateSetting).not.toHaveBeenCalled()
  })

  it('passes a validation refusal through VERBATIM', async () => {
    // The registry's message names the rule and the field the administrator just
    // typed in. A generic line would leave them guessing at something the system
    // knows exactly.
    const reason = 'Finance approval threshold must be a plain number — digits, and at most one '
      + 'decimal point.'
    mockUpdateSetting.mockRejectedValue(
      new SettingNotEditableError('finance_approval_threshold_sgd', reason))
    expect(await updateSettingAction({ ...input, value: 'abc' }))
      .toEqual({ ok: false, error: reason })
  })

  it('explains a concurrent edit rather than leaking the lock error', async () => {
    mockUpdateSetting.mockRejectedValue(new OptimisticLockError('app_setting', input.key))
    const res = await updateSettingAction(input)
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error.toLowerCase()).toContain('someone else changed')
  })

  it('does not confirm anything to an actor without the permission', async () => {
    mockUpdateSetting.mockRejectedValue(new PermissionError('manage_settings', 'admin'))
    expect(await updateSettingAction(input))
      .toEqual({ ok: false, error: "You don't have permission to do that." })
  })

  it('never leaks an unrecognised error to the browser', async () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    mockUpdateSetting.mockRejectedValue(
      new Error('duplicate key value violates unique constraint "app_setting_pkey"'))
    const res = await updateSettingAction(input)
    expect(res.ok).toBe(false)
    expect((res as { error: string }).error).not.toContain('app_setting_pkey')
    expect(spy).toHaveBeenCalled()
    spy.mockRestore()
  })

  it('refuses a malformed request without reaching the service', async () => {
    const res = await updateSettingAction(
      { key: '', value: '1', version: -1 } as unknown as typeof input)
    expect(res.ok).toBe(false)
    expect(mockUpdateSetting).not.toHaveBeenCalled()
  })
})
