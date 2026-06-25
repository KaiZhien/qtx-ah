/**
 * Invoice extraction service — sends an invoice (PDF or image) to Claude vision
 * and extracts device fields using structured output (json_schema).
 *
 * This module has NO side-effects on the DB or Storage; callers decide what to
 * persist. Fields returned follow the same { value, confidence, source_quote }
 * shape consumed by fieldsToDeviceInput() in draftService.ts.
 */

import Anthropic from '@anthropic-ai/sdk'

export type ExtractedField = {
  value: string | null
  confidence: number   // 0–1 where 1 = very certain
  source_quote: string | null  // verbatim text from the document that supports this value
}

export type ExtractedFields = Record<string, ExtractedField>

const DEVICE_FIELDS = [
  'device_sn', 'product_name', 'model_no',
  'pcba_a_sn', 'pcba_a_hw_rev', 'pcba_a_bom_rev', 'pcba_a_fw_ver',
  'pcba_b_sn', 'pcba_b_hw_rev', 'pcba_b_bom_rev', 'pcba_b_fw_ver',
  'screen_model', 'hmi_ver',
  'build_date', 'ship_date', 'qty',
  'destination', 'customer',
  'status', 'phase', 'remarks',
] as const

// JSON Schema for output_config structured outputs
const OUTPUT_SCHEMA = {
  type: 'object',
  properties: Object.fromEntries(
    DEVICE_FIELDS.map((field) => [
      field,
      {
        type: 'object',
        properties: {
          value:        { type: ['string', 'null'] },
          confidence:   { type: 'number' },
          source_quote: { type: ['string', 'null'] },
        },
        required: ['value', 'confidence', 'source_quote'],
        additionalProperties: false,
      },
    ])
  ),
  required: [...DEVICE_FIELDS],
  additionalProperties: false,
}

const EXTRACTION_PROMPT = `You are a precise data-extraction assistant for a device lifecycle management system.

Extract device information from the attached invoice or shipping document and return it as structured JSON.

Field dictionary (bilingual — match either language):
- device_sn / 设备序列号: overall device serial number
- product_name / 产品名称: product name
- model_no / 产品型号: model number
- pcba_a_sn / 电源板序列号: PCBA-A (Amplifier Board) serial number
- pcba_a_hw_rev / 硬件版本: PCBA-A hardware revision
- pcba_a_bom_rev / BOM版本: PCBA-A BOM revision
- pcba_a_fw_ver / 固件版本: PCBA-A firmware version
- pcba_b_sn / 控制板序列号: PCBA-B (Accessory Board) serial number
- pcba_b_hw_rev: PCBA-B hardware revision
- pcba_b_bom_rev: PCBA-B BOM revision
- pcba_b_fw_ver: PCBA-B firmware version
- screen_model / 屏幕型号: HMI screen model
- hmi_ver / HMI软件版本: HMI software version
- build_date / 生产日期: manufacture/build date → output as YYYY-MM-DD or null
- ship_date / 出货日期: shipment date → output as YYYY-MM-DD or null
- qty / 数量: quantity (integer string, e.g. "10") or null
- destination / 目的地: shipping destination
- customer / 客户: customer name
- status / 状态: device status (e.g. "In Production", "Shipped", "In Stock")
- phase / 阶段: production phase (e.g. "MP", "Pilot", "Validation")
- remarks / 备注: any additional notes or remarks

Rules:
1. Set value to null and confidence to 0 if a field is not present in the document. DO NOT guess or hallucinate.
2. confidence is a float 0.0–1.0: use 1.0 only when the text is unambiguous, 0.5–0.9 when you can infer it with some uncertainty.
3. source_quote: copy the exact verbatim text fragment from the document that supports the value (null if value is null).
4. Dates must be ISO 8601: YYYY-MM-DD. Convert any other date formats.
5. qty must be a plain integer string ("10"), not "10 units".`

/**
 * Send a file buffer to Claude Sonnet 4.6 and extract the 21 device fields.
 * Returns the raw extracted fields map — no DB or Storage writes.
 */
export async function extractInvoiceFields(file: {
  buffer: Buffer
  mediaType: 'application/pdf' | 'image/jpeg' | 'image/png' | 'image/jpg'
}): Promise<ExtractedFields> {
  const client = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
  })

  const data = file.buffer.toString('base64')

  // Build the document/image content block depending on media type
  const fileBlock: Anthropic.ContentBlockParam =
    file.mediaType === 'application/pdf'
      ? {
          type: 'document' as const,
          source: {
            type: 'base64' as const,
            media_type: 'application/pdf' as const,
            data,
          },
        }
      : {
          type: 'image' as const,
          source: {
            type: 'base64' as const,
            media_type: file.mediaType === 'image/jpg' ? 'image/jpeg' : file.mediaType as 'image/jpeg' | 'image/png',
            data,
          },
        }

  // output_config is a newer API feature not yet reflected in the bundled SDK types.
  // Cast the full params object to bypass the type check.
  const response = await (client.messages.create as (p: unknown) => Promise<Anthropic.Message>)({
    model: 'claude-sonnet-4-6',
    max_tokens: 4096,
    output_config: {
      format: {
        type: 'json_schema',
        schema: OUTPUT_SCHEMA,
      },
    },
    messages: [
      {
        role: 'user',
        content: [
          fileBlock,
          {
            type: 'text',
            text: EXTRACTION_PROMPT,
          },
        ],
      },
    ],
  })

  // The structured output guarantees the response is valid JSON matching OUTPUT_SCHEMA
  const textBlock = response.content.find((b) => b.type === 'text')
  if (!textBlock || textBlock.type !== 'text') {
    throw new Error('Claude returned no text content')
  }

  const parsed = JSON.parse(textBlock.text) as ExtractedFields

  // Ensure every field exists with a default (defensive — schema should guarantee this)
  const result: ExtractedFields = {}
  for (const field of DEVICE_FIELDS) {
    result[field] = parsed[field] ?? { value: null, confidence: 0, source_quote: null }
  }

  return result
}
