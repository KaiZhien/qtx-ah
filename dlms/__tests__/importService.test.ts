import { describe, it, expect, beforeEach, vi } from 'vitest'
import { AppError } from '@/lib/types'
import type { DeviceInput, ImportPreviewRow } from '@/lib/types'

// importValidRows orchestrates getDeviceByPcbaSn (dedupe) + createDevice (insert).
// Mock those collaborators so the test pins the loop/aggregation behavior, not the
// full create/vocab DB dance. validateMappedRow is pure and uses neither.
const mockCreateDevice = vi.fn()
const mockGetDeviceByPcbaSn = vi.fn()
vi.mock('@/lib/services/deviceService', () => ({
  createDevice: (...args: unknown[]) => mockCreateDevice(...args),
  getDeviceByPcbaSn: (...args: unknown[]) => mockGetDeviceByPcbaSn(...args),
}))

import { validateMappedRow, importValidRows } from '@/lib/services/importService'

async function catchErr(p: Promise<unknown>): Promise<AppError> {
  return p.then(() => { throw new Error('expected rejection') }, (e) => e as AppError)
}

const VALID_STATUSES = ['Stock', 'In Use']
const VALID_PHASES = ['Production', 'Validation']

// A mapped row with every required field present and valid.
const validMapped = (over: Record<string, string> = {}): Record<string, string> => ({
  pcba_a_sn: 'PA-1',
  pcba_a_hw_rev: 'V1',
  pcba_a_bom_rev: 'B1',
  pcba_a_fw_ver: '1.0.0',
  status: 'Stock',
  phase: 'Production',
  ...over,
})

describe('validateMappedRow — required fields', () => {
  it('accepts a fully-populated row and trims serial/text fields', () => {
    const row = validateMappedRow(validMapped({ pcba_a_sn: '  PA-1  ' }), 1, VALID_STATUSES, VALID_PHASES, {})
    expect(row.valid).toBe(true)
    expect(row.errors).toEqual([])
    expect(row.parsed?.pcba_a_sn).toBe('PA-1')
    expect(row.rowIndex).toBe(1)
  })

  it('flags every missing required field', () => {
    const row = validateMappedRow({}, 2, VALID_STATUSES, VALID_PHASES, {})
    expect(row.valid).toBe(false)
    expect(row.parsed).toBeUndefined()
    for (const frag of ['PCBA-A S/N', 'HW Rev', 'BOM Rev', 'FW Ver', 'Status', 'Phase']) {
      expect(row.errors.some((e) => e.includes(frag))).toBe(true)
    }
  })

  it('aggregates multiple errors instead of stopping at the first', () => {
    const row = validateMappedRow(
      validMapped({ status: '', build_date: '99/99/2023' }),
      3, VALID_STATUSES, VALID_PHASES, {},
    )
    expect(row.valid).toBe(false)
    expect(row.errors.length).toBeGreaterThanOrEqual(2)
  })
})

describe('validateMappedRow — vocabulary membership', () => {
  it('rejects a status outside the provided vocabulary', () => {
    const row = validateMappedRow(validMapped({ status: 'Bogus' }), 1, VALID_STATUSES, VALID_PHASES, {})
    expect(row.valid).toBe(false)
    expect(row.errors.some((e) => e.includes('Bogus'))).toBe(true)
  })

  it('rejects a phase outside the provided vocabulary', () => {
    const row = validateMappedRow(validMapped({ phase: 'Nope' }), 1, VALID_STATUSES, VALID_PHASES, {})
    expect(row.valid).toBe(false)
    expect(row.errors.some((e) => e.includes('Nope'))).toBe(true)
  })

  it('accepts a status/phase that IS in the vocabulary', () => {
    const row = validateMappedRow(validMapped({ status: 'In Use', phase: 'Validation' }), 1, VALID_STATUSES, VALID_PHASES, {})
    expect(row.valid).toBe(true)
    expect(row.parsed?.status).toBe('In Use')
    expect(row.parsed?.phase).toBe('Validation')
  })
})

describe('validateMappedRow — verbatim remarks', () => {
  it('preserves remarks without trimming (multiline/Chinese notes)', () => {
    const remarks = '  line1\nline2  '
    const row = validateMappedRow(validMapped({ remarks }), 1, VALID_STATUSES, VALID_PHASES, {})
    expect(row.parsed?.remarks).toBe(remarks)
  })
})

// ---------------------------------------------------------------------------
// importValidRows — dedupe pre-read + insert loop + per-row error aggregation.
// ---------------------------------------------------------------------------
const parsed = (sn: string): DeviceInput => ({
  device_sn: null, product_name: null, model_no: null,
  pcba_a_sn: sn, pcba_a_hw_rev: 'V1', pcba_a_bom_rev: 'B1', pcba_a_fw_ver: '1.0.0',
  pcba_b_sn: null, pcba_b_hw_rev: null, pcba_b_bom_rev: null, pcba_b_fw_ver: null,
  screen_model: null, hmi_ver: null, build_date: null, ship_date: null, qty: null,
  destination: null, customer: null, status: 'Stock', phase: 'Production', remarks: null,
})
const validPreview = (rowIndex: number, sn: string): ImportPreviewRow =>
  ({ rowIndex, raw: {}, valid: true, errors: [], parsed: parsed(sn) })
const invalidPreview = (rowIndex: number): ImportPreviewRow =>
  ({ rowIndex, raw: {}, valid: false, errors: ['bad'] })

beforeEach(() => {
  mockCreateDevice.mockReset().mockResolvedValue({ id: 'new-dev' })
  mockGetDeviceByPcbaSn.mockReset().mockResolvedValue(null)
})

describe('importValidRows', () => {
  it('denies a non-importer (permission error, no dedupe or insert)', async () => {
    const err = await catchErr(importValidRows([validPreview(1, 'PA-1')], 'actor-1', 'viewer'))
    expect(err).toBeInstanceOf(AppError)
    expect(err.serviceError.type).toBe('permission')
    expect(mockGetDeviceByPcbaSn).not.toHaveBeenCalled()
    expect(mockCreateDevice).not.toHaveBeenCalled()
  })

  it('imports each distinct valid row exactly once', async () => {
    const result = await importValidRows(
      [validPreview(1, 'PA-1'), validPreview(2, 'PA-2')], 'actor-1', 'engineer',
    )
    expect(result).toEqual({ imported: 2, skippedInvalid: 0, skippedDuplicate: 0, failed: [] })
    expect(mockCreateDevice).toHaveBeenCalledTimes(2)
  })

  it('counts invalid preview rows as skippedInvalid and never inserts them', async () => {
    const result = await importValidRows(
      [validPreview(1, 'PA-1'), invalidPreview(2), invalidPreview(3)], 'actor-1', 'engineer',
    )
    expect(result.imported).toBe(1)
    expect(result.skippedInvalid).toBe(2)
    expect(mockCreateDevice).toHaveBeenCalledTimes(1)
  })

  it('skips a row whose serial already exists in the DB (skippedDuplicate)', async () => {
    mockGetDeviceByPcbaSn.mockResolvedValueOnce({ id: 'existing' })
    const result = await importValidRows([validPreview(1, 'PA-1')], 'actor-1', 'engineer')
    expect(result.imported).toBe(0)
    expect(result.skippedDuplicate).toBe(1)
    expect(mockCreateDevice).not.toHaveBeenCalled()
  })

  it('skips a within-batch duplicate serial without a second DB dedupe read', async () => {
    const result = await importValidRows(
      [validPreview(1, 'PA-1'), validPreview(2, 'PA-1')], 'actor-1', 'engineer',
    )
    expect(result.imported).toBe(1)
    expect(result.skippedDuplicate).toBe(1)
    expect(mockGetDeviceByPcbaSn).toHaveBeenCalledTimes(1) // second row short-circuits before the DB read
    expect(mockCreateDevice).toHaveBeenCalledTimes(1)
  })

  it('collects a per-row insert failure in `failed` and continues the batch', async () => {
    mockCreateDevice
      .mockRejectedValueOnce(new Error('insert exploded'))  // row 1 fails
      .mockResolvedValueOnce({ id: 'ok' })                  // row 2 succeeds
    const result = await importValidRows(
      [validPreview(1, 'PA-1'), validPreview(2, 'PA-2')], 'actor-1', 'engineer',
    )
    expect(result.imported).toBe(1)
    expect(result.failed).toHaveLength(1)
    expect(result.failed[0].rowIndex).toBe(1)
    expect(result.failed[0].error).toContain('insert exploded')
  })
})
