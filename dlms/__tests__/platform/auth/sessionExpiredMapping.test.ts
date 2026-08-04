import { describe, it, expect, vi, beforeEach } from 'vitest'
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

// ---------------------------------------------------------------------------
// UnauthenticatedError must be mapped EVERYWHERE an actor is required.
//
// requireAal2Actor -> requireActor -> UnauthenticatedError. Every actor-gated
// entry point in app/(platform)/** can therefore be handed one, and until this
// pin existed none of them named it: an expired session fell through to the
// generic branch, so the user read "Something went wrong" about a session they
// could have fixed by signing in, and the operator got an ERROR log line for
// ordinary session expiry.
//
// This is pinned as a CONVENTION over the whole surface rather than tested one
// module at a time, because the defect is per-module by construction: mapping it
// in one file and not the next is the inconsistency, not the fix. The wave that
// carried this finding grew the mapper count from eleven to thirty; a scan is the
// only form of this test that survives the next module.
//
// TWO ASSERTIONS PER FILE, and they fail for different reasons:
//   (a) the file NAMES UnauthenticatedError — it has a branch for it at all
//   (b) the file uses SESSION_EXPIRED_MESSAGE — the wording is the shared
//       constant, not a hand-typed near-copy that drifts on the next edit
// ---------------------------------------------------------------------------

function walk(dir: string): string[] {
  const out: string[] = []
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) out.push(...walk(full))
    else out.push(full)
  }
  return out
}

const PLATFORM_DIR = join(__dirname, '..', '..', '..', 'app', '(platform)')

// The population is "everything that takes an actor through the AAL2 gate", NOT
// "everything with a function called toMessage". Three different mapper shapes
// live in this app — `toMessage`, `toUserMessage`, and an inline catch in the
// load-more read actions — and a name-based scan would silently miss two of them.
// The gate call is the honest signal: if a file asks for an actor, it can be told
// there isn't one.
const gatedFiles = walk(PLATFORM_DIR).filter(
  (f) => /\.tsx?$/.test(f) && /\brequireAal2Actor\b/.test(readFileSync(f, 'utf8')),
)

describe('UnauthenticatedError is mapped in every actor-gated entry point', () => {
  it('the scan actually found the known gated modules', () => {
    // Guards against a silently-empty it.each. RAISE THIS FLOOR when modules are
    // added; it sits just under the count at the time of writing so that deleting
    // one module does not fail the suite, but a broken scan does.
    expect(gatedFiles.length).toBeGreaterThanOrEqual(28)
  })

  it.each(gatedFiles.map((f) => [f.slice(f.indexOf('app/(platform)')), f]))(
    '%s names UnauthenticatedError', (_label, file) => {
      expect(/\binstanceof UnauthenticatedError\b/.test(readFileSync(file, 'utf8'))).toBe(true)
    })

  it.each(gatedFiles.map((f) => [f.slice(f.indexOf('app/(platform)')), f]))(
    '%s uses the shared SESSION_EXPIRED_MESSAGE, not its own wording',
    (_label, file) => {
      expect(/\bSESSION_EXPIRED_MESSAGE\b/.test(readFileSync(file, 'utf8'))).toBe(true)
    })
})

// ---------------------------------------------------------------------------
// The behavioural half. The scan above proves the branch is written; these prove
// it actually returns the message instead of rejecting, across all THREE mapper
// shapes the app uses. One representative per shape.
// ---------------------------------------------------------------------------

const mockRequireAal2Actor = vi.fn()

class FakeUnauthenticatedError extends Error {}
const SESSION_EXPIRED_MESSAGE = 'Your session has expired. Sign in again.'

vi.mock('@/modules/shared/auth/session', () => ({
  requireAal2Actor: mockRequireAal2Actor,
  MfaRequiredError: class MfaRequiredError extends Error {},
  UnauthenticatedError: FakeUnauthenticatedError,
  SESSION_EXPIRED_MESSAGE,
}))

vi.mock('next/cache', () => ({ revalidatePath: vi.fn() }))
vi.mock('@/modules/shared/authz/authorize', () => ({
  authorize: vi.fn(),
  PermissionError: class PermissionError extends Error {},
}))
vi.mock('@/lib/db/tx', () => ({
  OptimisticLockError: class OptimisticLockError extends Error {},
}))

// tasks/actions.ts deps — the `toMessage` shape.
vi.mock('@/modules/shared/tasks/services/taskService', () => ({
  createTask: vi.fn(), changeTaskStatus: vi.fn(), assignTask: vi.fn(), addComment: vi.fn(),
  TaskNotFoundError: class TaskNotFoundError extends Error {},
  InvalidTransitionError: class InvalidTransitionError extends Error {},
}))

// admin/users/actions.ts deps — the `toUserMessage` shape.
vi.mock('@/modules/admin/services/userService', () => ({
  inviteUser: vi.fn(), setUserActive: vi.fn(), updateUserAccess: vi.fn(), resetUserMfa: vi.fn(),
}))
vi.mock('@/modules/shared/auth/authEvents', () => ({ recordAuthEvent: vi.fn() }))
vi.mock('@/lib/supabase/server', () => ({ createAdminClient: vi.fn() }))
vi.mock('@/modules/admin/domain/userGuards', () => ({
  LastSuperAdminError: class LastSuperAdminError extends Error {},
  SelfEscalationError: class SelfEscalationError extends Error {},
}))

// manufacturing/devices/actions.ts deps — the inline load-more catch.
vi.mock('@/modules/manufacturing/services/deviceReadService', () => ({
  listDevices: vi.fn(),
}))

const { changeStatusAction } = await import('@/app/(platform)/tasks/actions')
const { resetUserMfaAction } = await import('@/app/(platform)/admin/users/actions')
const { loadMoreDevicesAction } = await import('@/app/(platform)/manufacturing/devices/actions')

beforeEach(() => {
  mockRequireAal2Actor.mockReset().mockRejectedValue(new FakeUnauthenticatedError())
})

describe('an expired session resolves to the shared message, never a rejection', () => {
  it('tasks (toMessage shape)', async () => {
    await expect(changeStatusAction('t1', 'open', 1)).resolves.toEqual({
      ok: false, error: SESSION_EXPIRED_MESSAGE,
    })
  })

  it('admin/users (toUserMessage shape)', async () => {
    await expect(resetUserMfaAction('u1')).resolves.toEqual({
      error: SESSION_EXPIRED_MESSAGE,
    })
  })

  it('manufacturing device load-more (inline catch shape)', async () => {
    await expect(loadMoreDevicesAction({} as never)).resolves.toEqual({
      error: SESSION_EXPIRED_MESSAGE,
    })
  })

  it('does not log an ERROR line for ordinary session expiry', async () => {
    // The spurious log is half the defect: an expired session is normal traffic,
    // and an operator paging on error rate should never see it.
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {})
    await changeStatusAction('t1', 'open', 1)
    await resetUserMfaAction('u1')
    await loadMoreDevicesAction({} as never)
    expect(spy).not.toHaveBeenCalled()
    spy.mockRestore()
  })
})
