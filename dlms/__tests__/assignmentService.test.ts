import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildChain, makeFrom } from './supabaseChainMock'
import { AppError } from '@/lib/types'

let fromImpl: (table: string) => unknown

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({ from: (table: string) => fromImpl(table) }),
}))

import { assignDevice } from '@/lib/services/assignmentService'

async function catchErr(p: Promise<unknown>): Promise<AppError> {
  return p.then(() => { throw new Error('expected rejection') }, (e) => e as AppError)
}

beforeEach(() => {
  fromImpl = () => buildChain({ data: null, error: null })
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
