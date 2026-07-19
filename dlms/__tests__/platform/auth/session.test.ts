import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetUser = vi.fn()
const mockLoadActor = vi.fn()

vi.mock('@/lib/supabase/server', () => ({
  createClient: () => ({ auth: { getUser: mockGetUser } }),
  createAdminClient: () => ({}),
}))
vi.mock('@/modules/shared/authz/actor', () => ({ loadActor: mockLoadActor }))

const { getCurrentActor, requireActor, UnauthenticatedError } = await import(
  '@/modules/shared/auth/session'
)

const ACTOR = {
  id: 'u1', roleKey: 'operator' as const,
  permissions: new Set(['view_records' as const]),
  moduleAccess: new Set(['manufacturing' as const]), active: true,
}

beforeEach(() => {
  mockGetUser.mockReset()
  mockLoadActor.mockReset()
})

describe('getCurrentActor', () => {
  it('returns null when there is no Supabase session', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
    expect(await getCurrentActor()).toBeNull()
    expect(mockLoadActor).not.toHaveBeenCalled()
  })

  it('returns the resolved actor for an authenticated user', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null })
    mockLoadActor.mockResolvedValue(ACTOR)
    expect(await getCurrentActor()).toEqual(ACTOR)
    expect(mockLoadActor).toHaveBeenCalledWith('auth-1')
  })

  it('returns null when the auth user has no app_user row (invited, never provisioned)', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-ghost' } }, error: null })
    mockLoadActor.mockResolvedValue(null)
    expect(await getCurrentActor()).toBeNull()
  })

  it('treats a DEACTIVATED user as unauthenticated — sessions die with the account', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-2' } }, error: null })
    mockLoadActor.mockResolvedValue({ ...ACTOR, active: false })
    expect(await getCurrentActor()).toBeNull()
  })
})

describe('requireActor', () => {
  it('throws UnauthenticatedError when there is no actor', async () => {
    mockGetUser.mockResolvedValue({ data: { user: null }, error: null })
    await expect(requireActor()).rejects.toThrow(UnauthenticatedError)
  })

  it('returns the actor when present', async () => {
    mockGetUser.mockResolvedValue({ data: { user: { id: 'auth-1' } }, error: null })
    mockLoadActor.mockResolvedValue(ACTOR)
    expect(await requireActor()).toEqual(ACTOR)
  })
})
