import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildChain, type QueryResult } from './supabaseChainMock'

// ---------------------------------------------------------------------------
// Client-selection tests — the security property of the RLS read-path migration,
// cloned from deviceService.clientSelection.test.ts for the draft service.
//
// The shared makeServerModuleMock returns ONE client for all factories, which
// hides read-vs-admin selection. Here createReadClient and createAdminClient
// return DISTINGUISHABLE clients: each records ('read'|'admin') + the table it
// touched into a shared `log`. That makes "which client did this op use?"
// observable, so we can pin the security-relevant property:
//   - pure reads (getDraft/listDrafts) hit ONLY the read client
//   - the promote/reject pre-read (fetchDraftForWrite) + the status UPDATE hit
//     ONLY the admin client — routing the pre-read through the RLS read client
//     could hide the true draft row and break the pending-review guard / reviewer
//     attribution.
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

// createDevice does its own vocabulary reads (read client) + insert (admin) — that
// path is covered by deviceService tests. Stub it so this file isolates the draft
// service's OWN client selection; otherwise createDevice's touches would dominate
// (and legitimately add 'read' vocabulary entries to) the promote log.
const createDevice = vi.fn()
vi.mock('@/lib/services/deviceService', () => ({
  createDevice: (...args: unknown[]) => createDevice(...args),
}))

import { getDraft, listDrafts, promoteDraft, rejectDraft } from '@/lib/services/draftService'

const tables = (client: ClientTag) => log.filter((e) => e.client === client).map((e) => e.table)

beforeEach(() => {
  log = []
  readResults = {}
  adminResults = {}
  createDevice.mockReset()
})

describe('draftService — read/write client selection', () => {
  it('getDraft hits ONLY the read client', async () => {
    readResults = { extracted_device_draft: [{ data: { id: 'draft-1' }, error: null }] }
    const result = await getDraft('draft-1')
    expect(result).toEqual({ id: 'draft-1' })
    expect(log).toEqual([{ client: 'read', table: 'extracted_device_draft' }])
    expect(tables('admin')).toEqual([])
  })

  it('listDrafts hits ONLY the read client', async () => {
    readResults = { extracted_device_draft: [{ data: [{ id: 'draft-1' }], error: null }] }
    await listDrafts()
    expect(log).toEqual([{ client: 'read', table: 'extracted_device_draft' }])
    expect(tables('admin')).toEqual([])
  })

  it('promoteDraft: fetchDraftForWrite pre-read AND the confirm UPDATE hit ONLY the admin client', async () => {
    adminResults = {
      extracted_device_draft: [
        { data: { id: 'draft-1', status: 'pending_review', extracted_payload: { fields: {} } }, error: null },
        { data: null, error: null },
      ],
    }
    createDevice.mockResolvedValue({ id: 'new-dev' })
    const device = await promoteDraft('draft-1', 'actor-1', 'engineer')
    expect(device).toEqual({ id: 'new-dev' })
    // Two draft touches — the pre-read then the confirm UPDATE — both admin.
    expect(tables('admin')).toEqual(['extracted_device_draft', 'extracted_device_draft'])
    // The RLS read client is NEVER used on the promote path.
    expect(log.some((e) => e.client === 'read')).toBe(false)
  })

  it('rejectDraft: fetchDraftForWrite pre-read AND the reject UPDATE hit ONLY the admin client', async () => {
    adminResults = {
      extracted_device_draft: [
        { data: { id: 'draft-1', status: 'pending_review', extracted_payload: { fields: {} } }, error: null },
        { data: null, error: null },
      ],
    }
    await rejectDraft('draft-1', 'actor-1', 'engineer')
    expect(tables('admin')).toEqual(['extracted_device_draft', 'extracted_device_draft'])
    expect(log.some((e) => e.client === 'read')).toBe(false)
  })
})
