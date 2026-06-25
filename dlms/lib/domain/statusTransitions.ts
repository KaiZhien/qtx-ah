/**
 * Status transition domain module (§5.1.1).
 *
 * Status codes from seed.sql status_option table:
 *   'Stock'   → label "In Stock"
 *   'In Use'  → label "In Use"
 *   'Repair'  → label "Under Repair"
 *   'Retired' → label "Retired"
 *   'Lost'    → label "Lost"
 *
 * Additional transition targets (not in seed but referenced in domain):
 *   'Shipped', 'In Production'
 *
 * This module uses the DB codes (not labels) as keys and values.
 */

/**
 * Allowed next status codes FROM each status code.
 * Terminal statuses map to an empty array.
 * Keys use the exact DB codes from seed.sql.
 */
export const TRANSITIONS: Record<string, string[]> = {
  // Seed code 'Stock' = "In Stock"
  'Stock':         ['In Use', 'Repair', 'Lost', 'Retired', 'Shipped'],
  // Seed code 'In Use' = "In Use"
  'In Use':        ['Repair', 'Retired', 'Lost', 'Shipped'],
  // Seed code 'Repair' = "Under Repair"
  'Repair':        ['In Use', 'Retired', 'Lost'],
  // Terminal statuses
  'Retired':       [],
  'Lost':          [],
  // Extended statuses
  'Shipped':       ['In Use', 'Retired'],
  'In Production': ['Stock', 'Shipped', 'Retired'],
}

/** All known status codes in this domain */
const ALL_KNOWN_STATUSES = Object.keys(TRANSITIONS)

/**
 * Returns true if the transition from → to is permitted.
 * Also returns true if `from` is an unknown status code,
 * so devices with unrecognised statuses are never blocked.
 */
export function isValidTransition(from: string, to: string): boolean {
  if (!(from in TRANSITIONS)) {
    // Unknown source status — allow any transition to avoid blocking
    return true
  }
  return TRANSITIONS[from].includes(to)
}

/**
 * Returns the list of allowed next status codes from the given status.
 * If `from` is unknown, returns all known statuses (permissive fallback).
 */
export function allowedNextStatuses(from: string): string[] {
  if (!(from in TRANSITIONS)) {
    return [...ALL_KNOWN_STATUSES]
  }
  return [...TRANSITIONS[from]]
}
