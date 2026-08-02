import { createHash } from 'node:crypto'
import type { Actor } from '@/modules/shared/authz/catalog'

/** Spec §8.5: "direct indexed queries with 60 s server cache". */
export const DASHBOARD_REVALIDATE_SECONDS = 60

/**
 * ── LOOKS DELETABLE, IS LOAD-BEARING ────────────────────────────────────────
 *
 * Every part of this key is what stops one user's dashboard being served to
 * another. `unstable_cache` keys ONLY on the parts handed to it; the widget
 * functions close over their `actor` and take no arguments, so nothing else
 * disambiguates two calls. Drop `actorScopeDigest` and the key still "works" —
 * caches hit more often, every test still passes, and a Finance manager's unpaid
 * invoices are served to the next operator who opens the dashboard inside the
 * 60-second window. This is a cross-tenant read, not a stale number.
 *
 * The key has TWO independent components and needs both:
 *
 *   actor.id      — the per-user widgets ("my tasks", "my approvals pending",
 *                   "recent activity on MY records") return different rows for
 *                   two users with identical permissions.
 *
 *   scope digest  — role + permissions + module access + active. The id alone
 *                   would isolate users correctly but pin a REVOKED permission
 *                   for up to 60 seconds: an admin removing someone's Finance
 *                   access expects it to take effect now, not next minute. Folding
 *                   the grants into the key makes any change to them a different
 *                   cache entry, so a revoke is effective on the next request.
 *
 * Returned as an ARRAY of parts, never a concatenated string: 'ab' + 'c' and
 * 'a' + 'bc' are the same string but different actors.
 */
export function dashboardCacheKey(actor: Actor, widgetKey: string): string[] {
  return ['dashboard', widgetKey, actor.id, actorScopeDigest(actor)]
}

/**
 * A stable, order-insensitive fingerprint of everything `can()` reads.
 *
 * Sets have insertion order; two actors granted the same permissions in a
 * different order are the same scope and must share a cache entry, so both lists
 * are sorted before hashing. Fields are joined with a separator that cannot occur
 * inside a permission or module key, so a permission can never masquerade as a
 * module (which would let two genuinely different scopes collide).
 *
 * Hashed rather than inlined because cache keys reach filenames and logs: the raw
 * list is long, and printing a user's full grant set into a log line is a
 * disclosure the key does not need to make.
 */
export function actorScopeDigest(actor: Actor): string {
  const canonical = [
    `role=${actor.roleKey}`,
    `active=${actor.active}`,
    `perms=${[...actor.permissions].sort().join(',')}`,
    `modules=${[...actor.moduleAccess].sort().join(',')}`,
  ].join('|')
  return createHash('sha256').update(canonical).digest('hex').slice(0, 32)
}
