import { describe, it, expect } from 'vitest'
import { mapStatus, mapDeviceRow } from '@/scripts/migrate_demo'

const VARIANTS = { basic: 'variant-basic-uuid', pro: 'variant-pro-uuid' }
const ACTOR = 'actor-uuid'

const legacy = (over = {}) => ({
  id: 'device-uuid-1',
  device_sn: 'QTX-P-00412',
  pcba_a_sn: 'EE-02A-2603-0042',
  product_name: 'AH Pro',
  model_no: 'AH-2',
  status: 'In Stock',
  phase: 'Production',
  customer: '客户 A',
  destination: 'Singapore',
  remarks: '电源板已更换\nSecond line preserved',
  build_date: new Date('2026-03-01'),
  ship_date: null,
  created_at: new Date('2026-03-02'),
  ...over,
})

describe('mapStatus — the three production codes map 1:1 (spec §15)', () => {
  it('maps the live codes', () => {
    expect(mapStatus('In Stock')).toBe('in_stock')
    expect(mapStatus('Under Repair')).toBe('under_repair')
    expect(mapStatus('Shipped')).toBe('shipped')
  })

  it('maps the seeded codes that drifted out of use', () => {
    expect(mapStatus('Stock')).toBe('in_stock')
    expect(mapStatus('Repair')).toBe('under_repair')
  })

  it('throws on an unknown status rather than guessing', () => {
    expect(() => mapStatus('Teleported')).toThrow(/unknown legacy status/i)
  })
})

describe('mapDeviceRow', () => {
  it('preserves the device UUID verbatim — audit rows depend on it', () => {
    expect(mapDeviceRow(legacy(), VARIANTS, ACTOR).id).toBe('device-uuid-1')
  })

  it('preserves bilingual free text exactly, including newlines', () => {
    const out = mapDeviceRow(legacy(), VARIANTS, ACTOR)
    expect(out.remarks).toBe('电源板已更换\nSecond line preserved')
    expect(out.customer).toBe('客户 A')
  })

  it('derives the Pro variant from the product name', () => {
    expect(mapDeviceRow(legacy(), VARIANTS, ACTOR).variant_id).toBe('variant-pro-uuid')
  })

  it('defaults to Basic when the product name says nothing', () => {
    expect(mapDeviceRow(legacy({ product_name: 'AH' }), VARIANTS, ACTOR).variant_id)
      .toBe('variant-basic-uuid')
  })

  it('carries a ranged legacy serial verbatim and flags it for review, never splitting it', () => {
    const out = mapDeviceRow(
      legacy({ device_sn: null, pcba_a_sn: 'EE-02A-2603-0001 to 0015' }), VARIANTS, ACTOR)
    expect(out.pcba_a_sn_legacy).toBe('EE-02A-2603-0001 to 0015')
    expect(out.needs_data_review).toBe(true)
    expect(out.device_sn).toBeNull()
  })

  it('flags a device with no serial of any kind', () => {
    const out = mapDeviceRow(legacy({ device_sn: null, pcba_a_sn: '' }), VARIANTS, ACTOR)
    expect(out.needs_data_review).toBe(true)
  })

  it('does NOT flag a clean single-serial row', () => {
    expect(mapDeviceRow(legacy(), VARIANTS, ACTOR).needs_data_review).toBe(false)
  })

  it('normalizes the serial for search without altering the stored value', () => {
    const out = mapDeviceRow(legacy(), VARIANTS, ACTOR)
    expect(out.device_sn).toBe('QTX-P-00412')
    expect(out.device_sn_normalized).toBe('qtxp00412')
  })
})
