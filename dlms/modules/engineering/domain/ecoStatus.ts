import { canTransition, isTerminal, nextStates, type TransitionGraph } from './transition'

/**
 * ECO (Engineering Change Order) status flow: draft → submitted → approved →
 * implemented, with rejected as an alternate terminal out of submitted.
 *
 * The single approval gate in this module is the `submitted → approved` step:
 * ecoTransitionRequiresApproval marks it so the write service can demand the
 * approve_requests permission for that move alone (spec §3.2 / BR-4). Every
 * other move only needs edit_records.
 */
export type EcoStatus = 'draft' | 'submitted' | 'approved' | 'implemented' | 'rejected'

export const ECO_STATUSES = ['draft', 'submitted', 'approved', 'implemented', 'rejected'] as const
export const ECO_INITIAL_STATUS: EcoStatus = 'draft'
/** The one target that requires approve_requests to reach. */
export const ECO_APPROVE_STATUS: EcoStatus = 'approved'

export const ECO_TRANSITIONS: TransitionGraph = {
  draft: ['submitted'],
  submitted: ['approved', 'rejected'],
  approved: ['implemented'],
  implemented: [],
  rejected: [],
}

export function isValidEcoTransition(from: string, to: string): boolean {
  return canTransition(ECO_TRANSITIONS, from, to)
}

export function nextEcoStatuses(from: string): EcoStatus[] {
  return nextStates(ECO_TRANSITIONS, from) as EcoStatus[]
}

export function isTerminalEcoStatus(status: string): boolean {
  return isTerminal(ECO_TRANSITIONS, status)
}

/** True for the approve step (→ approved), which is gated by approve_requests. */
export function ecoTransitionRequiresApproval(to: string): boolean {
  return to === ECO_APPROVE_STATUS
}
