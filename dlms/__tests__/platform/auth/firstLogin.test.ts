import { describe, it, expect, vi, beforeEach } from 'vitest'

/**
 * THE SHAPE OF THESE THREE STATEMENTS IS THE FEATURE.
 *
 * "First login links auth_user_id" is the only way the seeded bootstrap Super
 * Admin — whose row is written by supabase/seed/platform_seed.sql with
 * auth_user_id NULL — ever acquires a session. Nothing else in the codebase or
 * in SQL writes that column, so if the linking UPDATE regresses, the platform
 * silently returns to having no login path at all.
 *
 * Three properties are pinned structurally rather than by outcome, because each
 * is invisible in any single-caller fixture:
 *
 *   - the lookup matches an unlinked row by lower(email), never a soft-deleted
 *     one — a re-invited employee must not inherit a retired row;
 *   - the in-transaction re-read takes FOR UPDATE, so two tabs racing the same
 *     first login serialize instead of both linking;
 *   - the linking UPDATE re-asserts `auth_user_id IS NULL` in its WHERE, so the
 *     loser of that race writes nothing and is told so by rowCount, rather than
 *     overwriting the winner's link.
 *
 * The GUC the transaction opens with is asserted too: audit_log.actor_id is an
 * FK to app_user(id), so attributing the link to the auth user's id would fail
 * the constraint, and attributing it to anyone else would misreport who signed in.
 */

const poolQuery = vi.fn()
vi.mock('@/lib/db/pool', () => ({ getPool: () => ({ query: poolQuery }) }))

type Q = { text: string; values: unknown[] | undefined }
const txStatements: Q[] = []
const txActors: string[] = []
let txResults: { rows: unknown[]; rowCount: number }[] = []

vi.mock('@/lib/db/tx', () => ({
  withTransaction: (actorId: string, fn: (tx: unknown) => Promise<unknown>) => {
    txActors.push(actorId)
    return fn({
      query: (text: string, values?: unknown[]) => {
        txStatements.push({ text, values })
        return Promise.resolve(txResults.shift() ?? { rows: [], rowCount: 0 })
      },
    })
  },
  OptimisticLockError: class OptimisticLockError extends Error {},
}))

const { resolvePlatformLogin } = await import('@/modules/shared/auth/firstLogin')

const AUTH_ID = '9f1c0e2a-0000-4000-8000-000000000001'
const APP_USER_ID = '3b7d55aa-0000-4000-8000-000000000002'

/** Every statement the transaction issued, joined — for asserting SHAPE. */
const txSql = () => txStatements.map((s) => s.text).join('\n;\n')
const norm = (sql: string) => sql.replace(/\s+/g, ' ')

beforeEach(() => {
  poolQuery.mockReset()
  txStatements.length = 0
  txActors.length = 0
  txResults = []
})

describe('resolvePlatformLogin — lookup', () => {
  it('returns null and opens no transaction when nothing matches', async () => {
    poolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    expect(await resolvePlatformLogin(AUTH_ID, 'stranger@example.com')).toBeNull()
    expect(txActors).toEqual([])
  })

  it('matches the linked row by auth_user_id, or an unlinked LIVE row by lower(email)', async () => {
    poolQuery.mockResolvedValue({ rows: [], rowCount: 0 })
    await resolvePlatformLogin(AUTH_ID, 'Reetmitra8@Gmail.com')

    const [{ 0: text, 1: values }] = [poolQuery.mock.calls[0]]
    const sql = norm(text as string)
    expect(sql).toContain('auth_user_id = $1')
    expect(sql).toContain('lower(email) = lower($2)')
    expect(sql).toContain('auth_user_id IS NULL')
    expect(sql).toContain('deleted_at IS NULL')
    expect(values).toEqual([AUTH_ID, 'Reetmitra8@Gmail.com'])
  })
})

describe('resolvePlatformLogin — already linked', () => {
  beforeEach(() => {
    poolQuery.mockResolvedValue({ rows: [{ id: APP_USER_ID }], rowCount: 1 })
    txResults = [
      { rows: [{ auth_user_id: AUTH_ID }], rowCount: 1 },   // FOR UPDATE re-read
      { rows: [], rowCount: 1 },                            // last_login_at stamp
    ]
  })

  it('stamps last_login_at and returns the app_user id', async () => {
    expect(await resolvePlatformLogin(AUTH_ID, 'reetmitra8@gmail.com')).toBe(APP_USER_ID)
    expect(norm(txSql())).toContain('SET last_login_at = now()')
  })

  it('never rewrites auth_user_id on a row that already has one', async () => {
    await resolvePlatformLogin(AUTH_ID, 'reetmitra8@gmail.com')
    const update = txStatements.find((s) => /UPDATE app_user/i.test(s.text))!
    // The SET clause specifically — this statement legitimately mentions
    // auth_user_id in its WHERE, as the guard that it is stamping the right row.
    const setClause = norm(update.text).replace(/^.*\bSET\b/i, '').replace(/\bWHERE\b.*$/i, '')
    expect(setClause).not.toContain('auth_user_id')
  })

  it('attributes the transaction to the app_user id, not the auth user id', async () => {
    await resolvePlatformLogin(AUTH_ID, 'reetmitra8@gmail.com')
    expect(txActors).toEqual([APP_USER_ID])
  })
})

describe('resolvePlatformLogin — first login links the row', () => {
  beforeEach(() => {
    poolQuery.mockResolvedValue({ rows: [{ id: APP_USER_ID }], rowCount: 1 })
  })

  it('locks the row, links auth_user_id and returns the id', async () => {
    txResults = [
      { rows: [{ auth_user_id: null }], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]
    expect(await resolvePlatformLogin(AUTH_ID, 'reetmitra8@gmail.com')).toBe(APP_USER_ID)

    const sql = norm(txSql())
    expect(sql).toMatch(/SELECT auth_user_id FROM app_user WHERE id = \$1 FOR UPDATE/i)
    expect(sql).toContain('SET auth_user_id = $2')
    expect(sql).toContain('last_login_at = now()')
    expect(txStatements[1].values).toEqual([APP_USER_ID, AUTH_ID])
  })

  it('re-asserts auth_user_id IS NULL in the UPDATE so a concurrent link cannot be clobbered', async () => {
    txResults = [
      { rows: [{ auth_user_id: null }], rowCount: 1 },
      { rows: [], rowCount: 1 },
    ]
    await resolvePlatformLogin(AUTH_ID, 'reetmitra8@gmail.com')
    const update = txStatements.find((s) => /SET auth_user_id/i.test(s.text))!
    expect(norm(update.text)).toMatch(/WHERE id = \$1 AND auth_user_id IS NULL/i)
  })

  it('loses cleanly when the lock is released by a login that linked the row to ANOTHER auth user', async () => {
    txResults = [{ rows: [{ auth_user_id: 'someone-else' }], rowCount: 1 }]
    expect(await resolvePlatformLogin(AUTH_ID, 'reetmitra8@gmail.com')).toBeNull()
    expect(txSql()).not.toMatch(/UPDATE app_user/i)
  })

  it('returns null when the linking UPDATE matches no row', async () => {
    txResults = [
      { rows: [{ auth_user_id: null }], rowCount: 1 },
      { rows: [], rowCount: 0 },
    ]
    expect(await resolvePlatformLogin(AUTH_ID, 'reetmitra8@gmail.com')).toBeNull()
  })

  it('returns null when the row vanished between the lookup and the lock', async () => {
    txResults = [{ rows: [], rowCount: 0 }]
    expect(await resolvePlatformLogin(AUTH_ID, 'reetmitra8@gmail.com')).toBeNull()
    expect(txSql()).not.toMatch(/UPDATE app_user/i)
  })
})
