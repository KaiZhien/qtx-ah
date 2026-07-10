/**
 * Status transition domain module (§5.1.1).
 *
 * Status codes from seed.sql status_option table (the ONLY valid vocabulary):
 *   'Stock'   → label "In Stock"
 *   'In Use'  → label "In Use"
 *   'Repair'  → label "Under Repair"
 *   'Retired' → label "Retired"   (terminal)
 *   'Lost'    → label "Lost"      (terminal)
 *
 * This module uses the DB codes (not labels) as keys and values. Both the keys
 * and the transition targets are constrained to the codes above — there are no
 * 'Shipped' or 'In Production' codes in the vocabulary, so they are not valid
 * transition endpoints.
 *
 * Transition graph:
 *   Stock   → In Use, Repair, Lost, Retired
 *   In Use  → Repair, Retired, Lost
 *   Repair  → In Use, Retired, Lost
 *   Retired → (none — terminal)
 *   Lost    → (none — terminal)
 */

/**
 * Allowed next status codes FROM each status code.
 * Terminal statuses map to an empty array.
 * Keys and values use the exact DB codes from seed.sql (status_option).
 */
export const TRANSITIONS: Record<string, string[]> = {
  // 'Stock' = "In Stock"
  'Stock':   ['In Use', 'Repair', 'Lost', 'Retired'],
  // 'In Use' = "In Use"
  'In Use':  ['Repair', 'Retired', 'Lost'],
  // 'Repair' = "Under Repair"
  'Repair':  ['In Use', 'Retired', 'Lost'],
  // Terminal statuses — no onward transitions
  'Retired': [],
  'Lost':    [],
}

/**
 * Returns true if the transition from → to is permitted.
 * Fails closed: an unknown source status code has no allowed transitions,
 * so it returns false rather than silently permitting any change.
 */
export function isValidTransition(from: string, to: string): boolean {
  if (!(from in TRANSITIONS)) {
    // Unknown source status — fail closed (no allowed transitions)
    return false
  }
  return TRANSITIONS[from].includes(to)
}

/**
 * Returns the list of allowed next status codes from the given status.
 * Fails closed: an unknown source status (e.g. a newly admin-added vocabulary
 * code not yet wired into TRANSITIONS) returns [] rather than offering every
 * option. This keeps the UI in lock-step with isValidTransition's server-side
 * enforcement — a status the server will reject is never presented as choosable.
 * Terminal statuses (Retired, Lost) return [] for the same reason.
 */
export function allowedNextStatuses(from: string): string[] {
  if (!(from in TRANSITIONS)) {
    return []
  }
  return [...TRANSITIONS[from]]
}
