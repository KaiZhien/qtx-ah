/**
 * Pure decision logic for a device status change (spec §5.2). No I/O — the
 * service loads the three facts from status_transition / status_option and
 * hands them here. Mirrors componentInstallation.assertReplacementShape:
 * impossible/forbidden moves are decided before any DB write.
 *
 * The graph itself is the status_transition TABLE (fail-closed: no row =
 * forbidden). This function does NOT know the graph; it only interprets the
 * facts a single candidate move produced.
 */
export type StatusChangeErrorCode = 'transition_forbidden' | 'reason_required'

export type StatusChangeFacts = {
  /** A row (from_status, to_status) exists in status_transition. */
  transitionExists: boolean
  /** That row's requires_reason flag. */
  requiresReason: boolean
  /** The target status_option.is_terminal (retired/scrapped). */
  toIsTerminal: boolean
}

export type StatusChangeDecision =
  | { ok: false; error: StatusChangeErrorCode }
  | { ok: true; requiresDeletePermission: boolean }

export function evaluateStatusChange(
  facts: StatusChangeFacts,
  input: { reason: string | null },
): StatusChangeDecision {
  if (!facts.transitionExists) return { ok: false, error: 'transition_forbidden' }
  if (facts.requiresReason && !input.reason?.trim()) return { ok: false, error: 'reason_required' }
  return { ok: true, requiresDeletePermission: facts.toIsTerminal }
}

export class InvalidStatusChangeError extends Error {
  readonly code: StatusChangeErrorCode
  constructor(code: StatusChangeErrorCode, message: string) {
    super(message)
    this.name = 'InvalidStatusChangeError'
    this.code = code
  }
}

export function messageForStatusChangeError(
  code: StatusChangeErrorCode, fromLabel: string, toLabel: string,
): string {
  return code === 'transition_forbidden'
    ? `Cannot move a device from "${fromLabel}" to "${toLabel}".`
    : `Moving from "${fromLabel}" to "${toLabel}" requires a reason.`
}
