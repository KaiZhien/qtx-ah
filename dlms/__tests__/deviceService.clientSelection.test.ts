import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildChain, type QueryResult } from './supabaseChainMock'

// ---------------------------------------------------------------------------
// Client-selection tests — the security property of the RLS read-path migration.
//
// The shared makeServerModuleMock returns ONE client for all three factories,
// which hides read-vs-admin selection. Here we mock the module so createReadClient
// and createAdminClient return DISTINGUISHABLE clients: each records ('read'|'admin')
// + the table it touched into a shared `log`. That makes "which client did this
// operation use?" observable, so we can assert:
//   - pure reads (listDevices/getDevice/getDeviceStats) hit ONLY the read client
//   - write pre-reads + the UPDATE (updateDevice/changeStatus) hit ONLY the admin
//     client — routing them through the read client would break optimistic
//     concurrency (RLS could hide the very row the version check compares against)
//   - getDeviceByPcbaSn (duplicate pre-check feeding create) stays admin
// ---------------------------------------------------------------------------

type ClientTag = 'read' | 'admin'
let log: Array<{ client: ClientTag; table: string }> = []
let readResults: Record<string, QueryResult[]> = {}
let adminResults: Record<string, QueryResult[]> = {}

// Function declaration (hoisted) so the hoisted vi.mock factory can reference it.
function taggedClient(tag: ClientTag, getResults: () => Record<string, QueryResult[]>) {
  const counters: Record<string, number> = {}
  return {
    from(table: string) {
      log.push({ client: tag, table })
      const queue = getResults()[table] ?? [{ data: null, error: null }]
      const idx = counters[table] ?? 0
      counters[table] = idx + 1
      return buildChain(queue[Math.min(idx, queue.length - 1)], table)
    },
  }
}

vi.mock('@/lib/supabase/server', () => ({
  createReadClient: () => taggedClient('read', () => readResults),
  createAdminClient: () => taggedClient('admin', () => adminResults),
  createClient: () => taggedClient('read', () => readResults),
}))

import {
  listDevices,
  getDevice,
  getDeviceStats,
  getDeviceByPcbaSn,
  updateDevice,
  changeStatus,
} from '@/lib/services/deviceService'

// Seeded vocabulary WITH transition flags (drives isValidTransition).
const VOCAB_WITH_FLAGS: QueryResult = {
  data: [
    { code: 'Stock',   active: true,  is_initial: true,  is_terminal: false },
    { code: 'In Use',  active: true,  is_initial: false, is_terminal: false },
    { code: 'Retired', active: true,  is_initial: false, is_terminal: true  },
  ],
  error: null,
}

const page = (rows: unknown[], count = rows.length): QueryResult =>
  ({ data: rows, error: null, count } as unknown as QueryResult)

const tables = (client: ClientTag) => log.filter((e) => e.client === client).map((e) => e.table)

beforeEach(() => {
  log = []
  readResults = {}
  adminResults = {}
})

describe('deviceService — read/write client selection', () => {
  it('listDevices hits ONLY the read client', async () => {
    readResults = { device: [page([])] }
    await listDevices({})
    expect(log).toEqual([{ client: 'read', table: 'device' }])
    expect(tables('admin')).toEqual([])
  })

  it('getDevice hits ONLY the read client', async () => {
    readResults = { device: [{ data: { id: 'dev-1' }, error: null }] }
    const result = await getDevice('dev-1')
    expect(result).toEqual({ id: 'dev-1' })
    expect(log).toEqual([{ client: 'read', table: 'device' }])
    expect(tables('admin')).toEqual([])
  })

  it('getDeviceStats hits ONLY the read client (both aggregate queries)', async () => {
    readResults = { device: [page([]), page([])] }
    await getDeviceStats()
    expect(tables('read')).toEqual(['device', 'device'])
    expect(tables('admin')).toEqual([])
  })

  it('getDeviceByPcbaSn (duplicate pre-check feeding create) stays on the admin client', async () => {
    adminResults = { device: [{ data: null, error: null }] }
    await getDeviceByPcbaSn('PA-001')
    expect(log).toEqual([{ client: 'admin', table: 'device' }])
    expect(tables('read')).toEqual([])
  })

  it('updateDevice: pre-read AND the UPDATE hit ONLY the admin client (no read client)', async () => {
    // A non-status write skips vocabulary reads, so the whole flow is admin-only:
    // fetchDeviceForWrite (version check) + the UPDATE. Version 1 matches the row.
    adminResults = { device: [{ data: { id: 'dev-1', version: 1, deleted_at: null, status: 'Stock' }, error: null }] }
    await updateDevice('dev-1', { customer: 'Acme' }, 1, 'actor-1', 'engineer')
    // Exactly two device touches, both admin: the pre-read then the UPDATE.
    expect(tables('admin')).toEqual(['device', 'device'])
    // The RLS read client is NEVER used on the write path.
    expect(log.some((e) => e.client === 'read')).toBe(false)
  })

  it('changeStatus: the transition pre-read hits the admin client (fetchDeviceForWrite)', async () => {
    // Stock → In Use is a valid transition, so the flow reaches updateDevice.
    adminResults = { device: [{ data: { id: 'dev-1', version: 1, deleted_at: null, status: 'Stock' }, error: null }] }
    readResults = { status_option: [VOCAB_WITH_FLAGS] }  // phase_option left empty → phase check skipped
    await changeStatus('dev-1', 'In Use', 'MP', 1, 'actor-1', 'engineer')
    // The very first access is the changeStatus pre-read, on the admin client.
    expect(log[0]).toEqual({ client: 'admin', table: 'device' })
    // Every device access (changeStatus pre-read, updateDevice pre-read, UPDATE)
    // is on the admin client; the read client only ever touches vocabulary.
    expect(tables('read').every((t) => t !== 'device')).toBe(true)
    expect(log.filter((e) => e.table === 'device').every((e) => e.client === 'admin')).toBe(true)
    // Vocabulary IS read on the RLS read client (status_option lookup).
    expect(tables('read')).toContain('status_option')
  })
})
