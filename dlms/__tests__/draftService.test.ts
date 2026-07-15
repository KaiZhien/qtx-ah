import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildChain, makeFrom } from './supabaseChainMock'
import { AppError } from '@/lib/types'

let fromImpl: (table: string) => unknown

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({ from: (table: string) => fromImpl(table) }),
}))

import {
  promoteDraft,
  rejectDraft,
  fieldsToDeviceInput,
  getPendingDraftCount,
  listDrafts,
  getDraft,
} from '@/lib/services/draftService'
import type { QueryResult } from './supabaseChainMock'

async function catchErr(p: Promise<unknown>): Promise<AppError> {
  return p.then(() => { throw new Error('expected rejection') }, (e) => e as AppError)
}

describe('fieldsToDeviceInput', () => {
  it('defaults missing status/phase to valid vocabulary codes', () => {
    // No status/phase in the extracted payload → must fall back to seeded codes,
    // not the out-of-vocabulary 'In Production'/'MP' that would fail the DB FK.
    const input = fieldsToDeviceInput({
      pcba_a_sn: { value: 'PA-XYZ-001' },
    })
    expect(input.status).toBe('Stock')
    expect(input.phase).toBe('Production')
  })

  it('passes through explicit status/phase values from the payload', () => {
    const input = fieldsToDeviceInput({
      pcba_a_sn: { value: 'PA-XYZ-002' },
      status: { value: 'In Use' },
      phase: { value: 'Validation' },
    })
    expect(input.status).toBe('In Use')
    expect(input.phase).toBe('Validation')
  })
})

beforeEach(() => {
  fromImpl = () => buildChain({ data: null, error: null })
})

describe('promoteDraft', () => {
  it('denies a viewer (permission error)', async () => {
    const err = await catchErr(promoteDraft('draft-1', 'actor-1', 'viewer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('permission')
  })

  it('rejects an already-confirmed draft (validation error)', async () => {
    fromImpl = makeFrom({
      extracted_device_draft: [
        { data: { id: 'draft-1', status: 'confirmed', extracted_payload: { fields: {} } }, error: null },
      ],
    })
    const err = await catchErr(promoteDraft('draft-1', 'actor-1', 'engineer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('validation')
  })

  it('rejects promoting a draft whose status is not in the live vocabulary (clear error, not a DB FK)', async () => {
    fromImpl = makeFrom({
      extracted_device_draft: [
        {
          data: {
            id: 'draft-1',
            status: 'pending_review',
            extracted_payload: {
              fields: {
                pcba_a_sn:      { value: 'PA-XYZ-003' },
                pcba_a_hw_rev:  { value: 'V1' },
                pcba_a_bom_rev: { value: 'B1' },
                pcba_a_fw_ver:  { value: '1.0.0' },
                status:         { value: 'In Production' },  // not a vocabulary code
              },
            },
          },
          error: null,
        },
      ],
      status_option: [
        { data: [{ code: 'Stock', active: true }, { code: 'In Use', active: true }], error: null },
      ],
    })
    const err = await catchErr(promoteDraft('draft-1', 'actor-1', 'engineer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('validation')
    expect(err.serviceError.message).toContain('"In Production"')
    expect(err.serviceError.message).toContain('Stock')
  })
})

describe('rejectDraft', () => {
  it('denies a viewer (permission error)', async () => {
    const err = await catchErr(rejectDraft('draft-1', 'actor-1', 'viewer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('permission')
  })

  it('throws when the draft does not exist', async () => {
    fromImpl = makeFrom({
      extracted_device_draft: [{ data: null, error: { message: 'no rows' } }],
    })
    await expect(rejectDraft('missing', 'actor-1', 'engineer')).rejects.toThrow('Draft not found')
  })

  it('rejects an already-confirmed draft (validation error)', async () => {
    fromImpl = makeFrom({
      extracted_device_draft: [
        { data: { id: 'draft-1', status: 'confirmed', extracted_payload: { fields: {} } }, error: null },
      ],
    })
    const err = await catchErr(rejectDraft('draft-1', 'actor-1', 'engineer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('validation')
    expect(err.serviceError.message).toContain('confirmed')
  })

  it('rejects an already-rejected draft (validation error)', async () => {
    fromImpl = makeFrom({
      extracted_device_draft: [
        { data: { id: 'draft-1', status: 'rejected', extracted_payload: { fields: {} } }, error: null },
      ],
    })
    const err = await catchErr(rejectDraft('draft-1', 'actor-1', 'engineer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('validation')
    expect(err.serviceError.message).toContain('rejected')
  })

  it('marks a pending draft rejected and records the reviewer', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({
      extracted_device_draft: [
        { data: { id: 'draft-1', status: 'pending_review', extracted_payload: { fields: {} } }, error: null },
        { data: null, error: null },
      ],
    }, captures)

    await rejectDraft('draft-1', 'actor-9', 'engineer')

    const updateArgs = captures['extracted_device_draft.update']
    expect(updateArgs).toBeTruthy()
    const payload = updateArgs[0][0] as { status: string; reviewed_by: string }
    expect(payload.status).toBe('rejected')
    expect(payload.reviewed_by).toBe('actor-9')
  })
})

describe('getPendingDraftCount', () => {
  it('counts only pending_review drafts', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({
      extracted_device_draft: [{ data: null, error: null, count: 3 } as unknown as QueryResult],
    }, captures)
    expect(await getPendingDraftCount()).toBe(3)
    expect(captures['extracted_device_draft.eq']).toContainEqual(['status', 'pending_review'])
  })

  it('returns 0 when the count comes back null', async () => {
    fromImpl = makeFrom({
      extracted_device_draft: [{ data: null, error: null } as QueryResult],
    })
    expect(await getPendingDraftCount()).toBe(0)
  })

  it('propagates a DB error', async () => {
    fromImpl = makeFrom({
      extracted_device_draft: [{ data: null, error: { message: 'boom' } } as QueryResult],
    })
    await expect(getPendingDraftCount()).rejects.toThrow('boom')
  })
})

describe('listDrafts', () => {
  it('returns pending_review drafts newest-first', async () => {
    const captures: Record<string, unknown[][]> = {}
    const rows = [{ id: 'draft-1' }, { id: 'draft-2' }]
    fromImpl = makeFrom({ extracted_device_draft: [{ data: rows, error: null }] }, captures)
    expect(await listDrafts()).toEqual(rows)
    expect(captures['extracted_device_draft.eq']).toContainEqual(['status', 'pending_review'])
    expect(captures['extracted_device_draft.order']).toContainEqual(['created_at', { ascending: false }])
  })

  it('returns [] when there are no pending drafts', async () => {
    fromImpl = makeFrom({ extracted_device_draft: [{ data: null, error: null }] })
    expect(await listDrafts()).toEqual([])
  })

  it('propagates a DB error', async () => {
    fromImpl = makeFrom({ extracted_device_draft: [{ data: null, error: { message: 'boom' } }] })
    await expect(listDrafts()).rejects.toThrow('boom')
  })
})

describe('getDraft', () => {
  it('returns the draft row by id', async () => {
    const captures: Record<string, unknown[][]> = {}
    fromImpl = makeFrom({ extracted_device_draft: [{ data: { id: 'draft-1' }, error: null }] }, captures)
    expect(await getDraft('draft-1')).toEqual({ id: 'draft-1' })
    expect(captures['extracted_device_draft.eq']).toContainEqual(['id', 'draft-1'])
  })

  it('returns null (not a throw) when the row is missing', async () => {
    fromImpl = makeFrom({ extracted_device_draft: [{ data: null, error: { message: 'no rows' } }] })
    expect(await getDraft('missing')).toBeNull()
  })
})
