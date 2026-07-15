import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildChain, makeFrom, makeServerModuleMock, type QueryResult } from './supabaseChainMock'

let fromImpl: (table: string) => unknown

vi.mock('@/lib/supabase/server', () => makeServerModuleMock(() => fromImpl))

import {
  getUpcomingServiceCount,
  getOverdueServiceDeviceIds,
  getOverdueServiceCount,
} from '@/lib/services/serviceScheduleService'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

const count = (n: number | null): QueryResult =>
  ({ data: null, error: null, count: n } as unknown as QueryResult)

beforeEach(() => {
  fromImpl = () => buildChain({ data: [], error: null } as QueryResult)
})

describe('getUpcomingServiceCount', () => {
  it('filters to non-deleted devices with a next_service_date inside the window', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ device: [count(4)] }, captures)

    const result = await getUpcomingServiceCount(7)
    expect(result).toBe(4)
    expect(captures['device.is']).toContainEqual(['deleted_at', null])
    expect(captures['device.not']).toContainEqual(['next_service_date', 'is', null])
  })

  it('bounds the window with gte(today) / lte(future) as YYYY-MM-DD strings', async () => {
    // No injected clock in the service — assert the shape of the date bounds, not exact values.
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ device: [count(0)] }, captures)

    await getUpcomingServiceCount(7)
    const gte = captures['device.gte'][0]
    const lte = captures['device.lte'][0]
    expect(gte[0]).toBe('next_service_date')
    expect(lte[0]).toBe('next_service_date')
    expect(gte[1]).toMatch(ISO_DATE)
    expect(lte[1]).toMatch(ISO_DATE)
    // The upper bound is `days` in the future, so it never precedes the lower bound.
    expect(gte[1] as string <= (lte[1] as string)).toBe(true)
  })

  it('returns 0 when the count comes back null', async () => {
    fromImpl = makeFrom({ device: [count(null)] })
    expect(await getUpcomingServiceCount()).toBe(0)
  })

  it('propagates a DB error as a thrown Error', async () => {
    fromImpl = makeFrom({ device: [{ data: null, error: { message: 'boom' } } as QueryResult] })
    await expect(getUpcomingServiceCount()).rejects.toThrow('boom')
  })
})

describe('getOverdueServiceDeviceIds', () => {
  it('flags a device overdue by its ship_date when it has no service event', async () => {
    // ship_date far in the past → overdue regardless of the real "today".
    fromImpl = makeFrom({
      device: [{ data: [{ id: 'dev-1', ship_date: '2020-01-01' }], error: null }],
      service_event: [{ data: [], error: null }],
    })
    expect(await getOverdueServiceDeviceIds()).toEqual(['dev-1'])
  })

  it('uses the LATEST service event per device when building the recency map', async () => {
    // Two events for dev-1: an ancient one and a far-future one. If the map picked
    // the max date (correct), the device is NOT overdue; picking the min would wrongly
    // flag it. Asserting "not overdue" pins the max-selection behavior.
    fromImpl = makeFrom({
      device: [{ data: [{ id: 'dev-1', ship_date: '2020-01-01' }], error: null }],
      service_event: [{ data: [
        { device_id: 'dev-1', occurred_on: '2020-01-01' },
        { device_id: 'dev-1', occurred_on: '2099-12-31' },
      ], error: null }],
    })
    expect(await getOverdueServiceDeviceIds()).toEqual([])
  })

  it('excludes a device with neither a service event nor a ship_date baseline', async () => {
    fromImpl = makeFrom({
      device: [{ data: [{ id: 'dev-1', ship_date: null }], error: null }],
      service_event: [{ data: [], error: null }],
    })
    expect(await getOverdueServiceDeviceIds()).toEqual([])
  })

  it('returns [] for an empty device set', async () => {
    fromImpl = makeFrom({
      device: [{ data: [], error: null }],
      service_event: [{ data: [], error: null }],
    })
    expect(await getOverdueServiceDeviceIds()).toEqual([])
  })

  it('propagates a device-query error', async () => {
    fromImpl = makeFrom({ device: [{ data: null, error: { message: 'device boom' } } as QueryResult] })
    await expect(getOverdueServiceDeviceIds()).rejects.toThrow('device boom')
  })

  it('propagates a service_event-query error', async () => {
    fromImpl = makeFrom({
      device: [{ data: [{ id: 'dev-1', ship_date: '2020-01-01' }], error: null }],
      service_event: [{ data: null, error: { message: 'event boom' } } as QueryResult],
    })
    await expect(getOverdueServiceDeviceIds()).rejects.toThrow('event boom')
  })
})

describe('getOverdueServiceCount', () => {
  it('returns the length of the overdue id list', async () => {
    fromImpl = makeFrom({
      device: [{ data: [
        { id: 'dev-1', ship_date: '2020-01-01' },
        { id: 'dev-2', ship_date: '2020-01-01' },
      ], error: null }],
      service_event: [{ data: [], error: null }],
    })
    expect(await getOverdueServiceCount()).toBe(2)
  })
})
