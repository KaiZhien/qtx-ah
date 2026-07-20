// __tests__/engineering/firmwareStatus.test.ts
import { describe, it, expect } from 'vitest'
import {
  FIRMWARE_STATUSES, FIRMWARE_INITIAL_STATUS, isValidFirmwareTransition,
  nextFirmwareStatuses, isTerminalFirmwareStatus,
} from '@/modules/engineering/domain/firmwareStatus'

describe('firmware release status vocabulary', () => {
  it('is draft → released → withdrawn', () => {
    expect(FIRMWARE_STATUSES).toEqual(['draft', 'released', 'withdrawn'])
  })
  it('starts at draft', () => {
    expect(FIRMWARE_INITIAL_STATUS).toBe('draft')
  })
})

describe('isValidFirmwareTransition', () => {
  it('allows draft → released and released → withdrawn', () => {
    expect(isValidFirmwareTransition('draft', 'released')).toBe(true)
    expect(isValidFirmwareTransition('released', 'withdrawn')).toBe(true)
  })
  it('forbids withdrawing a draft directly', () => {
    expect(isValidFirmwareTransition('draft', 'withdrawn')).toBe(false)
  })
  it('forbids re-releasing a withdrawn build', () => {
    expect(isValidFirmwareTransition('withdrawn', 'released')).toBe(false)
  })
  it('fails closed on unknown statuses', () => {
    expect(isValidFirmwareTransition('bogus', 'released')).toBe(false)
    expect(isValidFirmwareTransition('draft', 'bogus')).toBe(false)
  })
})

describe('nextFirmwareStatuses / isTerminalFirmwareStatus', () => {
  it('lists onward moves', () => {
    expect(nextFirmwareStatuses('draft')).toEqual(['released'])
    expect(nextFirmwareStatuses('released')).toEqual(['withdrawn'])
  })
  it('marks withdrawn terminal', () => {
    expect(isTerminalFirmwareStatus('withdrawn')).toBe(true)
    expect(isTerminalFirmwareStatus('released')).toBe(false)
  })
})
