import { can } from '@/modules/shared/authz/policy'
import type { Actor, ModuleKey, Permission } from '@/modules/shared/authz/catalog'
import type { SearchFamily } from './searchQuery'

/**
 * The groups global search can return, and the gate each one carries (spec §8.4).
 *
 * THE GATE IS THE FEATURE. "Every group permission-filtered server-side" is not a
 * presentation rule — a user without Finance access must not learn that an
 * invoice number EXISTS. That is why `visibleSearchGroups` OMITS a denied group
 * rather than returning it empty: an empty-but-present "Invoices" heading tells
 * the reader there is a Finance module they are being kept out of, and a
 * zero-result group is indistinguishable from a real zero-result search, so the
 * two answers cannot be told apart by a user but CAN be by an attacker timing
 * them. The service never runs a denied group's query at all.
 *
 * Each gate is transcribed from the module's own read service so search can never
 * be a softer door than the page it links to:
 *   devices/components  → deviceReadService      authorize(view_records, manufacturing)
 *   buyers/invoices     → buyerService/invoiceService  authorize(view_finance, finance)
 *   deliveryOrders      → deliveryOrderService    authorize(view_records, logistics)
 *   repairs/mods        → repairService/modificationService authorize(view_records, maintenance)
 *   ecrs/ecos           → engineeringReadService  authorize(view_records, engineering)
 *   tasks               → taskService             authorize(view_records, tasks)
 *   users               → spec §8.4 "user names (admin)"; matches the admin console's
 *                         manage_users gate, not bare admin module access
 *
 * Tasks carry a SECOND gate the registry cannot express: the two-gate visibility
 * rule (confidential + link-derived module access, spec §8.3). It is row-level, so
 * it is applied per row by `canSeeTask` in the service — this gate only decides
 * whether the task query runs at all.
 */
export type SearchGroupKey =
  | 'devices' | 'components' | 'buyers' | 'invoices' | 'deliveryOrders'
  | 'repairs' | 'modifications' | 'ecrs' | 'ecos' | 'tasks' | 'users'

export type SearchGroupDef = {
  key: SearchGroupKey
  label: string
  /** The permission the module's own read service demands. */
  permission: Permission
  module: ModuleKey
  /** Which normalization/index family this group's searchable column belongs to. */
  family: SearchFamily
  sort: number
}

export const SEARCH_GROUPS: readonly SearchGroupDef[] = [
  { key: 'devices', label: 'Devices', permission: 'view_records', module: 'manufacturing',
    family: 'ref', sort: 1 },
  { key: 'components', label: 'Components', permission: 'view_records', module: 'manufacturing',
    family: 'ref', sort: 2 },
  { key: 'repairs', label: 'Repairs', permission: 'view_records', module: 'maintenance',
    family: 'ref', sort: 3 },
  { key: 'modifications', label: 'Modifications', permission: 'view_records', module: 'maintenance',
    family: 'ref', sort: 4 },
  { key: 'ecrs', label: 'Change requests', permission: 'view_records', module: 'engineering',
    family: 'ref', sort: 5 },
  { key: 'ecos', label: 'Change orders', permission: 'view_records', module: 'engineering',
    family: 'ref', sort: 6 },
  { key: 'invoices', label: 'Invoices', permission: 'view_finance', module: 'finance',
    family: 'ref', sort: 7 },
  { key: 'buyers', label: 'Buyers', permission: 'view_finance', module: 'finance',
    family: 'name', sort: 8 },
  { key: 'deliveryOrders', label: 'Delivery orders', permission: 'view_records',
    module: 'logistics', family: 'ref', sort: 9 },
  { key: 'tasks', label: 'Tasks', permission: 'view_records', module: 'tasks',
    family: 'name', sort: 10 },
  { key: 'users', label: 'People', permission: 'manage_users', module: 'admin',
    family: 'name', sort: 11 },
]

export function searchGroupKeys(): SearchGroupKey[] {
  return SEARCH_GROUPS.map((g) => g.key)
}

/**
 * Pure: the groups this actor may search, in registry order.
 *
 * `can()` handles the three cases that matter — a deactivated actor gets nothing,
 * a super_admin bypasses the module gate but NOT the permission set, and everyone
 * else needs both.
 */
export function visibleSearchGroups(actor: Actor): SearchGroupDef[] {
  return SEARCH_GROUPS
    .filter((g) => can(actor, g.permission, g.module))
    .sort((a, b) => a.sort - b.sort)
}
