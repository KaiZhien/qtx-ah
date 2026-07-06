import { describe, it, expect, beforeEach, vi } from 'vitest'
import { buildChain, makeFrom } from './supabaseChainMock'
import { AppError } from '@/lib/types'

let fromImpl: (table: string) => unknown

vi.mock('@/lib/supabase/server', () => ({
  createAdminClient: () => ({ from: (table: string) => fromImpl(table) }),
}))

import { promoteDraft } from '@/lib/services/draftService'

async function catchErr(p: Promise<unknown>): Promise<AppError> {
  return p.then(() => { throw new Error('expected rejection') }, (e) => e as AppError)
}

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
})
