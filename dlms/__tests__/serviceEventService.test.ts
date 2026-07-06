import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildChain, makeFrom } from './supabaseChainMock'
import { AppError } from '@/lib/types'

let fromImpl: (table: string) => unknown

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({ from: (table: string) => fromImpl(table) }),
}))

import { addServiceEvent } from '@/lib/services/serviceEventService'

async function catchErr(p: Promise<unknown>): Promise<AppError> {
  return p.then(() => { throw new Error('expected rejection') }, (e) => e as AppError)
}

beforeEach(() => {
  fromImpl = () => buildChain({ data: null, error: null })
})

describe('addServiceEvent', () => {
  it('denies a viewer (permission error)', async () => {
    const err = await catchErr(
      addServiceEvent({ deviceId: 'dev-1', description: 'ok', occurredOn: '2025-06-15' }, 'actor-1', 'viewer'),
    )
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('permission')
  })

  it('rejects an impossible calendar date (validation error)', async () => {
    const err = await catchErr(
      addServiceEvent({ deviceId: 'dev-1', description: 'ok', occurredOn: '2025-13-40' }, 'actor-1', 'engineer'),
    )
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('validation')
  })

  it('rejects a non-ISO date format (validation error)', async () => {
    const err = await catchErr(
      addServiceEvent({ deviceId: 'dev-1', description: 'ok', occurredOn: '15/06/2025' }, 'actor-1', 'engineer'),
    )
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('validation')
  })

  it('happy path inserts a valid event', async () => {
    const captures: Record<string, unknown[][]> = {}
    const eventRow = { id: 'ev-1', device_id: 'dev-1', description: 'Replaced fan', occurred_on: '2025-06-15' }
    fromImpl = makeFrom({ service_event: [{ data: eventRow, error: null }] }, captures)

    const result = await addServiceEvent(
      { deviceId: 'dev-1', description: 'Replaced fan', occurredOn: '2025-06-15' }, 'actor-2', 'engineer',
    )
    expect(result).toEqual(eventRow)
    const payload = captures['service_event.insert'][0][0] as Record<string, unknown>
    expect(payload.device_id).toBe('dev-1')
    expect(payload.occurred_on).toBe('2025-06-15')
    expect(payload.created_by).toBe('actor-2')
  })
})
