/**
 * Status transition domain module (§5.1.1).
 *
 * The allowed transitions are COMPUTED from per-status flags on the live
 * status_option vocabulary, not a hardcoded graph — so admin-added statuses are
 * usable endpoints without a code change. Two flags drive the rule:
 *
 *   is_terminal — a transition sink: no onward transitions (device is done).
 *   is_initial  — creation-only: nothing transitions INTO it.
 *
 * Rule: from a non-terminal, known source you may move to any status that is
 * active, non-initial, and not the source itself. Anything unknown (source not
 * in the list, empty vocabulary) fails closed. With the seeded flags
 * (Retired/Lost terminal, Stock initial) this reproduces the legacy 5-code graph
 * membership exactly.
 *
 * Structural type: StatusOption (post-regen) satisfies TransitionStatus, so this
 * module stays client/server-agnostic and takes no dependency on the DB layer.
 */
export type TransitionStatus = {
  code: string
  active: boolean
  is_terminal: boolean
  is_initial: boolean
}

/**
 * Returns the list of allowed next status codes from the given status, in the
 * order the `statuses` list is supplied (callers pass it sort_order-ordered).
 * Fails closed: an unknown or terminal source returns [] rather than offering
 * every option, keeping the UI in lock-step with isValidTransition's server-side
 * enforcement — a status the server will reject is never presented as choosable.
 */
export function allowedNextStatuses(from: string, statuses: TransitionStatus[]): string[] {
  const src = statuses.find((s) => s.code === from)
  if (!src || src.is_terminal) return []   // unknown or terminal → fail closed
  return statuses
    .filter((t) => t.active && !t.is_initial && t.code !== from)
    .map((t) => t.code)
}

/**
 * Returns true if the transition from → to is permitted against the live
 * vocabulary. `from` may be inactive (a device can leave a deactivated status);
 * `to` must be active, non-initial, and ≠ from. Unknown anything fails closed.
 */
export function isValidTransition(from: string, to: string, statuses: TransitionStatus[]): boolean {
  return allowedNextStatuses(from, statuses).includes(to)
}
