import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildChain, makeFrom, makeServerModuleMock, type QueryResult } from './supabaseChainMock'
import { AppError } from '@/lib/types'

let fromImpl: (table: string) => unknown

vi.mock('@/lib/supabase/server', () => makeServerModuleMock(() => fromImpl))

import { updateUserRole, deactivateUser, listUsers, reactivateUser } from '@/lib/services/userService'

const ADMIN_1 = 'aaaaaaaa-0000-0000-0000-000000000001'
const ADMIN_2 = 'aaaaaaaa-0000-0000-0000-000000000002'
const ENGINEER = 'bbbbbbbb-0000-0000-0000-000000000002'

async function catchErr(p: Promise<unknown>): Promise<AppError> {
  return p.then(() => { throw new Error('expected rejection') }, (e) => e as AppError)
}

// Result helpers. countActiveAdmins destructures `count` off the awaited chain,
// so the count result carries a `count` property alongside data/error.
const target = (role: string, active = true): QueryResult =>
  ({ data: { role, active }, error: null })
const adminCount = (n: number): QueryResult =>
  ({ data: null, error: null, count: n } as unknown as QueryResult)
const updated = (row: Record<string, unknown>): QueryResult =>
  ({ data: row, error: null })

beforeEach(() => {
  fromImpl = () => buildChain({ data: null, error: null })
})

describe('updateUserRole', () => {
  it('denies a non-admin actor (permission error, no DB call)', async () => {
    const err = await catchErr(updateUserRole(ENGINEER, 'admin', ADMIN_1, 'engineer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('permission')
  })

  it('rejects demoting yourself (validation error, no DB call)', async () => {
    const err = await catchErr(updateUserRole(ADMIN_1, 'engineer', ADMIN_1, 'admin'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('validation')
    expect(err.serviceError.message).toMatch(/own role/i)
  })

  it('rejects demoting the last active admin (validation error)', async () => {
    // Queue: target fetch (admin, active) → active-admin count (1)
    fromImpl = makeFrom({ app_user: [target('admin'), adminCount(1)] })
    const err = await catchErr(updateUserRole(ADMIN_2, 'viewer', ADMIN_1, 'admin'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('validation')
    expect(err.serviceError.message).toMatch(/last active admin/i)
  })

  it('allows demoting an admin when another active admin remains', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom(
      { app_user: [target('admin'), adminCount(2), updated({ id: ADMIN_2, role: 'engineer' })] },
      captures,
    )
    const result = await updateUserRole(ADMIN_2, 'engineer', ADMIN_1, 'admin')
    expect(result).toEqual({ id: ADMIN_2, role: 'engineer' })
    const payload = captures['app_user.update'][0][0] as Record<string, unknown>
    expect(payload.role).toBe('engineer')
    // Audit actor attribution: the update carries the acting admin's id.
    expect(payload.updated_by).toBe(ADMIN_1)
  })

  it('allows promoting a non-admin to admin without consulting the admin count', async () => {
    const captures: Record<string, unknown[][]> = {}
    // Only ONE queued result: promotion (role === admin) skips the target fetch + count.
    fromImpl = makeFrom({ app_user: [updated({ id: ENGINEER, role: 'admin' })] }, captures)
    const result = await updateUserRole(ENGINEER, 'admin', ADMIN_1, 'admin')
    expect(result).toEqual({ id: ENGINEER, role: 'admin' })
  })

  it('does not apply the last-admin guard when demoting a non-admin', async () => {
    // Target is an engineer → the guard must not block even with a single admin.
    fromImpl = makeFrom({
      app_user: [target('engineer'), updated({ id: ENGINEER, role: 'viewer' })],
    })
    const result = await updateUserRole(ENGINEER, 'viewer', ADMIN_1, 'admin')
    expect(result).toEqual({ id: ENGINEER, role: 'viewer' })
  })
})

describe('deactivateUser', () => {
  it('denies a non-admin actor (permission error)', async () => {
    const err = await catchErr(deactivateUser(ENGINEER, ADMIN_1, 'engineer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('permission')
  })

  it('rejects deactivating yourself (validation error, no DB call)', async () => {
    const err = await catchErr(deactivateUser(ADMIN_1, ADMIN_1, 'admin'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('validation')
    expect(err.serviceError.message).toMatch(/own account/i)
  })

  it('rejects deactivating the last active admin (validation error)', async () => {
    fromImpl = makeFrom({ app_user: [target('admin'), adminCount(1)] })
    const err = await catchErr(deactivateUser(ADMIN_2, ADMIN_1, 'admin'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('validation')
    expect(err.serviceError.message).toMatch(/last active admin/i)
  })

  it('allows deactivating an admin when another active admin remains', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom(
      { app_user: [target('admin'), adminCount(2), updated({ id: ADMIN_2, active: false })] },
      captures,
    )
    const result = await deactivateUser(ADMIN_2, ADMIN_1, 'admin')
    expect(result).toEqual({ id: ADMIN_2, active: false })
    const payload = captures['app_user.update'][0][0] as Record<string, unknown>
    expect(payload.active).toBe(false)
    // Audit actor attribution: the update carries the acting admin's id.
    expect(payload.updated_by).toBe(ADMIN_1)
  })

  it('deactivates a non-admin without tripping the last-admin guard', async () => {
    fromImpl = makeFrom({
      app_user: [target('engineer'), updated({ id: ENGINEER, active: false })],
    })
    const result = await deactivateUser(ENGINEER, ADMIN_1, 'admin')
    expect(result).toEqual({ id: ENGINEER, active: false })
  })

  it('does not block deactivating an ALREADY-inactive admin (not counted as the last active one)', async () => {
    fromImpl = makeFrom({
      app_user: [target('admin', false), updated({ id: ADMIN_2, active: false })],
    })
    const result = await deactivateUser(ADMIN_2, ADMIN_1, 'admin')
    expect(result).toEqual({ id: ADMIN_2, active: false })
  })
})

describe('listUsers', () => {
  it('returns all users ordered by created_at', async () => {
    const captures: Record<string, unknown[][]> = {}
    const rows = [{ id: ADMIN_1, role: 'admin' }, { id: ENGINEER, role: 'engineer' }]
    fromImpl = makeFrom({ app_user: [{ data: rows, error: null }] }, captures)
    expect(await listUsers()).toEqual(rows)
    expect(captures['app_user.order']).toContainEqual(['created_at'])
  })

  it('returns [] when there are no users', async () => {
    fromImpl = makeFrom({ app_user: [{ data: null, error: null }] })
    expect(await listUsers()).toEqual([])
  })

  it('propagates a DB error', async () => {
    fromImpl = makeFrom({ app_user: [{ data: null, error: { message: 'boom' } }] })
    await expect(listUsers()).rejects.toThrow('boom')
  })
})

describe('reactivateUser', () => {
  it('denies a non-admin actor (permission error)', async () => {
    const err = await catchErr(reactivateUser(ENGINEER, ADMIN_1, 'engineer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('permission')
  })

  it('sets active=true and attributes the acting admin via updated_by', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ app_user: [updated({ id: ENGINEER, active: true })] }, captures)
    const result = await reactivateUser(ENGINEER, ADMIN_1, 'admin')
    expect(result).toEqual({ id: ENGINEER, active: true })
    const payload = captures['app_user.update'][0][0] as Record<string, unknown>
    expect(payload.active).toBe(true)
    expect(payload.updated_by).toBe(ADMIN_1)
    expect(captures['app_user.eq']).toContainEqual(['id', ENGINEER])
  })
})
