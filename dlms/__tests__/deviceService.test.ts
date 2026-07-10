import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildChain, makeFrom, type QueryResult } from './supabaseChainMock'
import { AppError } from '@/lib/types'
import type { DeviceInput } from '@/lib/types'

// ---------------------------------------------------------------------------
// Mock the Supabase admin client (see analytics.test.ts pattern)
// ---------------------------------------------------------------------------
let fromImpl: (table: string) => unknown

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({ from: (table: string) => fromImpl(table) }),
}))

import {
  createDevice,
  updateDevice,
  changeStatus,
  softDeleteDevice,
} from '@/lib/services/deviceService'

const VALID_INPUT: DeviceInput = {
  pcba_a_sn: 'PA-001',
  pcba_a_hw_rev: 'V1',
  pcba_a_bom_rev: 'B1',
  pcba_a_fw_ver: '1.0.0',
  status: 'Stock',
  phase: 'Production',
}

async function catchErr(p: Promise<unknown>): Promise<AppError> {
  return p.then(() => { throw new Error('expected rejection') }, (e) => e as AppError)
}

beforeEach(() => {
  fromImpl = () => buildChain({ data: null, error: null })
})

describe('createDevice', () => {
  it('denies a viewer (permission error, no DB call)', async () => {
    const err = await catchErr(createDevice(VALID_INPUT, 'actor-1', 'viewer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('permission')
  })

  it('rejects invalid input with a validation error', async () => {
    const bad = { ...VALID_INPUT, pcba_a_sn: '' }
    const err = await catchErr(createDevice(bad as DeviceInput, 'actor-1', 'engineer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('validation')
  })

  it('happy path inserts with created_by/updated_by', async () => {
    const captures: Record<string, unknown[][]> = {}
    const deviceRow = { id: 'dev-1', ...VALID_INPUT }
    fromImpl = makeFrom({ device: [{ data: deviceRow, error: null }] }, captures)

    const result = await createDevice(VALID_INPUT, 'actor-1', 'engineer')
    expect(result).toEqual(deviceRow)

    const insertArgs = captures['device.insert']
    expect(insertArgs).toBeDefined()
    const payload = insertArgs[0][0] as Record<string, unknown>
    expect(payload.created_by).toBe('actor-1')
    expect(payload.updated_by).toBe('actor-1')
    expect(payload.pcba_a_sn).toBe('PA-001')
  })
})

describe('updateDevice', () => {
  it('rejects a version mismatch with a conflict error', async () => {
    fromImpl = makeFrom({ device: [{ data: { version: 5, deleted_at: null }, error: null }] })
    const err = await catchErr(updateDevice('dev-1', { customer: 'X' }, 3, 'actor-1', 'engineer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('conflict')
  })

  it('rejects editing a soft-deleted record with a validation error', async () => {
    fromImpl = makeFrom({ device: [{ data: { version: 1, deleted_at: '2020-01-01T00:00:00Z' }, error: null }] })
    const err = await catchErr(updateDevice('dev-1', { customer: 'X' }, 1, 'actor-1', 'engineer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('validation')
  })

  it('rejects an illegal status transition (Retired → In Use) with a conflict error', async () => {
    // Pre-UPDATE select now also returns status so the transition can be validated.
    fromImpl = makeFrom({ device: [{ data: { version: 1, deleted_at: null, status: 'Retired' }, error: null }] })
    const err = await catchErr(updateDevice('dev-1', { status: 'In Use' }, 1, 'actor-1', 'engineer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('conflict')
    expect(err.serviceError.message).toMatch(/transition/i)
  })

  it('allows a valid status transition (Stock → In Use) through to the update', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ device: [
      { data: { version: 1, deleted_at: null, status: 'Stock' }, error: null },  // pre-UPDATE select
      { data: { id: 'dev-1', status: 'In Use' }, error: null },                  // UPDATE ... select().single()
    ] }, captures)
    const result = await updateDevice('dev-1', { status: 'In Use' }, 1, 'actor-1', 'engineer')
    expect(result).toEqual({ id: 'dev-1', status: 'In Use' })
  })

  it('does not block a same-status write, even on a terminal status', async () => {
    // status unchanged (Retired → Retired) must not trigger the transition check.
    fromImpl = makeFrom({ device: [
      { data: { version: 1, deleted_at: null, status: 'Retired' }, error: null },
      { data: { id: 'dev-1', status: 'Retired', customer: 'X' }, error: null },
    ] })
    const result = await updateDevice('dev-1', { status: 'Retired', customer: 'X' }, 1, 'actor-1', 'engineer')
    expect(result).toEqual({ id: 'dev-1', status: 'Retired', customer: 'X' })
  })

  it('does not block a write that does not touch status (terminal device)', async () => {
    fromImpl = makeFrom({ device: [
      { data: { version: 2, deleted_at: null, status: 'Lost' }, error: null },
      { data: { id: 'dev-1', customer: 'Acme' }, error: null },
    ] })
    const result = await updateDevice('dev-1', { customer: 'Acme' }, 2, 'actor-1', 'engineer')
    expect(result).toEqual({ id: 'dev-1', customer: 'Acme' })
  })
})

// ---------------------------------------------------------------------------
// Centralized vocabulary validation (status/phase checked against the live
// vocabulary tables at the service layer — clear AppError instead of a DB FK).
// ---------------------------------------------------------------------------
const VOCAB_STATUSES: QueryResult = {
  data: [
    { code: 'Stock', active: true },
    { code: 'In Use', active: true },
    { code: 'Legacy', active: false },   // inactive but still FK-valid
  ],
  error: null,
}
const VOCAB_PHASES: QueryResult = {
  data: [
    { code: 'Production', active: true },
    { code: 'Validation', active: true },
  ],
  error: null,
}

describe('vocabulary validation (createDevice / updateDevice)', () => {
  it('rejects an unknown status with a validation error listing valid options', async () => {
    fromImpl = makeFrom({ status_option: [VOCAB_STATUSES] })
    const err = await catchErr(
      createDevice({ ...VALID_INPUT, status: 'Bogus' }, 'actor-1', 'engineer')
    )
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('validation')
    expect(err.serviceError.message).toContain('"Bogus"')
    expect(err.serviceError.message).toContain('Stock')   // lists the valid options
  })

  it('rejects an unknown phase with a validation error listing valid options', async () => {
    fromImpl = makeFrom({ status_option: [VOCAB_STATUSES], phase_option: [VOCAB_PHASES] })
    const err = await catchErr(
      createDevice({ ...VALID_INPUT, phase: 'Nope' }, 'actor-1', 'engineer')
    )
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('validation')
    expect(err.serviceError.message).toContain('"Nope"')
    expect(err.serviceError.message).toContain('Production')
  })

  it('accepts an admin-added code present in the live table (no hardcoded list)', async () => {
    const grown: QueryResult = {
      data: [...(VOCAB_STATUSES.data as unknown[]), { code: 'Quarantine', active: true }],
      error: null,
    }
    fromImpl = makeFrom({
      status_option: [grown],
      phase_option: [VOCAB_PHASES],
      device: [{ data: { id: 'dev-1' }, error: null }],
    })
    const result = await createDevice({ ...VALID_INPUT, status: 'Quarantine' }, 'actor-1', 'engineer')
    expect(result).toEqual({ id: 'dev-1' })
  })

  it('accepts an inactive-but-existing code (mirrors the DB FK exactly)', async () => {
    fromImpl = makeFrom({
      status_option: [VOCAB_STATUSES],
      phase_option: [VOCAB_PHASES],
      device: [{ data: { id: 'dev-1' }, error: null }],
    })
    const result = await createDevice({ ...VALID_INPUT, status: 'Legacy' }, 'actor-1', 'engineer')
    expect(result).toEqual({ id: 'dev-1' })
  })

  it('fails open (defers to the DB FK) when the vocabulary cannot be read', async () => {
    // status_option/phase_option resolve to empty → the write proceeds to insert.
    fromImpl = makeFrom({ device: [{ data: { id: 'dev-1' }, error: null }] })
    const result = await createDevice(VALID_INPUT, 'actor-1', 'engineer')
    expect(result).toEqual({ id: 'dev-1' })
  })

  it('updateDevice rejects an unknown status before touching the row', async () => {
    fromImpl = makeFrom({
      device: [{ data: { version: 1, deleted_at: null, status: 'Stock' }, error: null }],
      status_option: [VOCAB_STATUSES],
    })
    const err = await catchErr(updateDevice('dev-1', { status: 'Bogus' }, 1, 'actor-1', 'engineer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('validation')
    expect(err.serviceError.message).toContain('"Bogus"')
  })
})

describe('changeStatus', () => {
  it('rejects an invalid transition with a conflict error', async () => {
    // Current status 'Retired' is terminal → no transition is valid
    fromImpl = makeFrom({ device: [{ data: { id: 'dev-1', status: 'Retired', phase: 'MP' }, error: null }] })
    const err = await catchErr(changeStatus('dev-1', 'In Use', 'MP', 1, 'actor-1', 'engineer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('conflict')
  })
})

describe('softDeleteDevice', () => {
  it('denies a non-admin (permission error)', async () => {
    const err = await catchErr(softDeleteDevice('dev-1', 'actor-1', 'engineer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('permission')
  })

  it('sets deleted_at and updated_by on the update', async () => {
    const captures: Record<string, unknown[][]> = {}
    const result: QueryResult = { data: null, error: null }
    fromImpl = makeFrom({ device: [result] }, captures)

    await softDeleteDevice('dev-1', 'actor-9', 'admin')
    const updateArgs = captures['device.update']
    expect(updateArgs).toBeDefined()
    const payload = updateArgs[0][0] as Record<string, unknown>
    expect(typeof payload.deleted_at).toBe('string')
    expect(payload.updated_by).toBe('actor-9')
  })
})
