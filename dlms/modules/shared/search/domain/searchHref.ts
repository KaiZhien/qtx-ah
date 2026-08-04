import type { SearchGroupKey } from './searchGroups'

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
