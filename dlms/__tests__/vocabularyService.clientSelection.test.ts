import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildChain, type QueryResult } from './supabaseChainMock'

// ---------------------------------------------------------------------------
// Client-selection tests for a simple service (vocabularyService), companion to
// deviceService.clientSelection.test.ts. Distinguishable read/admin clients each
// record ('read'|'admin') + table into a shared log so we can assert the vocab
// reads use the RLS read client while the vocab writes stay on the admin client.
// ---------------------------------------------------------------------------

type ClientTag = 'read' | 'admin'
let log: Array<{ client: ClientTag; table: string }> = []
let readResults: Record<string, QueryResult[]> = {}
let adminResults: Record<string, QueryResult[]> = {}

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
  getStatuses,
  getAllStatuses,
  addStatusOption,
  toggleOptionActive,
} from '@/lib/services/vocabularyService'

const tables = (client: ClientTag) => log.filter((e) => e.client === client).map((e) => e.table)

beforeEach(() => {
  log = []
  readResults = {}
  adminResults = {}
})

describe('vocabularyService — read/write client selection', () => {
  it('getStatuses hits ONLY the read client', async () => {
    readResults = { status_option: [{ data: [], error: null }] }
    await getStatuses()
    expect(log).toEqual([{ client: 'read', table: 'status_option' }])
    expect(tables('admin')).toEqual([])
  })

  it('getAllStatuses hits ONLY the read client', async () => {
    readResults = { status_option: [{ data: [], error: null }] }
    await getAllStatuses()
    expect(log).toEqual([{ client: 'read', table: 'status_option' }])
    expect(tables('admin')).toEqual([])
  })

  it('addStatusOption (write) hits ONLY the admin client', async () => {
    // Two admin touches: the sort_order lookup and the insert. Never the read client.
    adminResults = { status_option: [{ data: { code: 'RMA', sort_order: 10, active: true }, error: null }] }
    await addStatusOption('RMA', 'RMA', '退货', 'actor-1', 'admin')
    expect(tables('admin')).toEqual(['status_option', 'status_option'])
    expect(tables('read')).toEqual([])
  })

  it('toggleOptionActive (write) hits ONLY the admin client', async () => {
    adminResults = { status_option: [{ data: null, error: null }] }
    await toggleOptionActive('status_option', 'RMA', false, 'actor-1', 'admin')
    expect(log).toEqual([{ client: 'admin', table: 'status_option' }])
    expect(tables('read')).toEqual([])
  })
})
