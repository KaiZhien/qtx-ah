import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildChain, makeFrom, type QueryResult } from './supabaseChainMock'
import { AppError } from '@/lib/types'

// `dbCalls` counts every from() invocation, so permission-gate tests can prove the
// service short-circuited before touching the DB.
let dbCalls = 0
let fromImpl: (table: string) => unknown

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({ from: (table: string) => fromImpl(table) }),
}))

import {
  listSubscribers,
  addSubscriber,
  setSubscriberActive,
  deleteSubscriber,
} from '@/lib/services/reportSubscriberService'

async function catchErr(p: Promise<unknown>): Promise<AppError> {
  return p.then(() => { throw new Error('expected rejection') }, (e) => e as AppError)
}

const sub = (over: Record<string, unknown> = {}): QueryResult =>
  ({ data: { id: 's-1', email: 'a@b.com', active: true, created_at: '2025-06-15T00:00:00Z', ...over }, error: null })

beforeEach(() => {
  dbCalls = 0
  fromImpl = () => { dbCalls++; return buildChain({ data: null, error: null }) }
})

describe('listSubscribers', () => {
  it('returns rows newest-first (no permission gate — it is an ungated read)', async () => {
    const captures: Record<string, unknown[][]> = {}
    const rows = [{ id: 's-1', email: 'a@b.com', active: true, created_at: '2025-06-15T00:00:00Z' }]
    fromImpl = makeFrom({ report_subscriber: [{ data: rows, error: null }] }, captures)

    const result = await listSubscribers()
    expect(result).toEqual(rows)
    expect(captures['report_subscriber.order']).toContainEqual(['created_at', { ascending: false }])
  })

  it('returns [] when the table is empty', async () => {
    fromImpl = makeFrom({ report_subscriber: [{ data: null, error: null }] })
    expect(await listSubscribers()).toEqual([])
  })

  it('propagates a DB error as a thrown Error', async () => {
    fromImpl = makeFrom({ report_subscriber: [{ data: null, error: { message: 'boom' } }] })
    await expect(listSubscribers()).rejects.toThrow('boom')
  })
})

describe('addSubscriber', () => {
  it('denies a non-admin (permission error, no DB call)', async () => {
    const err = await catchErr(addSubscriber('a@b.com', 'engineer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('permission')
    expect(dbCalls).toBe(0)
  })

  it('normalizes the email to trimmed-lowercase and defaults active=true', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ report_subscriber: [sub({ email: 'foo@bar.com' })] }, captures)

    await addSubscriber('  Foo@BAR.CoM  ', 'admin')
    const payload = captures['report_subscriber.insert'][0][0] as Record<string, unknown>
    expect(payload.email).toBe('foo@bar.com')
    expect(payload.active).toBe(true)
  })

  it('returns the inserted subscriber row', async () => {
    fromImpl = makeFrom({ report_subscriber: [sub({ id: 's-9', email: 'new@x.com' })] })
    const result = await addSubscriber('new@x.com', 'admin')
    expect(result).toMatchObject({ id: 's-9', email: 'new@x.com' })
  })

  it('propagates a DB error (e.g. unique-violation) as a thrown Error', async () => {
    fromImpl = makeFrom({ report_subscriber: [{ data: null, error: { message: 'duplicate key' } }] })
    await expect(addSubscriber('dupe@x.com', 'admin')).rejects.toThrow('duplicate key')
  })
})

describe('setSubscriberActive', () => {
  it('denies a non-admin (permission error, no DB call)', async () => {
    const err = await catchErr(setSubscriberActive('s-1', false, 'engineer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('permission')
    expect(dbCalls).toBe(0)
  })

  it('updates the active flag scoped to the subscriber id', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ report_subscriber: [sub({ active: false })] }, captures)

    await setSubscriberActive('s-1', false, 'admin')
    const payload = captures['report_subscriber.update'][0][0] as Record<string, unknown>
    expect(payload.active).toBe(false)
    expect(captures['report_subscriber.eq']).toContainEqual(['id', 's-1'])
  })

  it('propagates a DB error as a thrown Error', async () => {
    fromImpl = makeFrom({ report_subscriber: [{ data: null, error: { message: 'nope' } }] })
    await expect(setSubscriberActive('s-1', true, 'admin')).rejects.toThrow('nope')
  })
})

describe('deleteSubscriber', () => {
  it('denies a non-admin (permission error, no DB call)', async () => {
    const err = await catchErr(deleteSubscriber('s-1', 'engineer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('permission')
    expect(dbCalls).toBe(0)
  })

  it('deletes scoped to the subscriber id', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ report_subscriber: [{ data: null, error: null }] }, captures)

    await deleteSubscriber('s-1', 'admin')
    expect(captures['report_subscriber.delete']).toBeDefined()
    expect(captures['report_subscriber.eq']).toContainEqual(['id', 's-1'])
  })

  it('propagates a DB error as a thrown Error', async () => {
    fromImpl = makeFrom({ report_subscriber: [{ data: null, error: { message: 'fk violation' } }] })
    await expect(deleteSubscriber('s-1', 'admin')).rejects.toThrow('fk violation')
  })
})
