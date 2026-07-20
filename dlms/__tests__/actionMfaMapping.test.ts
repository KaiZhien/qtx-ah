import { describe, it, expect, vi, beforeEach } from 'vitest'

// ---------------------------------------------------------------------------
// Regression test: requireAal2Actor() must be the FIRST statement INSIDE the
// try block of every platform server action. When it is called before the
// try (as admin/roles, admin/users, and manufacturing/components originally
// were), the MfaRequiredError it throws for an AAL1 admin escapes unhandled
// instead of being mapped by the action's own catch block to the friendly
// "reload the page" message. One representative action from each of the
// three fixed files is exercised here.
// ---------------------------------------------------------------------------

const mockRequireAal2Actor = vi.fn()
vi.mock('@/modules/shared/auth/session', () => ({
  requireAal2Actor: mockRequireAal2Actor,
  MfaRequiredError: class MfaRequiredError extends Error {},
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))

vi.mock('@/modules/shared/authz/authorize', () => ({
  authorize: vi.fn(),
  PermissionError: class PermissionError extends Error {},
}))

vi.mock('@/lib/db/tx', () => ({
  OptimisticLockError: class OptimisticLockError extends Error {},
}))

// admin/roles/actions.ts deps
vi.mock('@/modules/admin/services/roleService', () => ({
  setRolePermission: vi.fn(),
  addOverride: vi.fn(),
  FabricLockoutError: class FabricLockoutError extends Error {},
}))

// admin/users/actions.ts deps
vi.mock('@/modules/admin/services/userService', () => ({
  inviteUser: vi.fn(),
  setUserActive: vi.fn(),
  updateUserAccess: vi.fn(),
  resetUserMfa: vi.fn(),
}))
vi.mock('@/modules/shared/auth/authEvents', () => ({ recordAuthEvent: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/modules/admin/domain/userGuards', () => ({
  LastSuperAdminError: class LastSuperAdminError extends Error {},
  SelfEscalationError: class SelfEscalationError extends Error {},
}))

// manufacturing/components/actions.ts deps
vi.mock('@/modules/manufacturing/services/componentCatalogueService', () => ({
  createComponentType: vi.fn(),
  updateComponentType: vi.fn(),
}))

const { addOverrideAction } = await import('@/app/(platform)/admin/roles/actions')
const { resetUserMfaAction } = await import('@/app/(platform)/admin/users/actions')
const { createTypeAction } = await import('@/app/(platform)/manufacturing/components/actions')
const { MfaRequiredError } = await import('@/modules/shared/auth/session')

const MFA_MESSAGE = 'Two-factor authentication required — reload the page to finish signing in.'
const EXPECTED = { error: MFA_MESSAGE }

beforeEach(() => {
  mockRequireAal2Actor.mockReset().mockRejectedValue(new MfaRequiredError())
})

describe('MfaRequiredError mapping when the AAL2 guard rejects', () => {
  it('admin/roles: addOverrideAction resolves to the friendly MFA error (does not reject)', async () => {
    await expect(addOverrideAction({
      userId: 'u1', permissionKey: 'manage_users', granted: true, reason: 'test',
    } as never)).resolves.toEqual(EXPECTED)
  })

  it('admin/users: resetUserMfaAction resolves to the friendly MFA error (does not reject)', async () => {
    await expect(resetUserMfaAction('u1')).resolves.toEqual(EXPECTED)
  })

  it('manufacturing/components: createTypeAction resolves to the friendly MFA error (does not reject)', async () => {
    // CreateResult's shape differs from the other two files ({ ok: false, error }
    // rather than a bare { error }), so it gets its own expected value.
    await expect(createTypeAction({
      code: 'x', name: 'X', trackingMode: 'serialized', requiresFirmware: false,
    } as never)).resolves.toEqual({ ok: false, error: MFA_MESSAGE })
  })
})
