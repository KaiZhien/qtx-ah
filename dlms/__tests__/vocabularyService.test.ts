import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildChain, makeFrom, type QueryResult } from './supabaseChainMock'
import { AppError } from '@/lib/types'

let fromImpl: (table: string) => unknown

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({ from: (table: string) => fromImpl(table) }),
}))

import {
  addStatusOption,
  addPhaseOption,
  toggleOptionActive,
  getStatuses,
  getPhases,
  getAllStatuses,
  getAllPhases,
} from '@/lib/services/vocabularyService'

const ADMIN = 'aaaaaaaa-0000-0000-0000-000000000001'

async function catchErr(p: Promise<unknown>): Promise<AppError> {
  return p.then(() => { throw new Error('expected rejection') }, (e) => e as AppError)
}

// addStatusOption/addPhaseOption first read the current max sort_order, then insert.
const maxOrder = (n: number | null): QueryResult =>
  ({ data: n === null ? null : { sort_order: n }, error: null })
const inserted = (row: Record<string, unknown>): QueryResult =>
  ({ data: row, error: null })

beforeEach(() => {
  fromImpl = () => buildChain({ data: null, error: null })
})

describe('addStatusOption', () => {
  it('denies a non-admin actor (permission error, no DB call)', async () => {
    const err = await catchErr(addStatusOption('new_code', 'New', '新', ADMIN, 'engineer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('permission')
  })

  it('inserts with updated_by = acting admin id', async () => {
    const captures: Record<string, unknown[][]> = {}
    // Queue: max-sort_order fetch → insert result.
    fromImpl = makeFrom(
      { status_option: [maxOrder(20), inserted({ code: 'new_code' })] },
      captures,
    )
    const result = await addStatusOption('new_code', 'New', '新', ADMIN, 'admin')
    expect(result).toEqual({ code: 'new_code' })
    const payload = captures['status_option.insert'][0][0] as Record<string, unknown>
    expect(payload.code).toBe('new_code')
    expect(payload.updated_by).toBe(ADMIN)
  })

  it('defaults is_terminal/is_initial to false when no flags are given', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom(
      { status_option: [maxOrder(20), inserted({ code: 'new_code' })] },
      captures,
    )
    await addStatusOption('new_code', 'New', '新', ADMIN, 'admin')
    const payload = captures['status_option.insert'][0][0] as Record<string, unknown>
    expect(payload.is_terminal).toBe(false)
    expect(payload.is_initial).toBe(false)
  })

  it('spreads the terminal/initial flags into the insert payload', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom(
      { status_option: [maxOrder(20), inserted({ code: 'RMA' })] },
      captures,
    )
    await addStatusOption('RMA', 'RMA', '返修', ADMIN, 'admin', { isTerminal: true, isInitial: false })
    const payload = captures['status_option.insert'][0][0] as Record<string, unknown>
    expect(payload.is_terminal).toBe(true)
    expect(payload.is_initial).toBe(false)
  })
})

describe('addPhaseOption', () => {
  it('denies a non-admin actor (permission error, no DB call)', async () => {
    const err = await catchErr(addPhaseOption('new_code', 'New', '新', ADMIN, 'engineer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('permission')
  })

  it('inserts with updated_by = acting admin id', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom(
      { phase_option: [maxOrder(null), inserted({ code: 'new_code' })] },
      captures,
    )
    const result = await addPhaseOption('new_code', 'New', '新', ADMIN, 'admin')
    expect(result).toEqual({ code: 'new_code' })
    const payload = captures['phase_option.insert'][0][0] as Record<string, unknown>
    expect(payload.code).toBe('new_code')
    expect(payload.updated_by).toBe(ADMIN)
  })
})

describe('toggleOptionActive', () => {
  it('denies a non-admin actor (permission error, no DB call)', async () => {
    const err = await catchErr(
      toggleOptionActive('status_option', 'some_code', false, ADMIN, 'engineer'),
    )
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('permission')
  })

  it('updates status_option with active flag and updated_by = acting admin id', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ status_option: [{ data: null, error: null }] }, captures)
    await toggleOptionActive('status_option', 'some_code', false, ADMIN, 'admin')
    const payload = captures['status_option.update'][0][0] as Record<string, unknown>
    expect(payload.active).toBe(false)
    expect(payload.updated_by).toBe(ADMIN)
  })

  it('updates phase_option with active flag and updated_by = acting admin id', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ phase_option: [{ data: null, error: null }] }, captures)
    await toggleOptionActive('phase_option', 'some_code', true, ADMIN, 'admin')
    const payload = captures['phase_option.update'][0][0] as Record<string, unknown>
    expect(payload.active).toBe(true)
    expect(payload.updated_by).toBe(ADMIN)
  })
})

// status_option rows now carry is_terminal/is_initial transition flags — carried
// through the reads unchanged so isValidTransition can consume them downstream.
const STATUS_ROWS = [
  { code: 'Stock',   active: true,  is_initial: true,  is_terminal: false },
  { code: 'Retired', active: true,  is_initial: false, is_terminal: true  },
  { code: 'Legacy',  active: false, is_initial: false, is_terminal: false },
]
const PHASE_ROWS = [
  { code: 'Production', active: true },
  { code: 'Legacy',     active: false },
]

describe('getStatuses (active-only)', () => {
  it('filters to active rows, ordered by sort_order then code, preserving the flags', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ status_option: [{ data: STATUS_ROWS, error: null }] }, captures)
    const result = await getStatuses()
    expect(captures['status_option.eq']).toContainEqual(['active', true])
    expect(captures['status_option.order']).toContainEqual(['sort_order'])
    expect(captures['status_option.order']).toContainEqual(['code'])
    expect(result[0]).toMatchObject({ code: 'Stock', is_initial: true, is_terminal: false })
  })

  it('propagates a DB error', async () => {
    fromImpl = makeFrom({ status_option: [{ data: null, error: { message: 'boom' } }] })
    await expect(getStatuses()).rejects.toThrow('boom')
  })
})

describe('getPhases (active-only)', () => {
  it('filters to active rows, ordered by sort_order then code', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ phase_option: [{ data: PHASE_ROWS, error: null }] }, captures)
    await getPhases()
    expect(captures['phase_option.eq']).toContainEqual(['active', true])
    expect(captures['phase_option.order']).toContainEqual(['sort_order'])
  })
})

describe('getAllStatuses (active + inactive)', () => {
  it('does NOT filter on active (so inactive/terminal codes remain FK-valid targets)', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ status_option: [{ data: STATUS_ROWS, error: null }] }, captures)
    const result = await getAllStatuses()
    expect(captures['status_option.eq']).toBeUndefined()
    expect(result).toHaveLength(3)
    expect(result.map((s) => s.code)).toContain('Legacy')
  })

  it('returns [] when the table is empty', async () => {
    fromImpl = makeFrom({ status_option: [{ data: null, error: null }] })
    expect(await getAllStatuses()).toEqual([])
  })
})

describe('getAllPhases (active + inactive)', () => {
  it('does NOT filter on active', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ phase_option: [{ data: PHASE_ROWS, error: null }] }, captures)
    const result = await getAllPhases()
    expect(captures['phase_option.eq']).toBeUndefined()
    expect(result).toHaveLength(2)
  })
})
