import { describe, it, expect, beforeEach, vi } from 'vitest'
import { makeServerModuleMock } from './supabaseChainMock'

// --- Service mocks ---
const { createDevice, getDeviceByPcbaSn, extractInvoiceFields } = vi.hoisted(() => ({
  createDevice: vi.fn(),
  getDeviceByPcbaSn: vi.fn(),
  extractInvoiceFields: vi.fn(),
}))
vi.mock('@/lib/services/deviceService', () => ({ createDevice, getDeviceByPcbaSn }))
vi.mock('@/lib/services/invoiceExtractionService', () => ({ extractInvoiceFields }))

// --- Supabase admin client (storage upload + extracted_device_draft chain) ---
const upload = vi.fn()
const upsert = vi.fn()
// upsertResult resolves when the chain is awaited directly (confirm path);
// singleResult resolves the …upsert().select().single() chain (save path).
let upsertResult: unknown = { data: null, error: null }
let singleResult: { data: unknown; error: unknown } = { data: { id: 'draft-1' }, error: null }
function draftChain(): Record<string, unknown> {
  const chain: Record<string, unknown> = {}
  chain.upsert = (...a: unknown[]) => { upsert(...a); return chain }
  chain.select = () => chain
  chain.single = () => Promise.resolve(singleResult)
  chain.then = (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
    Promise.resolve(upsertResult).then(res, rej)
  return chain
}
vi.mock('@/lib/supabase/server', () =>
  makeServerModuleMock(() => () => draftChain(), {
    storage: { from: () => ({ upload: (...a: unknown[]) => upload(...a) }) },
  })
)

let currentUser: { id: string; role: string; email?: string } | null = null
vi.mock('@/lib/auth/session', () => ({ getCurrentUser: () => Promise.resolve(currentUser) }))

const revalidatePath = vi.fn()
vi.mock('next/cache', () => ({ revalidatePath: (p: string) => revalidatePath(p) }))

import {
  extractInvoiceAction,
  confirmInvoiceDeviceAction,
  saveDraftForReviewAction,
} from '@/app/drafts/upload/actions'
import type { DeviceInput } from '@/lib/types'

const ENGINEER = { id: 'eng-1', role: 'engineer', email: 'e@quantumtx.com' }
const VIEWER = { id: 'vwr-1', role: 'viewer', email: 'v@quantumtx.com' }

const pdf = (name = 'inv.pdf', type = 'application/pdf'): File =>
  new File([Buffer.from('hello invoice')], name, { type })

const formWithFile = (file: File | null): FormData => {
  const fd = new FormData()
  if (file) fd.set('file', file)
  return fd
}

const deviceInput = (over: Partial<DeviceInput> = {}): DeviceInput => ({
  pcba_a_sn: 'DEV1',
  pcba_a_hw_rev: 'A',
  pcba_a_bom_rev: 'B',
  pcba_a_fw_ver: '1.0',
  status: 'in_progress',
  phase: 'assembly',
  ...over,
})

beforeEach(() => {
  vi.clearAllMocks()
  currentUser = null
  upsertResult = { data: null, error: null }
  singleResult = { data: { id: 'draft-1' }, error: null }
})

// Error convention across this file: RESULT ({ error } / { id } / { fields, … }); never throws.

describe('extractInvoiceAction', () => {
  it('returns the role error for a viewer', async () => {
    currentUser = VIEWER
    const out = await extractInvoiceAction(formWithFile(pdf()))
    expect(out).toEqual({ error: 'Unauthorized — engineer or admin role required' })
    expect(extractInvoiceFields).not.toHaveBeenCalled()
  })

  it('returns "No file provided" when the form has no file', async () => {
    currentUser = ENGINEER
    expect(await extractInvoiceAction(formWithFile(null))).toEqual({ error: 'No file provided' })
  })

  it('rejects an unsupported MIME type before extraction', async () => {
    currentUser = ENGINEER
    const out = await extractInvoiceAction(formWithFile(pdf('x.gif', 'image/gif')))
    expect(out).toEqual({ error: 'Unsupported file type "image/gif". Accepted: PDF, JPG, PNG.' })
    expect(extractInvoiceFields).not.toHaveBeenCalled()
  })

  it('happy path: extracts fields and returns a sha256 hash + echoed metadata', async () => {
    currentUser = ENGINEER
    extractInvoiceFields.mockResolvedValue({ device_sn: 'DEV1' })
    const out = await extractInvoiceAction(formWithFile(pdf()))
    expect(extractInvoiceFields).toHaveBeenCalledWith({
      buffer: expect.any(Buffer),
      mediaType: 'application/pdf',
    })
    expect(out).toMatchObject({
      fields: { device_sn: 'DEV1' },
      fileName: 'inv.pdf',
      mediaType: 'application/pdf',
    })
    // sha256 hex digest of the raw bytes
    expect((out as { fileHash: string }).fileHash).toMatch(/^[a-f0-9]{64}$/)
  })

  it('wraps a thrown extraction error into { error }', async () => {
    currentUser = ENGINEER
    extractInvoiceFields.mockRejectedValue(new Error('claude timeout'))
    expect(await extractInvoiceAction(formWithFile(pdf()))).toEqual({
      error: 'Extraction failed: claude timeout',
    })
  })
})

describe('confirmInvoiceDeviceAction', () => {
  it('returns the role error for a viewer', async () => {
    currentUser = VIEWER
    const out = await confirmInvoiceDeviceAction(deviceInput(), formWithFile(pdf()), 'hash', {} as never)
    expect(out).toEqual({ error: 'Unauthorized — engineer or admin role required' })
  })

  it('duplicate PCBA-A: returns error + existingId, creates nothing', async () => {
    currentUser = ENGINEER
    getDeviceByPcbaSn.mockResolvedValue({ id: 'existing-2' })
    const out = await confirmInvoiceDeviceAction(
      deviceInput({ pcba_a_sn: 'DUP' }), formWithFile(pdf()), 'hash', {} as never,
    )
    expect(out).toEqual({
      error: 'A device with PCBA-A S/N "DUP" already exists',
      existingId: 'existing-2',
    })
    expect(createDevice).not.toHaveBeenCalled()
    expect(upload).not.toHaveBeenCalled()
  })

  it('happy path: uploads, creates the device, upserts a confirmed draft, returns { id }', async () => {
    currentUser = ENGINEER
    getDeviceByPcbaSn.mockResolvedValue(null)
    upload.mockResolvedValue({ error: null })
    createDevice.mockResolvedValue({ id: 'dev-9' })
    const out = await confirmInvoiceDeviceAction(deviceInput(), formWithFile(pdf()), 'abchash', { device_sn: 'DEV1' } as never)
    expect(createDevice).toHaveBeenCalledWith(deviceInput(), 'eng-1', 'engineer')
    expect(upsert.mock.calls[0][0]).toMatchObject({
      source_file_hash: 'abchash',
      status: 'confirmed',
      promoted_device_id: 'dev-9',
      reviewed_by: 'eng-1',
    })
    expect(revalidatePath).toHaveBeenCalledWith('/devices')
    expect(out).toEqual({ id: 'dev-9' })
  })

  it('returns the upload error when Storage rejects (non-"already exists")', async () => {
    currentUser = ENGINEER
    getDeviceByPcbaSn.mockResolvedValue(null)
    upload.mockResolvedValue({ error: { message: 'bucket missing' } })
    const out = await confirmInvoiceDeviceAction(deviceInput(), formWithFile(pdf()), 'h', {} as never)
    expect(out).toEqual({ error: 'File upload failed: bucket missing' })
    expect(createDevice).not.toHaveBeenCalled()
  })
})

describe('saveDraftForReviewAction', () => {
  it('returns the role error for a viewer', async () => {
    currentUser = VIEWER
    expect(await saveDraftForReviewAction(formWithFile(pdf()), 'h', {} as never)).toEqual({
      error: 'Unauthorized — engineer or admin role required',
    })
  })

  it('happy path: uploads, upserts a pending_review draft, revalidates /drafts, returns { id }', async () => {
    currentUser = ENGINEER
    upload.mockResolvedValue({ error: null })
    singleResult = { data: { id: 'draft-77' }, error: null }
    const out = await saveDraftForReviewAction(formWithFile(pdf()), 'savehash', { device_sn: 'DEV1' } as never)
    expect(upsert.mock.calls[0][0]).toMatchObject({
      source_file_hash: 'savehash',
      status: 'pending_review',
    })
    // save must NOT create a device
    expect(createDevice).not.toHaveBeenCalled()
    expect(revalidatePath).toHaveBeenCalledWith('/drafts')
    expect(out).toEqual({ id: 'draft-77' })
  })

  it('returns the save error when the draft upsert fails', async () => {
    currentUser = ENGINEER
    upload.mockResolvedValue({ error: null })
    singleResult = { data: null, error: { message: 'unique violation' } }
    expect(await saveDraftForReviewAction(formWithFile(pdf()), 'h', {} as never)).toEqual({
      error: 'Save failed: unique violation',
    })
  })
})
