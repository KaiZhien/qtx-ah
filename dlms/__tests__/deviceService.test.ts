import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildChain, makeFrom, makeServerModuleMock, type QueryResult } from './supabaseChainMock'
import { AppError } from '@/lib/types'
import type { DeviceInput } from '@/lib/types'

// ---------------------------------------------------------------------------
// Mock the Supabase admin client (see analytics.test.ts pattern)
// ---------------------------------------------------------------------------
let fromImpl: (table: string) => unknown

vi.mock('@/lib/supabase/server', () => makeServerModuleMock(() => fromImpl))

import {
  createDevice,
  updateDevice,
  changeStatus,
  softDeleteDevice,
  restoreDevice,
  listDevices,
} from '@/lib/services/deviceService'

const VALID_INPUT: DeviceInput = {
  pcba_a_sn: 'PA-001',
  pcba_a_hw_rev: 'V1',
  pcba_a_bom_rev: 'B1',
  pcba_a_fw_ver: '1.0.0',
  status: 'Stock',
  phase: 'Production',
}

// Seeded vocabulary WITH transition flags — drives isValidTransition. Includes an
// inactive code (Legacy), a terminal code (Retired), and an admin-added one (RMA).
const VOCAB_WITH_FLAGS: QueryResult = {
  data: [
    { code: 'Stock',   active: true,  is_initial: true,  is_terminal: false },
    { code: 'In Use',  active: true,  is_initial: false, is_terminal: false },
    { code: 'Repair',  active: true,  is_initial: false, is_terminal: false },
    { code: 'Retired', active: true,  is_initial: false, is_terminal: true  },
    { code: 'Legacy',  active: false, is_initial: false, is_terminal: false },
    { code: 'RMA',     active: true,  is_initial: false, is_terminal: false },
  ],
  error: null,
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

  it('rejects a transition OUT of a terminal status (Retired → In Use) with a conflict error', async () => {
    // Pre-UPDATE select now also returns status so the transition can be validated;
    // the vocabulary is fetched and passed to isValidTransition (Retired is terminal).
    fromImpl = makeFrom({
      device: [{ data: { version: 1, deleted_at: null, status: 'Retired' }, error: null }],
      status_option: [VOCAB_WITH_FLAGS],
    })
    const err = await catchErr(updateDevice('dev-1', { status: 'In Use' }, 1, 'actor-1', 'engineer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('conflict')
    expect(err.serviceError.message).toMatch(/transition/i)
  })

  it('allows a valid status transition (Stock → In Use) through to the update', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({
      device: [
        { data: { version: 1, deleted_at: null, status: 'Stock' }, error: null },  // pre-UPDATE select
        { data: { id: 'dev-1', status: 'In Use' }, error: null },                  // UPDATE ... select().single()
      ],
      status_option: [VOCAB_WITH_FLAGS],
    }, captures)
    const result = await updateDevice('dev-1', { status: 'In Use' }, 1, 'actor-1', 'engineer')
    expect(result).toEqual({ id: 'dev-1', status: 'In Use' })
  })

  it('allows a transition INTO an admin-added status (In Use → RMA)', async () => {
    fromImpl = makeFrom({
      device: [
        { data: { version: 1, deleted_at: null, status: 'In Use' }, error: null },
        { data: { id: 'dev-1', status: 'RMA' }, error: null },
      ],
      status_option: [VOCAB_WITH_FLAGS],
    })
    const result = await updateDevice('dev-1', { status: 'RMA' }, 1, 'actor-1', 'engineer')
    expect(result).toEqual({ id: 'dev-1', status: 'RMA' })
  })

  it('allows a transition OUT of an inactive status (Legacy → In Use)', async () => {
    // A device sitting in a deactivated status must still be able to move out.
    fromImpl = makeFrom({
      device: [
        { data: { version: 1, deleted_at: null, status: 'Legacy' }, error: null },
        { data: { id: 'dev-1', status: 'In Use' }, error: null },
      ],
      status_option: [VOCAB_WITH_FLAGS],
    })
    const result = await updateDevice('dev-1', { status: 'In Use' }, 1, 'actor-1', 'engineer')
    expect(result).toEqual({ id: 'dev-1', status: 'In Use' })
  })

  it('rejects a transition INTO an inactive status (In Use → Legacy) with a conflict error', async () => {
    fromImpl = makeFrom({
      device: [{ data: { version: 1, deleted_at: null, status: 'In Use' }, error: null }],
      status_option: [VOCAB_WITH_FLAGS],
    })
    const err = await catchErr(updateDevice('dev-1', { status: 'Legacy' }, 1, 'actor-1', 'engineer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('conflict')
    expect(err.serviceError.message).toMatch(/transition/i)
  })

  it('rejects a transition INTO an initial status (In Use → Stock) with a conflict error', async () => {
    fromImpl = makeFrom({
      device: [{ data: { version: 1, deleted_at: null, status: 'In Use' }, error: null }],
      status_option: [VOCAB_WITH_FLAGS],
    })
    const err = await catchErr(updateDevice('dev-1', { status: 'Stock' }, 1, 'actor-1', 'engineer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('conflict')
    expect(err.serviceError.message).toMatch(/transition/i)
  })

  it('fails closed on the transition when the vocabulary cannot be read (existence check stays fail-open)', async () => {
    // status_option resolves empty → assertVocabValid does NOT raise a validation
    // error (existence fail-open), but the transition check fails closed: with no
    // vocabulary there are no allowed targets, so the move is rejected as a conflict.
    fromImpl = makeFrom({
      device: [{ data: { version: 1, deleted_at: null, status: 'Stock' }, error: null }],
    })
    const err = await catchErr(updateDevice('dev-1', { status: 'In Use' }, 1, 'actor-1', 'engineer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('conflict')
    expect(err.serviceError.message).toMatch(/transition/i)
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
    // Current status 'Retired' is terminal → no transition is valid. changeStatus
    // fetches getAllStatuses() for its pre-check, so the vocabulary is mocked.
    fromImpl = makeFrom({
      device: [{ data: { id: 'dev-1', status: 'Retired', phase: 'MP' }, error: null }],
      status_option: [VOCAB_WITH_FLAGS],
    })
    const err = await catchErr(changeStatus('dev-1', 'In Use', 'MP', 1, 'actor-1', 'engineer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('conflict')
  })

  it('allows a valid transition into an admin-added status through to the update', async () => {
    // getDevice → getAllStatuses (pre-check) → updateDevice (re-fetch + getAllStatuses + update).
    fromImpl = makeFrom({
      device: [
        { data: { id: 'dev-1', status: 'In Use', phase: 'Production' }, error: null },  // getDevice
        { data: { version: 1, deleted_at: null, status: 'In Use' }, error: null },       // updateDevice pre-select
        { data: { id: 'dev-1', status: 'RMA', phase: 'Production' }, error: null },       // updateDevice update
      ],
      status_option: [VOCAB_WITH_FLAGS],
    })
    const result = await changeStatus('dev-1', 'RMA', 'Production', 1, 'actor-1', 'engineer')
    expect(result).toEqual({ id: 'dev-1', status: 'RMA', phase: 'Production' })
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

describe('restoreDevice', () => {
  it('denies a non-admin (permission error, no DB call)', async () => {
    const err = await catchErr(restoreDevice('dev-1', 1, 'actor-1', 'engineer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('permission')
  })

  it('rejects when the device does not exist', async () => {
    fromImpl = makeFrom({ device: [{ data: null, error: { message: 'not found' } }] })
    const err = await catchErr(restoreDevice('missing', 1, 'actor-9', 'admin'))
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/not found/i)
  })

  it('rejects restoring a device that is not deleted (validation error)', async () => {
    fromImpl = makeFrom({ device: [{ data: { version: 1, deleted_at: null }, error: null }] })
    const err = await catchErr(restoreDevice('dev-1', 1, 'actor-9', 'admin'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('validation')
    expect(err.serviceError.message).toMatch(/not deleted/i)
  })

  it('rejects a version mismatch with a conflict error', async () => {
    fromImpl = makeFrom({ device: [{ data: { version: 5, deleted_at: '2020-01-01T00:00:00Z' }, error: null }] })
    const err = await catchErr(restoreDevice('dev-1', 3, 'actor-9', 'admin'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('conflict')
  })

  it('clears deleted_at and sets updated_by on the update (happy path)', async () => {
    const captures: Record<string, unknown[][]> = {}
    const restoredRow = { id: 'dev-1', deleted_at: null, version: 3 }
    fromImpl = makeFrom({ device: [
      { data: { version: 2, deleted_at: '2020-01-01T00:00:00Z' }, error: null },  // pre-UPDATE fetch (incl. deleted)
      { data: restoredRow, error: null },                                          // UPDATE ... select().single()
    ] }, captures)

    const result = await restoreDevice('dev-1', 2, 'actor-9', 'admin')
    expect(result).toEqual(restoredRow)

    const updateArgs = captures['device.update']
    expect(updateArgs).toBeDefined()
    const payload = updateArgs[0][0] as Record<string, unknown>
    expect(payload.deleted_at).toBeNull()
    expect(payload.updated_by).toBe('actor-9')
    // version is bumped by the DB trigger (OLD.version + 1) — never set in the payload
    expect('version' in payload).toBe(false)

    // Optimistic concurrency: the UPDATE re-checks the expected version
    const eqArgs = captures['device.eq'] ?? []
    expect(eqArgs).toContainEqual(['version', 2])
  })
})

// ---------------------------------------------------------------------------
// listDevices — the filter/sort/pagination matrix. These assert the query the
// service composes (captured builder calls), not SQL, per the house convention.
// A `count` rides alongside `data` on the awaited result to drive `total`.
// ---------------------------------------------------------------------------
const page = (rows: unknown[], count = rows.length): QueryResult =>
  ({ data: rows, error: null, count } as unknown as QueryResult)

describe('listDevices — soft-delete visibility', () => {
  it('defaults to active-only via is(deleted_at, null)', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ device: [page([])] }, captures)
    await listDevices({})
    expect(captures['device.is']).toContainEqual(['deleted_at', null])
    expect(captures['device.not']).toBeUndefined()
  })

  it('deleted:true returns ONLY soft-deleted rows via not(deleted_at, is, null)', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ device: [page([])] }, captures)
    await listDevices({ deleted: true })
    expect(captures['device.not']).toContainEqual(['deleted_at', 'is', null])
    expect(captures['device.is']).toBeUndefined()
  })

  it('includeDeleted:true filters neither way (returns active + deleted)', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ device: [page([])] }, captures)
    await listDevices({ includeDeleted: true })
    expect(captures['device.is']).toBeUndefined()
    expect(captures['device.not']).toBeUndefined()
  })
})

describe('listDevices — search', () => {
  it('fans a sanitized, upper-cased term across the 8 searchable columns via or()', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ device: [page([])] }, captures)
    await listDevices({ search: 'pa-001' })
    const orArg = captures['device.or'][0][0] as string
    for (const colFrag of [
      'pcba_a_sn_normalized.ilike.%PA-001%',
      'pcba_b_sn_normalized.ilike.%PA-001%',
      'device_sn_normalized.ilike.%PA-001%',
      'customer.ilike.%PA-001%',
      'product_name.ilike.%PA-001%',
      'model_no.ilike.%PA-001%',
      'screen_model.ilike.%PA-001%',
      'destination.ilike.%PA-001%',
    ]) {
      expect(orArg).toContain(colFrag)
    }
  })

  it('rejects a search term with PostgREST filter-injection characters (validation error)', async () => {
    const err = await catchErr(listDevices({ search: 'a,b)(' }))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('validation')
  })
})

describe('listDevices — scalar filters', () => {
  it('applies status and phase as exact eq matches', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ device: [page([])] }, captures)
    await listDevices({ status: 'In Use', phase: 'MP' })
    expect(captures['device.eq']).toContainEqual(['status', 'In Use'])
    expect(captures['device.eq']).toContainEqual(['phase', 'MP'])
  })

  it('applies customer and model as case-insensitive ilike contains', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ device: [page([])] }, captures)
    await listDevices({ customer: 'Acme', model: 'QTX' })
    expect(captures['device.ilike']).toContainEqual(['customer', '%Acme%'])
    expect(captures['device.ilike']).toContainEqual(['model_no', '%QTX%'])
  })

  it('bounds build_date and ship_date with gte/lte', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ device: [page([])] }, captures)
    await listDevices({ buildDateFrom: '2025-01-01', buildDateTo: '2025-12-31', shipDateFrom: '2025-02-01', shipDateTo: '2025-11-30' })
    expect(captures['device.gte']).toContainEqual(['build_date', '2025-01-01'])
    expect(captures['device.lte']).toContainEqual(['build_date', '2025-12-31'])
    expect(captures['device.gte']).toContainEqual(['ship_date', '2025-02-01'])
    expect(captures['device.lte']).toContainEqual(['ship_date', '2025-11-30'])
  })

  it('applies each of the 8 traceability revision fields as an exact eq', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ device: [page([])] }, captures)
    await listDevices({
      pcba_a_hw_rev: 'HA', pcba_a_bom_rev: 'BA', pcba_a_fw_ver: 'FA',
      pcba_b_hw_rev: 'HB', pcba_b_bom_rev: 'BB', pcba_b_fw_ver: 'FB',
      screen_model: 'SM', hmi_ver: 'HV',
    })
    const eqs = captures['device.eq']
    for (const pair of [
      ['pcba_a_hw_rev', 'HA'], ['pcba_a_bom_rev', 'BA'], ['pcba_a_fw_ver', 'FA'],
      ['pcba_b_hw_rev', 'HB'], ['pcba_b_bom_rev', 'BB'], ['pcba_b_fw_ver', 'FB'],
      ['screen_model', 'SM'], ['hmi_ver', 'HV'],
    ]) {
      expect(eqs).toContainEqual(pair)
    }
  })
})

describe('listDevices — myQueue + serviceOverdue id pre-resolution', () => {
  it('resolves the user\'s assigned ids then constrains with in(id, ids)', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({
      device: [page([])],
      device_assignment: [{ data: [{ device_id: 'd1' }, { device_id: 'd2' }], error: null }],
    }, captures)
    await listDevices({ myQueueUserId: 'user-1' })
    expect(captures['device_assignment.eq']).toContainEqual(['user_id', 'user-1'])
    expect(captures['device.in']).toContainEqual(['id', ['d1', 'd2']])
  })

  it('short-circuits to an empty page when the user has zero assignments (no id filter)', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({
      device: [page([{ id: 'x' }], 99)],
      device_assignment: [{ data: [], error: null }],
    }, captures)
    const result = await listDevices({ myQueueUserId: 'user-1' })
    expect(result).toEqual({ rows: [], total: 0 })
    expect(captures['device.in']).toBeUndefined()
  })

  it('resolves overdue ids then constrains with in(id, ids)', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({
      device: [
        page([]),                                                              // main query
        { data: [{ id: 'd1', ship_date: '2020-01-01' }], error: null },        // overdue scan
      ],
      service_event: [{ data: [], error: null }],
    }, captures)
    await listDevices({ serviceOverdue: true })
    expect(captures['device.in']).toContainEqual(['id', ['d1']])
  })

  it('short-circuits to an empty page when nothing is overdue', async () => {
    fromImpl = makeFrom({
      device: [
        page([{ id: 'x' }], 99),
        { data: [{ id: 'd1', ship_date: null }], error: null },  // no baseline → not overdue
      ],
      service_event: [{ data: [], error: null }],
    })
    const result = await listDevices({ serviceOverdue: true })
    expect(result).toEqual({ rows: [], total: 0 })
  })

  it('intersects assigned and overdue ids when both filters are set', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({
      device: [
        page([]),                                                              // main query
        { data: [{ id: 'd2', ship_date: '2020-01-01' }, { id: 'd3', ship_date: '2020-01-01' }], error: null },
      ],
      device_assignment: [{ data: [{ device_id: 'd1' }, { device_id: 'd2' }], error: null }],
      service_event: [{ data: [], error: null }],
    }, captures)
    await listDevices({ myQueueUserId: 'user-1', serviceOverdue: true })
    expect(captures['device.in']).toContainEqual(['id', ['d2']])
  })
})

describe('listDevices — sort + pagination', () => {
  it('defaults to created_at DESC and the first page window range(0, 49)', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ device: [page([])] }, captures)
    await listDevices({})
    expect(captures['device.order']).toContainEqual(['created_at', { ascending: false }])
    expect(captures['device.range']).toContainEqual([0, 49])
  })

  it('honors an allow-listed sort column + direction', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ device: [page([])] }, captures)
    await listDevices({ sort: 'customer', dir: 'desc' })
    expect(captures['device.order']).toContainEqual(['customer', { ascending: false }])
  })

  it('falls back to created_at for a non-allow-listed sort column (injection guard)', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ device: [page([])] }, captures)
    await listDevices({ sort: 'password; DROP TABLE', dir: 'asc' })
    // The column is coerced back to created_at (only the direction honors dir=asc).
    expect(captures['device.order']).toContainEqual(['created_at', { ascending: true }])
  })

  it('computes the page window for an explicit page/pageSize and passes the count through as total', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ device: [page([{ id: 'a' }], 42)] }, captures)
    const { total } = await listDevices({ page: 2, pageSize: 10 })
    expect(captures['device.range']).toContainEqual([10, 19])
    expect(total).toBe(42)
  })
})
