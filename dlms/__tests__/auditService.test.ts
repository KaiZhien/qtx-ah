import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildChain, makeFrom, makeServerModuleMock, type QueryResult } from './supabaseChainMock'

let fromImpl: (table: string) => unknown

vi.mock('@/lib/supabase/server', () => makeServerModuleMock(() => fromImpl))

import { getAuditLog, getDeviceHistory } from '@/lib/services/auditService'

// audit_log rows carry an embedded app_user (FK join) and a `count` alongside data.
const audit = (rows: unknown[], count = rows.length): QueryResult =>
  ({ data: rows, error: null, count } as unknown as QueryResult)

const auditRow = (over: Record<string, unknown> = {}) => ({
  id: 'a-1',
  actor_id: 'actor-1',
  app_user: { email: 'eng@qtx.com' },
  action: 'update',
  table_name: 'device',
  row_id: 'dev-1',
  old_values: { status: 'Stock' },
  new_values: { status: 'In Use' },
  changed_columns: ['status'],
  request_id: 'req-1',
  occurred_at: '2025-06-15T00:00:00Z',
  ...over,
})

beforeEach(() => {
  fromImpl = () => buildChain({ data: [], error: null, count: 0 } as unknown as QueryResult)
})

describe('getAuditLog — filter capture matrix', () => {
  it('applies no eq filters when no filter params are given', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ audit_log: [audit([])] }, captures)
    await getAuditLog({})
    expect(captures['audit_log.eq']).toBeUndefined()
  })

  it('maps tableFilter → eq(table_name)', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ audit_log: [audit([])] }, captures)
    await getAuditLog({ tableFilter: 'device' })
    expect(captures['audit_log.eq']).toContainEqual(['table_name', 'device'])
  })

  it('maps actorFilter → eq(actor_id)', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ audit_log: [audit([])] }, captures)
    await getAuditLog({ actorFilter: 'actor-9' })
    expect(captures['audit_log.eq']).toContainEqual(['actor_id', 'actor-9'])
  })

  it('maps actionFilter → eq(action)', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ audit_log: [audit([])] }, captures)
    await getAuditLog({ actionFilter: 'insert' })
    expect(captures['audit_log.eq']).toContainEqual(['action', 'insert'])
  })

  it('maps rowId → eq(row_id)', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ audit_log: [audit([])] }, captures)
    await getAuditLog({ rowId: 'dev-1' })
    expect(captures['audit_log.eq']).toContainEqual(['row_id', 'dev-1'])
  })

  it('combines every filter into the query at once', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ audit_log: [audit([])] }, captures)
    await getAuditLog({ tableFilter: 'device', actorFilter: 'actor-9', actionFilter: 'update', rowId: 'dev-1' })
    const eqs = captures['audit_log.eq']
    expect(eqs).toContainEqual(['table_name', 'device'])
    expect(eqs).toContainEqual(['actor_id', 'actor-9'])
    expect(eqs).toContainEqual(['action', 'update'])
    expect(eqs).toContainEqual(['row_id', 'dev-1'])
  })

  it('orders by occurred_at descending', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ audit_log: [audit([])] }, captures)
    await getAuditLog({})
    expect(captures['audit_log.order']).toContainEqual(['occurred_at', { ascending: false }])
  })
})

describe('getAuditLog — actor-email FK mapping', () => {
  it('lifts the joined app_user.email to actor_email', async () => {
    fromImpl = makeFrom({ audit_log: [audit([auditRow()])] })
    const { rows } = await getAuditLog({})
    expect(rows[0].actor_email).toBe('eng@qtx.com')
  })

  it('yields actor_email=null for a system/hard-delete row with no actor', async () => {
    fromImpl = makeFrom({ audit_log: [audit([auditRow({ actor_id: null, app_user: null })])] })
    const { rows } = await getAuditLog({})
    expect(rows[0].actor_id).toBeNull()
    expect(rows[0].actor_email).toBeNull()
  })

  it('coalesces a null new_values to an empty object (hard-delete rows)', async () => {
    fromImpl = makeFrom({ audit_log: [audit([auditRow({ new_values: null })])] })
    const { rows } = await getAuditLog({})
    expect(rows[0].new_values).toEqual({})
  })
})

describe('getAuditLog — pagination + count', () => {
  it('defaults to page 1 / pageSize 50 → range(0, 49)', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ audit_log: [audit([])] }, captures)
    await getAuditLog({})
    expect(captures['audit_log.range']).toContainEqual([0, 49])
  })

  it('computes the offset window for an arbitrary page/pageSize', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ audit_log: [audit([])] }, captures)
    await getAuditLog({ page: 3, pageSize: 20 })
    expect(captures['audit_log.range']).toContainEqual([40, 59])
  })

  it('returns the total from the exact count, independent of the page size', async () => {
    fromImpl = makeFrom({ audit_log: [audit([auditRow()], 137)] })
    const { total } = await getAuditLog({})
    expect(total).toBe(137)
  })

  it('returns total=0 when count comes back null', async () => {
    fromImpl = makeFrom({ audit_log: [{ data: [], error: null } as QueryResult] })
    const { total } = await getAuditLog({})
    expect(total).toBe(0)
  })
})

describe('getAuditLog — error propagation', () => {
  it('throws the DB error message', async () => {
    fromImpl = makeFrom({ audit_log: [{ data: null, error: { message: 'permission denied' } } as QueryResult] })
    await expect(getAuditLog({})).rejects.toThrow('permission denied')
  })
})

describe('getDeviceHistory', () => {
  it('filters to table=device + the device id and returns just the rows array', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ audit_log: [audit([auditRow()])] }, captures)
    const rows = await getDeviceHistory('dev-1')
    expect(Array.isArray(rows)).toBe(true)
    expect(rows[0].id).toBe('a-1')
    const eqs = captures['audit_log.eq']
    expect(eqs).toContainEqual(['table_name', 'device'])
    expect(eqs).toContainEqual(['row_id', 'dev-1'])
  })

  it('requests a wide page (pageSize 200) so per-device history is not truncated', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ audit_log: [audit([])] }, captures)
    await getDeviceHistory('dev-1')
    expect(captures['audit_log.range']).toContainEqual([0, 199])
  })
})
