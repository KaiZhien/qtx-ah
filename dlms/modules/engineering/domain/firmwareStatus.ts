import { canTransition, isTerminal, nextStates, type TransitionGraph } from './transition'

/**
 * Firmware release status flow: draft → released → withdrawn. A build is drafted
 * in the registry, published (released), and can later be pulled (withdrawn);
 * there is no un-withdraw (withdrawn is terminal — cut a new version instead).
 */
export type FirmwareStatus = 'draft' | 'released' | 'withdrawn'

export const FIRMWARE_STATUSES = ['draft', 'released', 'withdrawn'] as const
export const FIRMWARE_INITIAL_STATUS: FirmwareStatus = 'draft'

export const FIRMWARE_TRANSITIONS: TransitionGraph = {
  draft: ['released'],
  released: ['withdrawn'],
  withdrawn: [],
}

export function isValidFirmwareTransition(from: string, to: string): boolean {
  return canTransition(FIRMWARE_TRANSITIONS, from, to)
}

export function nextFirmwareStatuses(from: string): FirmwareStatus[] {
  return nextStates(FIRMWARE_TRANSITIONS, from) as FirmwareStatus[]
}

export function isTerminalFirmwareStatus(status: string): boolean {
  return isTerminal(FIRMWARE_TRANSITIONS, status)
}
