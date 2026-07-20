import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockGetAal = vi.fn()
const mockLoadActor = vi.fn()

// createClient exposes both the getUser (used by getCurrentActor/requireActor)
// and the mfa.getAuthenticatorAssuranceLevel spy (used by requireAal2Actor).
vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({
    auth: {
      getUser: mockGetUser,
      mfa: { getAuthenticatorAssuranceLevel: mockGetAal },
    },
  }),
  createAdminClient: () => ({}),
}))
vi.mock('@/modules/shared/authz/actor', () => ({ loadActor: mockLoadActor }))

const { requireAal2Actor, MfaRequiredError, UnauthenticatedError } = await import(
  '@/modules/shared/auth/session'
)

const ADMIN = {
  id: 'adm-1',
  roleKey: 'admin' as const,
  permissions: new Set(['manage_users' as const]),
  moduleAccess: new Set(['admin' as const]),
  active: true,
}
const VIEWER = {
  id: 'view-1',
  roleKey: 'viewer' as const,
  permissions: new Set(['view_records' as const]),
  moduleAccess: new Set(['manufacturing' as const]),
  active: true,
}

function signedInAs(actor: unknown) {
  mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null })
  mockLoadActor.mockResolvedValue(actor)
}

beforeEach(() => {
  mockGetUser.mockReset()
  mockGetAal.mockReset()
  mockLoadActor.mockReset()
})

describe('requireAal2Actor', () => {
  it('throws MfaRequiredError for an MFA-required role stuck at AAL1', async () => {
    signedInAs(ADMIN)
    mockGetAal.mockResolvedValue({ data: { currentLevel: 'aal1', nextLevel: 'aal2' }, error: null })
    await expect(requireAal2Actor()).rejects.toBeInstanceOf(MfaRequiredError)
  })

  it('returns the actor for an MFA-required role already at AAL2', async () => {
    signedInAs(ADMIN)
    mockGetAal.mockResolvedValue({ data: { currentLevel: 'aal2', nextLevel: 'aal2' }, error: null })
    expect(await requireAal2Actor()).toEqual(ADMIN)
  })

  it('returns a non-MFA actor WITHOUT ever reading the AAL (those roles pay nothing)', async () => {
    signedInAs(VIEWER)
    expect(await requireAal2Actor()).toEqual(VIEWER)
    expect(mockGetAal).not.toHaveBeenCalled()
  })

  it('fails closed: an MFA role whose AAL read returns no data throws MfaRequiredError', async () => {
    signedInAs(ADMIN)
    mockGetAal.mockResolvedValue({ data: null, error: { message: 'aal read failed' } })
    await expect(requireAal2Actor()).rejects.toBeInstanceOf(MfaRequiredError)
  })

  it('throws UnauthenticatedError with no session, never reading the AAL', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
    await expect(requireAal2Actor()).rejects.toBeInstanceOf(UnauthenticatedError)
    expect(mockGetAal).not.toHaveBeenCalled()
  })
})
