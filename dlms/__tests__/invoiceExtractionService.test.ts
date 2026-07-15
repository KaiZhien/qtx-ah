import { describe, it, expect, beforeEach, vi } from 'vitest'

// Mock the Anthropic SDK: the service does `new Anthropic(...)` then
// `client.messages.create(...)`. A single shared mockCreate lets each test drive
// the response and inspect the request.
const mockCreate = vi.fn()
vi.mock('@anthropic-ai/sdk', () => ({
  default: class {
    messages = { create: mockCreate }
  },
}))

import { extractInvoiceFields } from '@/lib/services/invoiceExtractionService'

const ALL_FIELDS = [
  'device_sn', 'product_name', 'model_no',
  'pcba_a_sn', 'pcba_a_hw_rev', 'pcba_a_bom_rev', 'pcba_a_fw_ver',
  'pcba_b_sn', 'pcba_b_hw_rev', 'pcba_b_bom_rev', 'pcba_b_fw_ver',
  'screen_model', 'hmi_ver',
  'build_date', 'ship_date', 'qty',
  'destination', 'customer',
  'status', 'phase', 'remarks',
] as const

const field = (value: string | null, confidence = 1, source_quote: string | null = 'q') =>
  ({ value, confidence, source_quote })

// Build a complete 21-field extraction payload.
function fullPayload(): Record<string, unknown> {
  return Object.fromEntries(ALL_FIELDS.map((f) => [f, field(`${f}-val`)]))
}

function textResponse(payload: unknown) {
  return { content: [{ type: 'text', text: JSON.stringify(payload) }] }
}

beforeEach(() => {
  mockCreate.mockReset()
})

describe('extractInvoiceFields — request shape', () => {
  it('sends a PDF as a base64 document block plus the extraction prompt', async () => {
    mockCreate.mockResolvedValue(textResponse(fullPayload()))
    const buffer = Buffer.from('%PDF-fake-bytes')

    await extractInvoiceFields({ buffer, mediaType: 'application/pdf' })

    const params = mockCreate.mock.calls[0][0]
    expect(params.model).toBe('claude-sonnet-4-6')
    expect(params.output_config.format.type).toBe('json_schema')
    const [fileBlock, textBlock] = params.messages[0].content
    expect(fileBlock.type).toBe('document')
    expect(fileBlock.source.media_type).toBe('application/pdf')
    expect(fileBlock.source.data).toBe(buffer.toString('base64'))
    expect(textBlock.type).toBe('text')
    expect(textBlock.text).toContain('data-extraction assistant')
  })

  it('sends a PNG as an image block with its media type preserved', async () => {
    mockCreate.mockResolvedValue(textResponse(fullPayload()))
    await extractInvoiceFields({ buffer: Buffer.from('png'), mediaType: 'image/png' })

    const fileBlock = mockCreate.mock.calls[0][0].messages[0].content[0]
    expect(fileBlock.type).toBe('image')
    expect(fileBlock.source.media_type).toBe('image/png')
  })

  it('normalizes image/jpg to the canonical image/jpeg media type', async () => {
    mockCreate.mockResolvedValue(textResponse(fullPayload()))
    await extractInvoiceFields({ buffer: Buffer.from('jpg'), mediaType: 'image/jpg' })

    const fileBlock = mockCreate.mock.calls[0][0].messages[0].content[0]
    expect(fileBlock.type).toBe('image')
    expect(fileBlock.source.media_type).toBe('image/jpeg')
  })
})

describe('extractInvoiceFields — field mapping', () => {
  it('returns all 21 device fields, passing through the model values verbatim', async () => {
    mockCreate.mockResolvedValue(textResponse(fullPayload()))
    const result = await extractInvoiceFields({ buffer: Buffer.from('x'), mediaType: 'image/png' })

    expect(Object.keys(result).sort()).toEqual([...ALL_FIELDS].sort())
    expect(result.pcba_a_sn.value).toBe('pcba_a_sn-val')
    expect(result.customer.value).toBe('customer-val')
  })

  it('back-fills a null/zero-confidence default for any field the model omitted', async () => {
    // Model returned only two fields; the other 19 must be defaulted, not dropped.
    mockCreate.mockResolvedValue(textResponse({
      pcba_a_sn: field('PA-001'),
      customer: field('Acme'),
    }))
    const result = await extractInvoiceFields({ buffer: Buffer.from('x'), mediaType: 'image/png' })

    expect(Object.keys(result)).toHaveLength(21)
    expect(result.pcba_a_sn.value).toBe('PA-001')
    expect(result.device_sn).toEqual({ value: null, confidence: 0, source_quote: null })
    expect(result.remarks).toEqual({ value: null, confidence: 0, source_quote: null })
  })
})

describe('extractInvoiceFields — malformed responses', () => {
  it('rejects when the text block is not valid JSON', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'text', text: 'not-json{' }] })
    await expect(
      extractInvoiceFields({ buffer: Buffer.from('x'), mediaType: 'image/png' }),
    ).rejects.toThrow()
  })

  it('throws a clear error when the response carries no text block', async () => {
    mockCreate.mockResolvedValue({ content: [{ type: 'image', source: {} }] })
    await expect(
      extractInvoiceFields({ buffer: Buffer.from('x'), mediaType: 'image/png' }),
    ).rejects.toThrow('no text content')
  })
})
