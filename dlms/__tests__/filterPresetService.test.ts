import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildChain, makeFrom, makeServerModuleMock } from './supabaseChainMock'
import { AppError } from '@/lib/types'

let fromImpl: (table: string) => unknown

vi.mock('@/lib/supabase/server', () => makeServerModuleMock(() => fromImpl))

import { savePreset, deletePreset, listPresets } from '@/lib/services/filterPresetService'

async function catchErr(p: Promise<unknown>): Promise<AppError> {
  return p.then(() => { throw new Error('expected rejection') }, (e) => e as AppError)
}

beforeEach(() => {
  fromImpl = () => buildChain({ data: null, error: null })
})

describe('savePreset', () => {
  it('denies the system role (permission error)', async () => {
    const err = await catchErr(savePreset('actor-1', 'My filter', 'status=active', 'system'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('permission')
  })

  it('happy path inserts with the acting user as owner', async () => {
    const captures: Record<string, unknown[][]> = {}
    const row = { id: 'p-1', name: 'My filter', query_string: 'status=active', created_at: '2025-06-15T00:00:00Z' }
    fromImpl = makeFrom({ device_filter_preset: [{ data: row, error: null }] }, captures)

    const result = await savePreset('actor-2', 'My filter', 'status=active', 'engineer')
    expect(result).toEqual(row)
    const payload = captures['device_filter_preset.insert'][0][0] as Record<string, unknown>
    expect(payload.owner_id).toBe('actor-2')
    expect(payload.name).toBe('My filter')
    expect(payload.query_string).toBe('status=active')
  })
})

describe('deletePreset', () => {
  it('denies the system role (permission error)', async () => {
    const err = await catchErr(deletePreset('p-1', 'actor-1', 'system'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('permission')
  })

  it('scopes the delete to the acting user as owner', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ device_filter_preset: [{ data: null, error: null }] }, captures)

    await deletePreset('p-1', 'actor-2', 'admin')
    const eqCalls = captures['device_filter_preset.eq']
    expect(eqCalls).toContainEqual(['id', 'p-1'])
    expect(eqCalls).toContainEqual(['owner_id', 'actor-2'])
  })
})

describe('listPresets', () => {
  it('returns the user\'s presets newest-first, capped at 20 (ungated read)', async () => {
    const captures: Record<string, unknown[][]> = {}
    const rows = [{ id: 'p-1', name: 'A', query_string: 'status=Stock', created_at: '2025-06-15T00:00:00Z' }]
    fromImpl = makeFrom({ device_filter_preset: [{ data: rows, error: null }] }, captures)

    expect(await listPresets('actor-2')).toEqual(rows)
    expect(captures['device_filter_preset.eq']).toContainEqual(['owner_id', 'actor-2'])
    expect(captures['device_filter_preset.order']).toContainEqual(['created_at', { ascending: false }])
    expect(captures['device_filter_preset.limit']).toContainEqual([20])
  })

  it('returns [] when the user has no presets', async () => {
    fromImpl = makeFrom({ device_filter_preset: [{ data: null, error: null }] })
    expect(await listPresets('actor-2')).toEqual([])
  })
})
