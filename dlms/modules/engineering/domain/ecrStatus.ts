import { canTransition, isTerminal, nextStates, type TransitionGraph } from './transition'

/**
 * ECR (Engineering Change Request) status flow — the simple basic-scope version
 * (spec §6.3 collapses ECR/ECO into one `eng_change` with a richer graph; this
 * module implements the deliberately smaller draft → submitted → accepted /
 * rejected flow the Engineering-basic task specifies).
 */
export type EcrStatus = 'draft' | 'submitted' | 'accepted' | 'rejected'

export const ECR_STATUSES = ['draft', 'submitted', 'accepted', 'rejected'] as const
export const ECR_INITIAL_STATUS: EcrStatus = 'draft'

// draft → submitted → accepted | rejected  (accepted & rejected are terminal)
export const ECR_TRANSITIONS: TransitionGraph = {
  draft: ['submitted'],
  submitted: ['accepted', 'rejected'],
  accepted: [],
  rejected: [],
}

export function isValidEcrTransition(from: string, to: string): boolean {
  return canTransition(ECR_TRANSITIONS, from, to)
}

export function nextEcrStatuses(from: string): EcrStatus[] {
  return nextStates(ECR_TRANSITIONS, from) as EcrStatus[]
}

export function isTerminalEcrStatus(status: string): boolean {
  return isTerminal(ECR_TRANSITIONS, status)
}
