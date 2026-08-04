import type { SearchGroupKey } from './searchGroups'
import { MIN_QUERY_LENGTH } from './searchQuery'

/**
 * Where each search group's hit points.
 *
 * ENUMERATED, NOT DERIVED, for the reason approvalRecordHref documents: the
 * `${moduleHref}/${entityType}s/{id}` convention in components/tasks/entityHref.ts
 * is a best-effort fallback and it is WRONG for three of these routes —
 * `/logistics/delivery-orders` is hyphenated, `/engineering/ecr` and
 * `/engineering/eco` are singular. A palette whose "open the record" link
 * dead-ends is worse than one with no link, because a 404 reads as "the record
 * was deleted" rather than "this app has a routing bug".
 *
 * Verified against app/(platform)/ as it stands on `main`.
 */
const SEARCH_ROUTES: Partial<Record<SearchGroupKey, string>> = {
  devices: '/manufacturing/devices',
  repairs: '/maintenance/repairs',
  invoices: '/finance/invoices',
  buyers: '/finance/buyers',
  deliveryOrders: '/logistics/delivery-orders',
  ecrs: '/engineering/ecr',
  ecos: '/engineering/eco',
  // Confirmed with agent ENGINEERING: /engineering/failures and .../[id].
  failures: '/engineering/failures',
  tasks: '/tasks',
  // Confirmed with agent MAINTENANCE: their modification UI ships at
  // /maintenance/modifications/[id] (plus a list and a /new route).
  modifications: '/maintenance/modifications',
}

/**
 * Groups that are searchable but have no detail page to open, each for a reason:
 *
 *   components — component units are shown on the owning device's Components tab;
 *                there is no per-unit route, by design rather than by omission.
 *   users      — people are administered through /admin/users, which is a console
 *                keyed by search, not a per-user page.
 *
 * A hit in one of these groups still earns its place: it confirms the record
 * exists and shows its context (component type, email), which is most of what a
 * `⌘K` lookup is for. The UI renders it as plain text rather than a broken link.
 *
 * `modifications` was in this set until agent MAINTENANCE confirmed the route;
 * it now resolves normally. The "every group is DECIDED" test is what keeps this
 * set and SEARCH_ROUTES from drifting apart — a group in neither fails it.
 */
export const UNROUTED_GROUPS: ReadonlySet<SearchGroupKey> = new Set<SearchGroupKey>([
  'components', 'users',
])

/** null when this group has no detail route — the caller renders plain text. */
export function searchHref(group: SearchGroupKey, id: string): string | null {
  const base = SEARCH_ROUTES[group]
  return base ? `${base}/${id}` : null
}

/**
 * The full results page for a query — the link that keeps `/search` from being
 * an orphan.
 *
 * `/search` shipped with NOTHING pointing at it: no nav entry, and the palette
 * only ever pushed a hit's own href. It was reachable exclusively by someone
 * typing the URL, which is close to not having shipped it at all.
 *
 * WHAT THE PAGE IS ACTUALLY FOR, because the obvious label would be a lie. Both
 * surfaces call the same `globalSearch` with the same `PER_GROUP_LIMIT`, so the
 * page does NOT show more results than the palette — calling this "see all
 * results" would promise rows that do not exist. What the page has that a
 * transient overlay cannot is a URL: it survives navigation, it can be
 * bookmarked, and it can be sent to a colleague (whose own permissions are
 * re-applied server-side, which is why sharing one is safe). The palette's label
 * says that instead.
 *
 * Returns null below MIN_QUERY_LENGTH, so the caller never offers a link to a
 * page that can only answer "enter at least 2 characters" — the same "do not
 * offer what the destination refuses" rule the rest of the app follows.
 */
export function searchResultsPageHref(rawQuery: string): string | null {
  const q = rawQuery.trim()
  if (q.length < MIN_QUERY_LENGTH) return null
  // encodeURIComponent, not a template literal: an unencoded `&` or `=` in the
  // query would arrive as a SECOND `q` parameter, and which one the page reads
  // is then the framework's choice rather than ours.
  return `/search?q=${encodeURIComponent(q)}`
}
