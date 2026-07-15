import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildChain, makeFrom, makeServerModuleMock } from './supabaseChainMock'
import { AppError } from '@/lib/types'

let fromImpl: (table: string) => unknown

vi.mock('@/lib/supabase/server', () => makeServerModuleMock(() => fromImpl))

import {
  assignDevice,
  listAssignees,
  unassignDevice,
  getAssignedDeviceIds,
} from '@/lib/services/assignmentService'

async function catchErr(p: Promise<unknown>): Promise<AppError> {
  return p.then(() => { throw new Error('expected rejection') }, (e) => e as AppError)
}

// Counts from() calls so permission-gate tests can prove no DB access happened.
let dbCalls = 0

beforeEach(() => {
  dbCalls = 0
  fromImpl = () => { dbCalls++; return buildChain({ data: null, error: null }) }
})

describe('assignDevice', () => {
  it('denies a viewer actor (permission error)', async () => {
    const err = await catchErr(assignDevice('dev-1', 'user-1', 'actor-1', 'viewer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('permission')
  })

  it('rejects a soft-deleted device (validation error)', async () => {
    fromImpl = makeFrom({
      device: [{ data: { id: 'dev-1', deleted_at: '2020-01-01T00:00:00Z' }, error: null }],
    })
    const err = await catchErr(assignDevice('dev-1', 'user-1', 'actor-1', 'engineer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('validation')
  })

  it('rejects an inactive target user (validation error)', async () => {
    fromImpl = makeFrom({
      device: [{ data: { id: 'dev-1', deleted_at: null }, error: null }],
      app_user: [{ data: { id: 'user-1', role: 'engineer', active: false }, error: null }],
    })
    const err = await catchErr(assignDevice('dev-1', 'user-1', 'actor-1', 'engineer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('validation')
  })

  it('rejects a viewer target user (validation error)', async () => {
    fromImpl = makeFrom({
      device: [{ data: { id: 'dev-1', deleted_at: null }, error: null }],
      app_user: [{ data: { id: 'user-1', role: 'viewer', active: true }, error: null }],
    })
    const err = await catchErr(assignDevice('dev-1', 'user-1', 'actor-1', 'engineer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('validation')
  })

  it('happy path upserts the assignment', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({
      device: [{ data: { id: 'dev-1', deleted_at: null }, error: null }],
      app_user: [{ data: { id: 'user-1', role: 'engineer', active: true }, error: null }],
      device_assignment: [{ data: null, error: null }],
    }, captures)

    await assignDevice('dev-1', 'user-1', 'actor-1', 'admin')
    const upsertArgs = captures['device_assignment.upsert']
    expect(upsertArgs).toBeDefined()
    const payload = upsertArgs[0][0] as Record<string, unknown>
    expect(payload.device_id).toBe('dev-1')
    expect(payload.user_id).toBe('user-1')
    expect(payload.assigned_by).toBe('actor-1')
  })
})

describe('listAssignees', () => {
  it('returns only the non-null joined app_user rows, ordered by assigned_at asc', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({
      device_assignment: [{ data: [
        { app_user: { id: 'u1', email: 'a@x.com' } },
        { app_user: null },                            // dangling assignment → dropped
        { app_user: { id: 'u2', email: 'b@x.com' } },
      ], error: null }],
    }, captures)

    const result = await listAssignees('dev-1')
    expect(result).toEqual([{ id: 'u1', email: 'a@x.com' }, { id: 'u2', email: 'b@x.com' }])
    expect(captures['device_assignment.eq']).toContainEqual(['device_id', 'dev-1'])
    expect(captures['device_assignment.order']).toContainEqual(['assigned_at', { ascending: true }])
  })

  it('returns [] when the device has no assignees', async () => {
    fromImpl = makeFrom({ device_assignment: [{ data: [], error: null }] })
    expect(await listAssignees('dev-1')).toEqual([])
  })

  it('propagates a DB error as a thrown Error', async () => {
    fromImpl = makeFrom({ device_assignment: [{ data: null, error: { message: 'boom' } }] })
    await expect(listAssignees('dev-1')).rejects.toThrow('boom')
  })
})

describe('unassignDevice', () => {
  it('denies a viewer (permission error, no DB call)', async () => {
    const err = await catchErr(unassignDevice('dev-1', 'user-1', 'actor-1', 'viewer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('permission')
    expect(dbCalls).toBe(0)
  })

  it('deletes the assignment scoped to both device and user', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ device_assignment: [{ data: null, error: null }] }, captures)

    await unassignDevice('dev-1', 'user-1', 'actor-1', 'engineer')
    expect(captures['device_assignment.delete']).toBeDefined()
    expect(captures['device_assignment.eq']).toContainEqual(['device_id', 'dev-1'])
    expect(captures['device_assignment.eq']).toContainEqual(['user_id', 'user-1'])
  })

  it('propagates a DB error as a thrown Error', async () => {
    fromImpl = makeFrom({ device_assignment: [{ data: null, error: { message: 'nope' } }] })
    await expect(unassignDevice('dev-1', 'user-1', 'actor-1', 'admin')).rejects.toThrow('nope')
  })
})

describe('getAssignedDeviceIds', () => {
  it('maps the assignment rows to a flat device_id list, scoped to the user', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({
      device_assignment: [{ data: [{ device_id: 'd1' }, { device_id: 'd2' }], error: null }],
    }, captures)

    expect(await getAssignedDeviceIds('user-1')).toEqual(['d1', 'd2'])
    expect(captures['device_assignment.eq']).toContainEqual(['user_id', 'user-1'])
  })

  it('returns [] when the user has no assignments', async () => {
    fromImpl = makeFrom({ device_assignment: [{ data: [], error: null }] })
    expect(await getAssignedDeviceIds('user-1')).toEqual([])
  })

  it('propagates a DB error as a thrown Error', async () => {
    fromImpl = makeFrom({ device_assignment: [{ data: null, error: { message: 'boom' } }] })
    await expect(getAssignedDeviceIds('user-1')).rejects.toThrow('boom')
  })
})
