import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildChain, makeFrom, makeServerModuleMock } from './supabaseChainMock'
import { AppError } from '@/lib/types'

let fromImpl: (table: string) => unknown

vi.mock('@/lib/supabase/server', () => makeServerModuleMock(() => fromImpl))

import { linkReplacement, getPredecessor, getSuccessor } from '@/lib/services/successionService'

async function catchErr(p: Promise<unknown>): Promise<AppError> {
  return p.then(() => { throw new Error('expected rejection') }, (e) => e as AppError)
}

// Counts from() calls so the getSuccessor short-circuit can be proven DB-free.
let dbCalls = 0

beforeEach(() => {
  dbCalls = 0
  fromImpl = () => { dbCalls++; return buildChain({ data: null, error: null }) }
})

describe('linkReplacement', () => {
  it('rejects linking a device to itself (validation error)', async () => {
    const err = await catchErr(linkReplacement('dev-1', 'dev-1', 1, 'actor-1', 'engineer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('validation')
  })

  it('rejects a version mismatch on the old device (conflict error)', async () => {
    fromImpl = makeFrom({
      device: [{ data: { id: 'old', deleted_at: null, version: 5 }, error: null }],
    })
    const err = await catchErr(linkReplacement('old', 'new', 3, 'actor-1', 'engineer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('conflict')
  })

  it('rejects a deleted replacement target (validation error)', async () => {
    fromImpl = makeFrom({
      device: [
        { data: { id: 'old', deleted_at: null, version: 1 }, error: null },
        { data: { id: 'new', deleted_at: '2020-01-01T00:00:00Z', replaced_by: null }, error: null },
      ],
    })
    const err = await catchErr(linkReplacement('old', 'new', 1, 'actor-1', 'engineer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('validation')
  })

  it('rejects a link that would create a cycle (validation error)', async () => {
    // new's replacement chain already points back to old → cycle
    fromImpl = makeFrom({
      device: [
        { data: { id: 'old', deleted_at: null, version: 1 }, error: null },
        { data: { id: 'new', deleted_at: null, replaced_by: 'old' }, error: null },
      ],
    })
    const err = await catchErr(linkReplacement('old', 'new', 1, 'actor-1', 'engineer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('validation')
  })

  it('rejects a 0-row guarded update from a concurrent version bump (conflict error)', async () => {
    // Pre-checks pass, but the guarded UPDATE matches 0 rows because a concurrent
    // writer bumped `version` between the pre-check and the UPDATE. maybeSingle()
    // then returns null → the function must surface a conflict, not false success.
    fromImpl = makeFrom({
      device: [
        { data: { id: 'old', deleted_at: null, version: 1 }, error: null },
        { data: { id: 'new', deleted_at: null, replaced_by: null }, error: null },
        { data: null, error: null }, // UPDATE result — 0 rows matched
      ],
    })
    const err = await catchErr(linkReplacement('old', 'new', 1, 'actor-1', 'engineer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('conflict')
  })

  it('happy path updates replaced_by on the old device', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({
      device: [
        { data: { id: 'old', deleted_at: null, version: 1 }, error: null },
        { data: { id: 'new', deleted_at: null, replaced_by: null }, error: null },
        { data: { id: 'old' }, error: null }, // UPDATE result — 1 row matched (success)
      ],
    }, captures)

    await linkReplacement('old', 'new', 1, 'actor-7', 'admin')
    const updateArgs = captures['device.update']
    expect(updateArgs).toBeDefined()
    const payload = updateArgs[0][0] as Record<string, unknown>
    expect(payload.replaced_by).toBe('new')
    expect(payload.updated_by).toBe('actor-7')
  })
})

describe('getPredecessor', () => {
  it('finds the active device whose replaced_by points at this device', async () => {
    const captures: Record<string, unknown[][]> = {}
    const pred = { id: 'old', device_sn: 'DS-1', pcba_a_sn: 'PA-old' }
    fromImpl = makeFrom({ device: [{ data: pred, error: null }] }, captures)
    expect(await getPredecessor('new')).toEqual(pred)
    expect(captures['device.eq']).toContainEqual(['replaced_by', 'new'])
    expect(captures['device.is']).toContainEqual(['deleted_at', null])
  })

  it('returns null when nothing points at the device', async () => {
    fromImpl = makeFrom({ device: [{ data: null, error: null }] })
    expect(await getPredecessor('new')).toBeNull()
  })
})

describe('getSuccessor', () => {
  it('returns null without any DB call when there is no replaced_by id', async () => {
    expect(await getSuccessor('')).toBeNull()
    expect(dbCalls).toBe(0)
  })

  it('fetches the active successor device by id', async () => {
    const captures: Record<string, unknown[][]> = {}
    const succ = { id: 'new', device_sn: 'DS-2', pcba_a_sn: 'PA-new' }
    fromImpl = makeFrom({ device: [{ data: succ, error: null }] }, captures)
    expect(await getSuccessor('new')).toEqual(succ)
    expect(captures['device.eq']).toContainEqual(['id', 'new'])
    expect(captures['device.is']).toContainEqual(['deleted_at', null])
  })

  it('returns null when the successor id resolves to no row', async () => {
    fromImpl = makeFrom({ device: [{ data: null, error: null }] })
    expect(await getSuccessor('missing')).toBeNull()
  })
})
