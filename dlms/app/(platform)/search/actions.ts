'use server'

import { requireAal2Actor, MfaRequiredError, UnauthenticatedError }
  from '@/modules/shared/auth/session'
import { PermissionError } from '@/modules/shared/authz/authorize'
import { globalSearch, type SearchResult } from '@/modules/shared/search/services/searchService'

export type SearchActionResult =
  | { ok: true; result: SearchResult }
  | { ok: false; error: string }

/**
 * Maps a thrown error to something a user can read, and NOTHING ELSE.
 *
 * A search box is reachable from every page by every signed-in user, so it is the
 * broadest attack surface in the app for error-message disclosure: the message
 * must never reveal which table failed or that a group exists at all.
 */
function toMessage(err: unknown): string {
  if (err instanceof MfaRequiredError) {
    return 'Two-factor authentication is required. Reload the page and complete it.'
  }
  if (err instanceof UnauthenticatedError) return 'Your session has expired. Sign in again.'
  // A PermissionError here would be a BUG, not a denial: globalSearch filters
  // groups by permission and never queries a denied one. Answered generically so
  // that bug can never become a disclosure.
  if (err instanceof PermissionError) return 'Search is not available for your account.'
  console.error(JSON.stringify({
    level: 'error', msg: 'globalSearch failed',
    err: err instanceof Error ? err.message : String(err),
  }))
  return 'Search is temporarily unavailable.'
}

/**
 * The ⌘K palette's data source (spec §8.4).
 *
 * A server ACTION rather than a route handler: `app/api/**` belongs to another
 * module, and an action already carries the session, so the palette needs no
 * separate auth path. The guard is INSIDE the try, per the house convention that
 * `__tests__/actionAalPinning.test.ts` pins — an MfaRequiredError thrown from the
 * gate has to become a message, not an unhandled server-action rejection.
 */
export async function searchAction(query: string): Promise<SearchActionResult> {
  try {
    const actor = await requireAal2Actor()
    const result = await globalSearch(actor, { q: query })
    return { ok: true, result }
  } catch (err) {
    return { ok: false, error: toMessage(err) }
  }
}
