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
  tasks: '/tasks',
}

/**
 * Groups that are searchable but have no detail page to open, each for a reason:
 *
 *   modifications — the `modification` table, service and domain shipped with MA2,
 *                   but "there is no modification UI page yet" (PROGRESS). Agent
 *                   MAINTENANCE is building it. When `/maintenance/modifications/
 *                   [id]` exists, add it above and delete it from this set — the
 *                   test that every group is DECIDED will keep the two in step.
 *   components    — component units are shown on the owning device's Components
 *                   tab; there is no per-unit route by design.
 *   users         — people are administered through /admin/users, which is a
 *                   console, not a per-user page.
 *
 * A hit in one of these groups still earns its place: it confirms the record
 * exists and shows its context (device serial, status), which is most of what a
 * `⌘K` lookup is for. The UI renders it as plain text rather than a broken link.
 */
export const UNROUTED_GROUPS: ReadonlySet<SearchGroupKey> = new Set<SearchGroupKey>([
  'components', 'modifications', 'users',
])

/** null when this group has no detail route — the caller renders plain text. */
export function searchHref(group: SearchGroupKey, id: string): string | null {
  const base = SEARCH_ROUTES[group]
  return base ? `${base}/${id}` : null
}
